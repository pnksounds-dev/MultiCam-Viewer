'use strict';

// ─── In-house license key verification ────────────────────────────────────────
// The same hardcoded secret is used by the admin generator (license-generator.js)
// and by the app. This is client-side verification, so it is obfuscation, not
// bank-grade security. It is sufficient for an in-house receipt-based system.

const LICENSE_SECRET = 'MultiCamViewer-LicenseSecret-2026';
const SALT = 'multicam-license-salt';
const PBKDF2_ITERATIONS = 100000;

async function getLicenseKey() {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(LICENSE_SECRET),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function decryptLicenseKey(keyString) {
  try {
    const clean = keyString.replace(/\s+/g, '').replace(/-/g, '');
    if (!clean) return null;
    const combined = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
    if (combined.length < 28) return null; // 12 byte IV + 16 byte tag minimum

    const iv = combined.slice(0, 12);
    const ciphertextAndTag = combined.slice(12);
    const key = await getLicenseKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertextAndTag
    );
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decrypted));
  } catch (err) {
    return null;
  }
}

async function verifyLicenseKey(keyString, licenseDatabase) {
  const payload = await decryptLicenseKey(keyString);
  if (!payload) return { valid: false, reason: 'Invalid license key' };
  if (!payload.id || typeof payload.cameras !== 'number') {
    return { valid: false, reason: 'Malformed license key' };
  }

  const entry = licenseDatabase.find(k => k.id === payload.id);
  if (!entry) return { valid: false, reason: 'License key not recognized' };

  if (entry.revoked) return { valid: false, reason: 'License key revoked' };

  if (entry.expires && new Date(entry.expires) < new Date()) {
    return { valid: false, reason: 'License key expired' };
  }

  return { valid: true, cameras: payload.cameras, expires: entry.expires };
}

// Export for renderer.js
window.licenseAPI = { decryptLicenseKey, verifyLicenseKey };
