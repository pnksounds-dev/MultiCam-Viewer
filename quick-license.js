'use strict';

/**
 * quick-license.js
 *
 * Non-interactive license key generator for batch processing.
 * Generates a license key with default parameters and appends it to licenses.txt
 */

const fs = require('fs');
const path = require('path');
const {
  signLicense,
  generateLicenseId,
} = require('./lib/license');

const LICENSES_FILE = path.join(__dirname, 'licenses.txt');

function main() {
  // Default license parameters
  const cameras = 4; // Default 4 cameras
  const months = 0;  // No expiry by default
  
  const expires = months > 0
    ? new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const id = generateLicenseId();
  const payload = { 
    id, 
    cameras, 
    created: new Date().toISOString() 
  };
  
  if (expires) payload.expires = expires;

  const formattedKey = signLicense(payload);

  // Create timestamp
  const timestamp = new Date().toISOString();
  
  // Format the entry
  const entry = [
    `Generated: ${timestamp}`,
    `License ID: ${id}`,
    `Max Cameras: ${cameras}`,
    `Expires: ${expires || 'Never'}`,
    `License Key: ${formattedKey}`,
    '----------------------------------------'
  ].join('\n');

  // Append to licenses.txt
  fs.appendFileSync(LICENSES_FILE, entry + '\n', 'utf8');

  console.log('License key generated successfully!');
  console.log('\n' + entry);
  console.log(`\nAppended to: ${LICENSES_FILE}`);
}

main().catch(err => {
  console.error('Error generating license:', err.message);
  process.exit(1);
});
