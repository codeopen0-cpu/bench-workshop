// The parts list (what to buy: each part, how many, roughly what it costs, what it weighs) and the
// wiring sheet (a picture from above, every connection as a list of the pins joined, every wire with
// its length): for building the real thing. Both copy, save and print.
import * as THREE from 'three';
import type { PartType } from '../parts/types';
import type { Project } from '../project';
import type { Stage } from '../stage';
import type { PartView } from '../views';

export interface SheetHost {
  project(): Project;
  views(): Map<string, PartView>;
  typeOf(id: string): PartType | undefined;
  stage: Stage;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
}

/** rough prices (US$, from the usual online shops, 2026), by part type */
const PRICE: Record<string, number> = {
  'esp32-board': 6, 'arduino-nano': 4, 'arduino-mega': 15, 'uno-wifi-board': 27.5, 'maker-board': 8, 'rp2040-board': 4, 'pico-w': 6,
  'esp8266-nodemcu': 4, 'esp8266-d1mini': 3, 'esp32s3-board': 9, 'esp32c3-mini': 3, 'board-proto': 1,
  'servo-sg90': 2, 'servo-mg996r': 5, 'motor-tt': 2, wheel: 1.5, caster: 1, 'tank-track': 15, 'mecanum-wheel': 8, 'omni-wheel': 6,
  gear: 0.5, pulley: 1, axle: 2, 'brushless-prop': 12, esc: 10,
  'battery-4aa': 4, 'battery-9v': 3, 'battery-cr2032': 0.5, 'battery-18650': 5, 'battery-lipo': 15, 'bench-supply': 0,
  drv8833: 2, l298n: 3, hcsr04: 1.5, led: 0.1, button: 0.1, knob: 0.5, mpu6050: 2, pca9685: 4, mcp23017: 2, ads1115: 3, ina226: 3, 'eeprom-24c02': 1,
  acs712: 2, 'voltage-sensor': 1,
};
/** things you make yourself (blocks, plates...): no price */
const MADE = new Set(['block', 'plate', 'rod', 'ball']);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.setAttribute('style', v); else (e as any)[k] = v; }
  e.append(...kids);
  return e;
}
const money = (x: number) => `$${x.toFixed(2)}`;

export function partsList(host: SheetHost) {
  const p = host.project();
  const rows = new Map<string, { name: string; type: string; count: number; each: number | null; grams: number; from: string }>();
  for (const inst of p.parts) {
    const t = host.typeOf(inst.type);
    const v = host.views().get(inst.uid);
    const grams = v ? v.build.bodies.reduce((s, b) => s + b.mass, 0) : 0;
    // (things you make: one row each, with its size; bought parts: counted)
    const made = MADE.has(inst.type);
    const key = made ? `${inst.type}:${JSON.stringify(inst.params)}` : inst.type;
    const r = rows.get(key) ?? {
      name: made ? `${t?.name ?? inst.type} ${['w', 'h', 'd', 'r', 'length'].filter((k) => inst.params[k] !== undefined).map((k) => inst.params[k]).join(' x ')} cm (${inst.params.material ?? 'make it'})` : t?.name ?? inst.type,
      type: inst.type, count: 0, each: made ? 0 : PRICE[inst.type] ?? null, grams: 0,
      from: inst.type.includes('/') ? `library ${inst.type.split('/')[0]}` : made ? 'make it' : 'shop',
    };
    r.count++;
    r.grams += grams;
    rows.set(key, r);
  }
  const list = [...rows.values()].sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
  const wires = p.wires.length, wireCm = p.wires.reduce((s, w) => s + (w.length ?? 10), 0);
  const total = list.reduce((s, r) => s + (r.each ?? 0) * r.count, 0) + wires * 0.05;
  const unknown = list.filter((r) => r.each === null).length;
  const grams = list.reduce((s, r) => s + r.grams, 0);
  return { list, wires, wireCm, total, unknown, grams };
}

