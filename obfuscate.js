'use strict';

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const FILES = [
  'renderer.js',
  'output-renderer.js',
];

const OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningProbability: 0.75,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  selfDefending: true,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  reservedStrings: [
    'electronAPI',
    'licenseAPI',
    'SelfieSegmentation',
    'mediapipe',
  ],
};

const BACKUP_DIR = path.join(__dirname, '.obf-backup');
const mode = process.argv[2] || 'obfuscate';

if (mode === 'obfuscate') {
  // Backup originals then obfuscate in place
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const file of FILES) {
    const src = path.join(__dirname, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(BACKUP_DIR, file));
    }
  }
  for (const file of FILES) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${file} — not found`);
      continue;
    }
    const code = fs.readFileSync(filePath, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, {
      ...OPTIONS,
      target: 'browser',
    });
    fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8');
    console.log(`Obfuscated ${file}`);
  }
  console.log('Obfuscation complete. Run "node obfuscate.js restore" after build to restore originals.');
} else if (mode === 'restore') {
  // Restore originals from backup
  for (const file of FILES) {
    const backup = path.join(BACKUP_DIR, file);
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, path.join(__dirname, file));
      console.log(`Restored original ${file}`);
    }
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log('Originals restored.');
}
