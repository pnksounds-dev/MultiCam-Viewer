'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LICENSE_SECRET = 'MultiCamViewer-LicenseSecret-2026';
const SALT = 'multicam-license-salt';
const PBKDF2_ITERATIONS = 100000;
const DB_FILE = path.join(__dirname, 'licenses.json');

function deriveKey() {
  return crypto.pbkdf2Sync(LICENSE_SECRET, SALT, PBKDF2_ITERATIONS, 32, 'sha256');
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function encryptLicense(payload) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const data = Buffer.from(JSON.stringify(payload));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  return { keys: [] };
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function formatKey(base64) {
  return base64.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function main() {
  console.log('MultiCam Viewer License Key Generator\n');
  const cameras = parseInt(await ask('Number of cameras (max): '), 10) || 4;
  const months = parseInt(await ask('Validity in months (0 = no expiry): '), 10);
  const note = await ask('Note (optional): ');

  const expires = months > 0
    ? new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const id = generateId();
  const payload = { id, cameras, created: new Date().toISOString() };
  const key = encryptLicense(payload);
  const formattedKey = formatKey(key);

  const db = loadDb();
  db.keys.push({
    id,
    key: formattedKey,
    cameras,
    expires,
    note,
    created: payload.created,
    revoked: false,
  });
  saveDb(db);

  console.log('\n--- Generated license key ---');
  console.log(formattedKey);
  console.log('\nThis key has been saved to licenses.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
