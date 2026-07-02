'use strict';

/**
 * license-generator.js
 *
 * Issues signed license keys for MultiCam Viewer using the RSA private key.
 * The private key must be kept in .license-private/private-key.pem or supplied
 * via the LICENSE_PRIVATE_KEY_PEM environment variable. It is never committed.
 */

const readline = require('readline');
const {
  signLicense,
  generateLicenseId,
  loadLicenseDatabase,
  saveLicenseDatabase,
} = require('./lib/license');

const DB_FILE = require('path').join(__dirname, '.license-private', 'licenses.json');

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function main() {
  console.log('MultiCam Viewer License Key Generator (RSA-signed)\n');
  const cameras = parseInt(await ask('Number of cameras (max): '), 10) || 4;
  const months = parseInt(await ask('Validity in months (0 = no expiry): '), 10);
  const note = await ask('Note (optional): ');

  const expires = months > 0
    ? new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const id = generateLicenseId();
  const payload = { id, cameras, created: new Date().toISOString() };
  if (expires) payload.expires = expires;

  const formattedKey = signLicense(payload);

  const db = loadLicenseDatabase(DB_FILE);
  db.keys.push({
    id,
    key: formattedKey,
    cameras,
    expires,
    note,
    created: payload.created,
    revoked: false,
  });
  saveLicenseDatabase(db, DB_FILE);

  console.log('\n--- Generated license key ---');
  console.log(formattedKey);
  console.log('\nThis key has been saved to .license-private/licenses.json');
  console.log('Keep the private key secret; the public key is bundled in assets/public-key.pem.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
