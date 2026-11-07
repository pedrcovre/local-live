const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// Local ad-hoc signature: no certificate, Apple account, keychain or paid service.
// Required because changing Electron's application bundle invalidates its original signature.
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const destination = path.join(context.appOutDir, 'Local Live.app');
  // A file provider may immediately reattach FinderInfo in a synced Documents folder.
  // Sign a temporary staging copy outside that folder, then return signed contents.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'entretelas-sign-'));
  const app = path.join(staging, 'Local Live.app');
  execFileSync('/usr/bin/ditto', [destination, app]);
  try {
  // Finder can attach presentation metadata to generated bundles in Documents.
  // Remove only those two build-artifact attributes; preserve security attributes.
  for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
    try { execFileSync('/usr/bin/xattr', ['-dr', attribute, app], { stdio: 'pipe' }); }
    catch (error) { if (!String(error.stderr).includes('No such xattr')) throw error; }
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/ditto', [app, destination]);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
};
