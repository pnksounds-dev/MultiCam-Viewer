'use strict';

/**
 * lib/license.js — Offline public-key license verification.
 *
 * The app ships only the RSA public key. License keys are JSON payloads signed
 * with the corresponding private key, which is kept outside the repository and
 * never bundled. This replaces the previous hardcoded-secret AES scheme.
 *
 * License key format (after signing):
 *   base64(payloadJSON).base64(signature)
 *   formatted in dash-separated groups of 4 for readability.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_SIZE = 2048;
const SIGNATURE_ALGORITHM = 'RSA-SHA256';

// ─── Key loading ──────────────────────────────────────────────────────────────

function loadPublicKeyPem() {
  // Prefer an explicit PEM provided at build/runtime; otherwise fall back to
  // the bundled public key. The public key is safe to ship with the app.
  if (process.env.LICENSE_PUBLIC_KEY_PEM) {
    return process.env.LICENSE_PUBLIC_KEY_PEM;
  }
  const bundled = path.join(__dirname, '..', 'assets', 'public-key.pem');
  if (fs.existsSync(bundled)) {
    return fs.readFileSync(bundled, 'utf8');
  }
  throw new Error('License public key not found. Set LICENSE_PUBLIC_KEY_PEM or place public-key.pem in assets/.');
}

function loadPrivateKeyPem() {
  const fromEnv = process.env.LICENSE_PRIVATE_KEY_PEM;
  if (fromEnv) return fromEnv;
  const privatePath = path.join(__dirname, '..', '.license-private', 'private-key.pem');
  if (fs.existsSync(privatePath)) {
    return fs.readFileSync(privatePath, 'utf8');
  }
  throw new Error('License private key not found. Set LICENSE_PRIVATE_KEY_PEM or place private-key.pem in .license-private/.');
}

function getPublicKey() {
  return crypto.createPublicKey(loadPublicKeyPem());
}

function getPrivateKey() {
  return crypto.createPrivateKey(loadPrivateKeyPem());
}

// ─── Base64 helpers ──────────────────────────────────────────────────────────
// Standard base64 is used (not base64url) because the formatKey/cleanKey
// functions insert and remove dashes. base64url also uses '-' as a character,
// which would make the roundtrip lossy.

function b64Encode(buf) {
  return buf.toString('base64');
}

function b64Decode(str) {
  return Buffer.from(str, 'base64');
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatKey(raw) {
  return raw.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

function cleanKey(formatted) {
  return formatted.replace(/[-\s]/g, '');
}

// ─── Signing / verification ───────────────────────────────────────────────────

function canonicalPayload(payload) {
  const ordered = {};
  for (const key of Object.keys(payload).sort()) {
    ordered[key] = payload[key];
  }
  return JSON.stringify(ordered);
}

function signLicense(payload) {
  const data = Buffer.from(canonicalPayload(payload), 'utf8');
  const signature = crypto.sign(SIGNATURE_ALGORITHM, data, getPrivateKey());
  const payloadB64 = b64Encode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signatureB64 = b64Encode(signature);
  return formatKey(`${payloadB64}.${signatureB64}`);
}

function verifyLicenseSignature(keyString) {
  try {
    const raw = cleanKey(keyString);
    const dotIndex = raw.indexOf('.');
    if (dotIndex === -1) return null;

    const payloadBuf = b64Decode(raw.slice(0, dotIndex));
    const signature = b64Decode(raw.slice(dotIndex + 1));
    const payload = JSON.parse(payloadBuf.toString('utf8'));

    const data = Buffer.from(canonicalPayload(payload), 'utf8');
    const ok = crypto.verify(SIGNATURE_ALGORITHM, data, getPublicKey(), signature);
    if (!ok) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── Database helpers (kept outside the bundled app) ───────────────────────────

function defaultDbPath() {
  return path.join(__dirname, '..', '.license-private', 'licenses.json');
}

function loadLicenseDatabase(dbPath = defaultDbPath()) {
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
  } catch {}
  return { keys: [] };
}

function saveLicenseDatabase(db, dbPath = defaultDbPath()) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

// ─── App-facing verification ────────────────────────────────────────────────

function verifyLicenseKey(keyString, dbPath) {
  if (typeof keyString !== 'string' || keyString.length > 1024) {
    return { valid: false, reason: 'Invalid license key' };
  }

  const payload = verifyLicenseSignature(keyString);
  if (!payload) return { valid: false, reason: 'Invalid license key' };
  if (!payload.id || typeof payload.cameras !== 'number' || payload.cameras < 1) {
    return { valid: false, reason: 'Malformed license payload' };
  }

  // If a database is present, check revocation/expiration records. The app does
  // not ship the database, so this check is optional and mainly used at key
  // generation time or by an online verification endpoint.
  if (dbPath) {
    const db = loadLicenseDatabase(dbPath);
    const entry = (db.keys || []).find(k => k.id === payload.id);
    if (entry) {
      if (entry.revoked) return { valid: false, reason: 'License key revoked' };
      if (entry.expires && new Date(entry.expires) < new Date()) {
        return { valid: false, reason: 'License key expired' };
      }
    }
  }

  if (payload.expires && new Date(payload.expires) < new Date()) {
    return { valid: false, reason: 'License key expired' };
  }

  return { valid: true, cameras: payload.cameras, expires: payload.expires || null };
}

function generateLicenseId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  signLicense,
  verifyLicenseKey,
  generateLicenseId,
  loadLicenseDatabase,
  saveLicenseDatabase,
  formatKey,
  cleanKey,
  loadPublicKeyPem,
  loadPrivateKeyPem,
  KEY_SIZE,
  SIGNATURE_ALGORITHM,
};
