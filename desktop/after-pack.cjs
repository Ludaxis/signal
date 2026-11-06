// electron-builder afterPack: copies the prepared Studio server into Signal.app/Contents/Resources/server
// (kept outside the asar, with its .next folder intact), then ad-hoc signs the app so it opens on
// Apple Silicon without a Developer ID. Notarized builds would replace the ad-hoc signature.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const src = path.join(__dirname, 'app-server');
  const dest = path.join(appPath, 'Contents', 'Resources', 'server');
  if (fs.existsSync(path.join(__dirname, 'app-config.json'))) {
    // Checkout build: the app runs `next start` in your Signal folder, so no server is bundled.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    return;
  }
  if (!fs.existsSync(path.join(src, 'server.js'))) throw new Error('desktop/app-server is missing: run "npm run app:prepare" in the Signal folder first.');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
