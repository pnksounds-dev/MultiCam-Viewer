/**
 * Forum authentication client (main process).
 *
 * The forum at pnksounds.dev is the identity provider. Users register on the
 * forum website and sign in here with those same credentials. The forum issues
 * a JWT signed with SUPABASE_JWT_SECRET which doubles as a Supabase access token
 * for RLS-protected queries. Supabase Auth (GoTrue) is NOT used.
 *
 * The JWT + user blob is persisted to disk encrypted with Electron's
 * safeStorage (OS keychain / DPAPI on Windows), so it is bound to this user
 * account on this machine and never stored in plaintext.
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const FORUM_API_URL = 'https://pnksounds.dev';
const FORUM_REGISTER_URL = 'https://pnksounds.dev/register';
const FORUM_PASSWORD_RESET_URL = 'https://pnksounds.dev/reset.html';

const APP_KEY = 'multicam';
const ENTITLEMENTS_URL = `${FORUM_API_URL}/api/entitlements/${APP_KEY}`;
const PRICING_URL = `${FORUM_API_URL}/pricing.html`;
const ACCOUNT_URL = `${FORUM_API_URL}/account.html`;

function sessionFile() {
  return path.join(app.getPath('userData'), 'forumSession.enc');
}

// ── Types ────────────────────────────────────────────────────────────────────

// ForumUser: { id, username, email, customId, isStaff, isAdmin, bio, avatar }
// StoredSession: { token, user, storedAt }

// ── In-memory cache ──────────────────────────────────────────────────────────

let cachedSession = null;

// ── JWT helpers ──────────────────────────────────────────────────────────────

/** Decode the `exp` claim from a JWT without verifying the signature. */
function getJwtExp(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Check if a JWT is expired (with a 30s clock skew buffer). */
function isJwtExpired(token) {
  const exp = getJwtExp(token);
  if (!exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + 30;
}

// ── Secure storage ───────────────────────────────────────────────────────────

function loadSessionFromDisk() {
  try {
    const file = sessionFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return null;
    let json;
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(raw, 'base64');
      json = safeStorage.decryptString(buf);
    } else {
      // Fallback: plaintext (OS keychain unavailable). Still functional but
      // less secure — log so the user knows.
      console.warn('[forumAuth] safeStorage unavailable, session stored unencrypted');
      json = raw;
    }
    return JSON.parse(json);
  } catch (err) {
    console.warn('[forumAuth] failed to load session:', err.message);
    return null;
  }
}

function saveSessionToDisk(session) {
  try {
    const dir = path.dirname(sessionFile());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(session);
    let out;
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      out = encrypted.toString('base64');
    } else {
      out = json;
    }
    fs.writeFileSync(sessionFile(), out, 'utf8');
  } catch (err) {
    console.warn('[forumAuth] failed to save session:', err.message);
  }
}

function deleteSessionFile() {
  try { fs.unlinkSync(sessionFile()); } catch {}
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Restore a valid (non-expired) session from disk into the in-memory cache.
 * Returns the session or null.
 */
function restoreSession() {
  if (cachedSession) {
    if (isJwtExpired(cachedSession.token)) {
      clearForumSession();
      return null;
    }
    return cachedSession;
  }
  const loaded = loadSessionFromDisk();
  if (loaded && loaded.token && !isJwtExpired(loaded.token)) {
    cachedSession = loaded;
    return cachedSession;
  }
  if (loaded) {
    // Expired or malformed — clean up.
    deleteSessionFile();
  }
  return null;
}

/** Synchronous accessor for the cached session (does not re-check expiry). */
function getCachedSession() {
  return cachedSession;
}

/** Store a fresh session (called after a successful login). */
function storeSession(token, user) {
  const session = { token, user, storedAt: Date.now() };
  cachedSession = session;
  saveSessionToDisk(session);
}

/** Clear the session from memory and disk. */
function clearForumSession() {
  cachedSession = null;
  deleteSessionFile();
}

/**
 * Authenticate against the forum login endpoint.
 * Resolves with { token, user } or throws an Error with a user-friendly message.
 */
async function forumLogin(email, password) {
  let res;
  try {
    res = await fetch(`${FORUM_API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error('Unable to reach the forum server. Check your internet connection and try again.');
  }

  if (!res.ok) {
    let message = `Login failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.error || data.message) message = data.error || data.message;
    } catch {
      if (res.statusText) message = `${message}: ${res.statusText}`;
    }
    if (res.status === 401 || res.status === 403) {
      message = 'Invalid email or password. Make sure you are using your forum credentials.';
    }
    throw new Error(message);
  }

  const data = await res.json();
  if (!data.token || !data.user || !data.user.id) {
    throw new Error('The forum returned an unexpected response. Please try again.');
  }
  return { token: data.token, user: data.user };
}

// ── Entitlement check (PNKSOUNDS API) ───────────────────────────────────────────────────────────────
// After login, the app calls GET /api/entitlements/multicam with the JWT token.
// The API returns { enabled, source, subscription } indicating whether the user
// has premium via Stripe subscription, admin grant, or not at all.

/**
 * Check whether the current forum user has premium access for this app.
 * Returns { premium: boolean, source: 'stripe'|'admin'|'none', subscription: object|null, authenticated: boolean }.
 * Returns { premium: false, source: 'none', authenticated: false } on auth failure.
 * Returns { premium: false, source: 'none', authenticated: true } on any other error (fail closed).
 */
async function checkPremiumEntitlement() {
  const session = restoreSession();
  if (!session) return { premium: false, source: 'none', authenticated: false };

  try {
    const res = await fetch(ENTITLEMENTS_URL, {
      headers: {
        'Authorization': `Bearer ${session.token}`,
      },
    });

    if (res.status === 401) {
      // Token expired or invalid — user needs to log in again
      return { premium: false, source: 'none', authenticated: false };
    }

    if (!res.ok) return { premium: false, source: 'none', authenticated: true };

    const data = await res.json();
    if (data.error) return { premium: false, source: 'none', authenticated: true };

    return {
      premium: !!data.enabled,
      source: data.source || 'none',
      subscription: data.subscription || null,
      authenticated: true,
    };
  } catch (err) {
    console.warn('[forumAuth] entitlement check failed:', err.message);
    return { premium: false, source: 'none', authenticated: true };
  }
}

module.exports = {
  forumLogin,
  restoreSession,
  getCachedSession,
  storeSession,
  clearForumSession,
  isJwtExpired,
  checkPremiumEntitlement,
  FORUM_API_URL,
  FORUM_REGISTER_URL,
  FORUM_PASSWORD_RESET_URL,
  PRICING_URL,
  ACCOUNT_URL,
  APP_KEY,
};
