import { packager } from '@electron/packager';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const bundles = await packager({
  dir: '.', name: 'Harbor', platform: 'darwin', arch: 'arm64', out: 'release', overwrite: true,
  appBundleId: 'local.harbor.terminal', appCategoryType: 'public.app-category.developer-tools',
  icon: path.resolve('assets/Harbor.icns'),
  ignore: /^\/(test|release|artifacts|\.git)(\/|$)/,
  // node-pty launches a real Mach-O helper alongside its native addon.
  // ASAR's automatic native-module detection does not include this executable.
  asar: { unpack: '**/node-pty/**' },
});
for (const directory of bundles) {
  const bundle = path.join(directory, 'Harbor.app');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  console.log(`Built and locally signed: ${bundle}`);
}