/** Each connection: the pins one wire or a chain of wires joins (a net, as on a schematic). */
export function connections(host: SheetHost) {
  const p = host.project();
  const parent = new Map<string, string>();
  const find = (k: string): string => { while (parent.get(k) !== k) k = parent.get(k)!; return k; };
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  for (const w of p.wires) {
    const a = `${w.a.uid}/${w.a.pin}`, b = `${w.b.uid}/${w.b.pin}`;
    add(a); add(b);
    parent.set(find(a), find(b));
  }
  const nets = new Map<string, string[]>();
  for (const k of parent.keys()) { const r = find(k); nets.set(r, [...(nets.get(r) ?? []), k]); }
  const label = (k: string) => {
    const [uid, pin] = [k.slice(0, k.lastIndexOf('/')), k.slice(k.lastIndexOf('/') + 1)];
    const name = p.parts.find((x) => x.uid === uid)?.name ?? uid;
    return `${name} ${pin}`;
  };
  return [...nets.values()].map((pins) => pins.map(label).sort()).sort((a, b) => b.length - a.length);
}

/** a picture of the bench from straight above (an image's data URL) */
function topView(host: SheetHost) {
  const r = host.stage.renderer;
  // (framed on the wired parts: the electronics, not the whole bench)
  const wired = new Set(host.project().wires.flatMap((w) => [w.a.uid, w.b.uid]));
  const box = new THREE.Box3();
  for (const [uid, v] of host.views()) if (!wired.size || wired.has(uid)) box.expandByObject(v.root);
  if (box.isEmpty()) return '';
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x, s.z) * 0.6 + 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 1000);
  cam.position.set(c.x, box.max.y + 100, c.z);
  cam.up.set(0, 0, -1);
  cam.lookAt(c.x, 0, c.z);
  const W = 900;
  const target = new THREE.WebGLRenderTarget(W, W);
  const scene = host.stage.scene, bg = scene.background;
  scene.background = new THREE.Color(0xf4f5f7); // (paper-white, for printing)
  // (without the floor and its grid: just the parts and wires on white)
  const hidden = [host.stage.ground, ...scene.children.filter((o) => o instanceof THREE.GridHelper)].filter((o) => o.visible);
  hidden.forEach((o) => (o.visible = false));
  r.setRenderTarget(target);
  r.render(scene, cam);
  scene.background = bg;
  hidden.forEach((o) => (o.visible = true));
  const px = new Uint8Array(W * W * 4);
  r.readRenderTargetPixels(target, 0, 0, W, W, px);
  r.setRenderTarget(null);
  target.dispose();
  const cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(W, W);
  for (let y = 0; y < W; y++) img.data.set(px.subarray((W - 1 - y) * W * 4, (W - y) * W * 4), y * W * 4); // (the GPU's rows are upside down)
  g.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

