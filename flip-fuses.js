'use strict';

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');
const fs = require('fs');

async function main() {
  const exeName = 'MultiCam Viewer.exe';
  const candidates = [
    path.join(__dirname, 'dist', 'win-unpacked', exeName),
    path.join(__dirname, 'dist', 'win-unpacked', 'MultiCam Viewer.exe'),
  ];

  let electronPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { electronPath = c; break; }
  }

  if (!electronPath) {
    console.error('Packaged app not found. Run "npm run build" first.');
    process.exit(1);
  }

  console.log('Flipping fuses on:', electronPath);

  await flipFuses(electronPath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });

  console.log('Electron fuses flipped successfully on packaged binary.');
}

main().catch(err => {
  console.error('Failed to flip fuses:', err);
  process.exit(1);
});
