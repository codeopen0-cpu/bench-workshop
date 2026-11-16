// Publishes a built version as a GitHub release that installed apps update from.
//   1. build:  set TAURI_SIGNING_PRIVATE_KEY=<path to the private signing key> (and
//              TAURI_SIGNING_PRIVATE_KEY_PASSWORD, empty if it has none), then npm run release
//   2. this:   node tools/release.mjs "What's new, one line or a few"
// It takes the version from src-tauri/tauri.conf.json, finds the NSIS installer and its .sig, writes
// latest.json (the updater reads releases/latest/download/latest.json) and creates release vX.Y.Z on
// codeopen0-cpu/bench-workshop with the three files. Bump the version in tauri.conf.json and
// package.json before building the next one.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'codeopen0-cpu/bench-workshop';
const notes = process.argv[2] ?? '';
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const dir = 'src-tauri/target/release/bundle/nsis';
const exe = join(dir, `${conf.productName}_${version}_x64-setup.exe`);
const sig = `${exe}.sig`;
for (const f of [exe, sig]) if (!existsSync(f)) throw new Error(`${f} is missing: build first (npm run release, with the signing key set)`);
const asset = encodeURIComponent(`${conf.productName}_${version}_x64-setup.exe`).replace(/%20/g, '.');
// (GitHub turns spaces in asset names into dots)
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${asset}`,
    },
  },
};
const latestPath = join(dir, 'latest.json');
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
console.log(`latest.json for ${version}: ${latest.platforms['windows-x86_64'].url}`);
execFileSync('gh', ['release', 'create', `v${version}`, exe, sig, latestPath, '--repo', REPO, '--title', `Bench Workshop ${version}`, '--notes', notes || `Bench Workshop ${version}`], { stdio: 'inherit' });
console.log(`released v${version}: https://github.com/${REPO}/releases/tag/v${version}`);
