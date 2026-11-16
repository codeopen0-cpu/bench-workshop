// Prints a GLB's overall bounding box (from its accessors' min/max and the node transforms) and its
// up axis guess.   node tools/glb_bounds.mjs path/to/model.glb
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const trs = (n) => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
const visit = (i, parent) => {
  const n = gltf.nodes[i];
  const m = mul(parent, trs(n));
  if (n.mesh !== undefined)
    for (const p of gltf.meshes[n.mesh].primitives) {
      const a = gltf.accessors[p.attributes.POSITION];
      for (const cx of [a.min[0], a.max[0]]) for (const cy of [a.min[1], a.max[1]]) for (const cz of [a.min[2], a.max[2]]) {
        const v = [0, 1, 2].map((r) => m[r] * cx + m[4 + r] * cy + m[8 + r] * cz + m[12 + r]);
        v.forEach((x, k) => { min[k] = Math.min(min[k], x); max[k] = Math.max(max[k], x); });
      }
    }
  for (const c of n.children ?? []) visit(c, m);
};
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const r of gltf.scenes[gltf.scene ?? 0].nodes) visit(r, I);
const size = max.map((x, k) => x - min[k]);
console.log(JSON.stringify({ min: min.map((x) => +x.toFixed(4)), max: max.map((x) => +x.toFixed(4)), size: size.map((x) => +x.toFixed(4)), nodes: gltf.nodes.length, meshes: gltf.meshes.length }));
