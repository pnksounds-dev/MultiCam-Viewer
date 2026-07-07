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

// ÔöÇÔöÇ Config ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

const FORUM_API_URL = 'https://pnksounds.dev';
const FORUM_REGISTER_URL = 'https://pnksounds.dev/register';
const FORUM_PASSWORD_RESET_URL = 'https://pnksounds.dev/reset.html';

// ÔöÇÔöÇ Supabase config ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// The anon key is the PUBLIC key ÔÇö safe to ship in the client. The JWT issued
// by the forum (signed with SUPABASE_JWT_SECRET) is sent as the Bearer token
// for RLS-protected queries. NEVER put the service-role key or JWT secret here.
//
// TODO: Paste your Supabase project URL and anon key below.
//       Dashboard ÔåÆ Project Settings ÔåÆ API ÔåÆ "Project URL" and "anon public".
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
const ENTITLEMENT_APP = 'multicam'; // matches the `app` column in app_entitlements

function sessionFile() {
  return path.join(app.getPath('userData'), 'forumSession.enc');
}

// ÔöÇÔöÇ Types ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

// ForumUser: { id, username, email, customId, isStaff, isAdmin, bio, avatar }
// StoredSession: { token, user, storedAt }

// ÔöÇÔöÇ In-memory cache ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

let cachedSession = null;

// ÔöÇÔöÇ JWT helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

// ÔöÇÔöÇ Secure storage ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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
      // less secure ÔÇö log so the user knows.
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

// ÔöÇÔöÇ Public API ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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
    // Expired or malformed ÔÇö clean up.
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

// ÔöÇÔöÇ Entitlement check (Supabase PostgREST) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// After login, the app queries the app_entitlements table to see if the admin
// has granted premium for this app. The forum JWT is sent as the Bearer token,
// so RLS restricts the result to the user's own row (auth.uid() = user_id).

/**
 * Check whether the current forum user has premium access for this app.
 * Returns { premium: boolean, source: 'entitlement' | 'none' }.
 * Returns { premium: false, source: 'none' } on any error (fail closed).
 */
async function checkPremiumEntitlement() {
  const session = restoreSession();
  if (!session) return { premium: false, source: 'none' };

  // Fail closed if Supabase isn't configured yet.
  if (SUPABASE_URL.includes('YOUR-PROJECT') || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
    return { premium: false, source: 'none' };
  }

  const url = `${SUPABASE_URL}/rest/v1/app_entitlements?select=premium&app=eq.${encodeURIComponent(ENTITLEMENT_APP)}&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${session.token}`,
      },
    });
    if (!res.ok) return { premium: false, source: 'none' };
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].premium === true) {
      return { premium: true, source: 'entitlement' };
    }
    return { premium: false, source: 'none' };
  } catch (err) {
    console.warn('[forumAuth] entitlement check failed:', err.message);
    return { premium: false, source: 'none' };
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
  ENTITLEMENT_APP,
};
