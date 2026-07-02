'use strict';

/**
 * lib/integrity.js — Basic runtime integrity checks for bundled binaries.
 *
 * A full hash-based manifest would be ideal, but this first version at least
 * verifies that the expected critical files exist and are non-empty, logging
 * warnings if anything is missing or suspiciously small.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_FILE_SIZES = {
  'adb.exe': 100000,
  'scrcpy.exe': 100000,
  'scrcpy-server': 100000,
  'UnityCaptureFilter64.dll': 100000,
  'UnityCaptureFilter64bit.dll': 100000,
  'UnityCaptureFilter32.dll': 100000,
};

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch { return null; }
}

function checkBundleIntegrity(resourcesBase) {
  const results = [];
  const criticalFiles = [
    { name: 'adb.exe', dir: 'tools' },
    { name: 'scrcpy.exe', dir: 'tools' },
    { name: 'scrcpy-server', dir: 'tools' },
    { name: 'UnityCaptureFilter64.dll', dir: 'vcam' },
  ];

  for (const { name, dir } of criticalFiles) {
    const filePath = path.join(resourcesBase, dir, name);
    const alternatePath = path.join(resourcesBase, dir, 'UnityCaptureFilter64bit.dll');
    const exists = fs.existsSync(filePath) || (name === 'UnityCaptureFilter64.dll' && fs.existsSync(alternatePath));
    const actualPath = fs.existsSync(filePath) ? filePath : alternatePath;
    let size = 0;
    if (exists) {
      try { size = fs.statSync(actualPath).size; } catch {}
    }
    const minSize = MIN_FILE_SIZES[name] || 1;
    const hash = exists ? sha256File(actualPath) : null;
    const ok = exists && size >= minSize;
    results.push({ name, exists, size, hash, ok });
  }

  return results;
}

module.exports = { checkBundleIntegrity, sha256File };
