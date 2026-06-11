// electron-builder afterPack hook: ad-hoc code-sign the macOS .app.
//
// The public build is unsigned (no paid Apple Developer account). On Apple
// Silicon a *completely* unsigned app trips Gatekeeper's worst message —
// "Pallasite is damaged and can't be opened" — which looks like a corrupt
// download. An ad-hoc signature (`codesign -s -`) is enough to downgrade that
// to the ordinary, dismissable "unidentified developer" prompt where
// right-click → Open works. It is NOT notarised; that still needs the paid
// account. CSC_IDENTITY_AUTO_DISCOVERY=false stops electron-builder doing its
// own keychain signing, so this hook is the only signature applied.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // --deep so the bundled Electron frameworks + helper apps are signed too.
  execFileSync('codesign', ['--deep', '--force', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`[adhoc-sign] ad-hoc signed ${app}`);
};