/** The window: the parts list and the wiring sheet. */
export function openSheets(host: SheetHost, tab: 'parts' | 'wiring' = 'parts') {
  const back = el('div', { className: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', esc);
  back.onclick = (e) => e.target === back && close();
  const body = el('div', { className: 'sheet-body' });
  const bom = partsList(host);
  const nets = connections(host);
  const p = host.project();
  const partsHtml = () => {
    const t = el('table', { className: 'sheet-table' },
      el('tr', {}, ...['How many', 'Part', 'From', 'Each', 'Weight'].map((h) => el('th', { textContent: h }))),
      ...bom.list.map((r) => el('tr', {}, el('td', { textContent: String(r.count) }), el('td', { textContent: r.name }), el('td', { textContent: r.from }), el('td', { textContent: r.each === null ? '?' : r.each ? money(r.each) : '-' }), el('td', { textContent: `${r.grams.toFixed(0)} g` }))),
      el('tr', {}, el('td', { textContent: String(bom.wires) }), el('td', { textContent: `jumper wires (${bom.wireCm.toFixed(0)} cm in all)` }), el('td', { textContent: 'shop' }), el('td', { textContent: money(0.05) }), el('td', { textContent: '' })));
    return el('div', {}, t, el('div', { className: 'sheet-note', textContent: `About ${money(bom.total)} to buy${bom.unknown ? ` (plus ${bom.unknown} part kinds with no price here)` : ''}; ${(bom.grams / 1000).toFixed(2)} kg in all. Prices are rough: shops differ.` }));
  };
  const wiringHtml = () => {
    const img = topView(host);
    return el('div', {},
      img ? el('img', { src: img, className: 'sheet-img', alt: 'The build from above' }) : el('div', { textContent: 'Nothing on the bench.' }),
      el('h3', { textContent: `Connections (${nets.length})` }),
      el('ol', { className: 'sheet-nets' }, ...nets.map((n) => el('li', { textContent: n.join('  ↔  ') }))),
      el('h3', { textContent: `Wires (${p.wires.length})` }),
      el('table', { className: 'sheet-table' },
        el('tr', {}, ...['From', 'To', 'Length'].map((h) => el('th', { textContent: h }))),
        ...p.wires.map((w) => el('tr', {}, el('td', { textContent: `${p.parts.find((x) => x.uid === w.a.uid)?.name} ${w.a.pin}` }), el('td', { textContent: `${p.parts.find((x) => x.uid === w.b.uid)?.name} ${w.b.pin}` }), el('td', { textContent: `${(w.length ?? 10).toFixed(1)} cm` })))));
  };
  let current = tab;
  const show = () => {
    body.replaceChildren(current === 'parts' ? partsHtml() : wiringHtml());
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.t === current));
  };
  const tabs = (['parts', 'wiring'] as const).map((t) => { const b = el('button', { className: 'tab', textContent: t === 'parts' ? 'Parts list' : 'Wiring sheet', onclick: () => { current = t; show(); } }); b.dataset.t = t; return b; });
  const csv = () => current === 'parts'
    ? ['count,part,from,each_usd,grams', ...bom.list.map((r) => `${r.count},"${r.name.replace(/"/g, '""')}",${r.from},${r.each ?? ''},${r.grams.toFixed(0)}`), `${bom.wires},jumper wires,shop,0.05,`].join('\n')
    : ['from,to,length_cm', ...p.wires.map((w) => `"${p.parts.find((x) => x.uid === w.a.uid)?.name} ${w.a.pin}","${p.parts.find((x) => x.uid === w.b.uid)?.name} ${w.b.pin}",${(w.length ?? 10).toFixed(1)}`)].join('\n');
  const win = el('div', { className: 'modal sheet-window' },
    el('div', { className: 'modal-head' },
      el('div', { className: 'modal-title', textContent: `${p.name}: for the real thing` }),
      el('div', { className: 'modal-sub', textContent: 'What to buy, and how it is wired.' }),
      el('button', { className: 'modal-x', textContent: '×', title: 'Close (Esc)', onclick: close })),
    el('div', { className: 'lib-tabs' }, ...tabs),
    body,
    el('div', { className: 'lib-foot' },
      el('button', { textContent: 'Copy', title: 'Copy it as text (spreadsheet-ready)', onclick: async () => { await navigator.clipboard.writeText(csv()); host.log('copied'); } }),
      el('button', { textContent: 'Save as CSV...', onclick: async () => { const { saveText } = await import('../files'); const path = await saveText(`${p.name || 'bench'} ${current === 'parts' ? 'parts' : 'wiring'}.csv`, csv()); if (path) host.log(`saved ${path}`); } }),
      el('span', { style: 'flex:1' }),
      el('button', { textContent: 'Print...', title: 'Print it (or save it as a PDF)', onclick: () => {
        const w = window.open('', '_blank', 'width=900,height=1000');
        if (!w) return host.log('the print window was blocked', 'warn');
        w.document.write(`<!doctype html><title>${p.name}</title><style>body{font:13px sans-serif;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:4px 6px;text-align:left}img{max-width:100%;border:1px solid #ccc}</style><h2>${p.name}</h2>${body.innerHTML}`);
        w.document.close();
        w.focus();
        w.print();
      } })));
  back.append(win);
  document.body.append(back);
  show();
  console.info(`[sheets] ${bom.list.length} kinds of part, ${p.wires.length} wires, ${nets.length} connections`);
}
