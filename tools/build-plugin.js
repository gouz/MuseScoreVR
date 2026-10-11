// Assemble the MuseScore plugin in plugin/: the server compiled for every platform (bin/), the headset page (web/)
// and the seat layout used by the plugin's plan (layout.mjs). The folder is then the whole plugin:
// copy (or link, while developing) it into MuseScore's plugin folder.
//
// usage: bun run plugin [--here] [--release <version>]
//   --here: only this computer's platform, faster while developing
//   --release: also packs dist/MuseScoreVR-<version>-<os>.zip, a ready-to-copy plugin folder per system (the CI does this)
import { $ } from 'bun';
import { mkdir, rm, copyFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..'), out = join(repo, 'plugin');
const WEB = ['index.html', 'engine.js', 'stands.js', 'zip.js', 'layout.js']; // the headset page and what it imports
const here = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const targets = { // file name in bin/ (the plugin picks it by platform) -> Bun targets
  'musescorevr-macos': ['bun-darwin-arm64', 'bun-darwin-x64'], // merged into one universal binary when lipo is there
  'musescorevr-windows.exe': ['bun-windows-x64'],
  'musescorevr-linux': ['bun-linux-x64'],
};

await rm(join(out, 'bin'), { recursive: true, force: true }); await rm(join(out, 'web'), { recursive: true, force: true });
await mkdir(join(out, 'bin'), { recursive: true }); await mkdir(join(out, 'web'), { recursive: true });
for (const f of WEB) await copyFile(join(repo, 'proto', f), join(out, 'web', f));
await copyFile(join(repo, 'proto/layout.js'), join(out, 'layout.mjs')); // QML imports ES modules by their .mjs name

for (const [name, list] of Object.entries(targets)) {
  if (process.argv.includes('--here') && !name.includes(here)) continue;
  const built = [];
  for (const target of list) {
    const file = join(out, 'bin', list.length > 1 ? `${name}-${target}` : name);
    const hide = target.includes('windows') ? ['--windows-hide-console'] : []; // no console window when the plugin starts it
    await $`bun build --compile --minify --target=${target} ${hide} ${join(repo, 'tools/serve.js')} --outfile ${file}`.quiet();
    built.push(file);
  }
  if (built.length > 1) {
    // ponytail: without lipo (building off macOS), Intel Macs are left out
    if (Bun.which('lipo')) await $`lipo -create -output ${join(out, 'bin', name)} ${built}`.quiet();
    else await copyFile(built[0], join(out, 'bin', name));
    for (const f of built) await rm(f);
  }
  if (name.includes('macos') && Bun.which('codesign')) await $`codesign --force -s - ${join(out, 'bin', name)}`.quiet(); // ad-hoc: Apple silicon runs nothing unsigned
  console.log('bin/' + name);
}
console.log(`plugin prêt : ${out}`);

const i = process.argv.indexOf('--release'), version = i > 0 ? process.argv[i + 1] : null;
if (version) {
  const dist = join(repo, 'dist');
  await rm(dist, { recursive: true, force: true });
  for (const name of Object.keys(targets)) {
    const os = name.match(/macos|windows|linux/)[0], dir = join(dist, os, 'MuseScoreVR');
    await mkdir(join(dir, 'bin'), { recursive: true });
    const qml = await Bun.file(join(out, 'MuseScoreVR.qml')).text();
    await Bun.write(join(dir, 'MuseScoreVR.qml'), qml.replace(/^(\s*version: )"[^"]*"/m, `$1"${version}"`));
    await copyFile(join(out, 'layout.mjs'), join(dir, 'layout.mjs'));
    await cp(join(out, 'web'), join(dir, 'web'), { recursive: true });
    await copyFile(join(out, 'bin', name), join(dir, 'bin', name));
    await $`zip -qr ${join(dist, `MuseScoreVR-${version}-${os}.zip`)} MuseScoreVR`.cwd(join(dist, os)); // zip keeps the exec bit
    await rm(join(dist, os), { recursive: true });
    console.log(`dist/MuseScoreVR-${version}-${os}.zip`);
  }
}
