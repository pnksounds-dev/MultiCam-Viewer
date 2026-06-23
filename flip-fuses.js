'use strict';

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');
const fs = require('fs');

async function main() {
  const electronPath = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Electron.exe');
  if (!fs.existsSync(electronPath)) {
    console.log('Electron binary not found at', electronPath);
    console.log('Run this after npm install.');
    process.exit(1);
  }

  await flipFuses(electronPath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });

  console.log('Electron fuses flipped successfully.');
}

main().catch(err => {
  console.error('Failed to flip fuses:', err);
  process.exit(1);
});
