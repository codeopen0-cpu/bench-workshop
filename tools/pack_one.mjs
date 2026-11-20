// Packs one library folder (safety-checked) for trying it in the dev page:
//   node tools/pack_one.mjs motion-sensors   -> tools/scratch-libs/libraries/<id>.benchlib
// then in the dev page: await bench.checkExamples({ fromPacked: '/tools/scratch-libs/', only: '<id>' })
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFolder } from '../registry/tools/pack.mjs';
import { checkLibrarySafety, safetyReport } from '../registry/tools/safety.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) throw new Error('which library? node tools/pack_one.mjs <folder in registry/src>');
const lib = readFolder(resolve(here, '..', 'registry', 'src', id));
const text = JSON.stringify(lib);
const safe = checkLibrarySafety(lib, text.length);
for (const line of safetyReport(safe)) console.log(`  ${line}`);
if (!safe.ok) process.exit(1);
const out = join(here, 'scratch-libs');
mkdirSync(join(out, 'libraries'), { recursive: true });
writeFileSync(join(out, 'libraries', `${lib.id}.benchlib`), text);
writeFileSync(join(out, 'index.json'), JSON.stringify({ format: 'bench-library-index', libraries: [{ id: lib.id, version: lib.version, url: `libraries/${lib.id}.benchlib` }] }));
console.log(`packed ${lib.id} ${lib.version} into ${out} (${(text.length / 1024).toFixed(1)} KB)`);
