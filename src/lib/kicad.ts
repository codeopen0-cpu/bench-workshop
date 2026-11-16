// A KiCad board (.kicad_pcb, KiCad 6-9) as a library part: its outline, its connectors' pins (with
// their net names), the copper joining them, and optionally its look from KiCad's 3D export (.glb:
// File > Export > glTF, or kicad-cli pcb export glb).
import type { PinKind, V3 } from '../parts/types';
import type { LibPart, LibShapeItem } from './format';

type SExp = string | SExp[];

/** Read KiCad's s-expressions: (a b "c d" (e f)) -> ['a', 'b', 'c d', ['e', 'f']] */
export function parseSexp(text: string): SExp {
  let i = 0;
  const n = text.length;
  const stack: SExp[][] = [[]];
  while (i < n) {
    const ch = text[i];
    if (ch === '(') {
      stack.push([]);
      i++;
    } else if (ch === ')') {
      const done = stack.pop()!;
      stack[stack.length - 1].push(done);
      i++;
    } else if (ch === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          s += text[i + 1];
          i += 2;
        } else s += text[i++];
      }
      i++;
      stack[stack.length - 1].push(s);
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') i++;
    else {
      let s = '';
      while (i < n && !' \n\r\t()'.includes(text[i])) s += text[i++];
      stack[stack.length - 1].push(s);
    }
  }
  return stack[0][0] ?? [];
}

const kids = (e: SExp, name: string) => (Array.isArray(e) ? (e.filter((x) => Array.isArray(x) && x[0] === name) as SExp[][]) : []);
const kid = (e: SExp, name: string) => kids(e, name)[0];
const num = (x: SExp | undefined) => Number(x) || 0;

export interface KicadBoard {
  name: string;
  w: number; // mm
  h: number;
  x0: number; // board's top-left on the page, mm
  y0: number;
  thickness: number; // mm
  footprints: { ref: string; value: string; lib: string; x: number; y: number; rot: number; back: boolean; pads: { num: string; net: string; x: number; y: number; tht: boolean; w: number; h: number; type: string; fn: string }[] }[];
}

export function readKicadPcb(text: string, fileName: string): KicadBoard {
  const root = parseSexp(text);
  if (!Array.isArray(root) || root[0] !== 'kicad_pcb') throw new Error("that isn't a KiCad board file (.kicad_pcb)");
  // the outline: everything on Edge.Cuts
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const g of root as SExp[]) {
    if (!Array.isArray(g) || !/^gr_(line|rect|arc|poly|circle)$/.test(String(g[0]))) continue;
    if (kid(g, 'layer')?.[1] !== 'Edge.Cuts') continue;
    for (const k of ['start', 'end', 'mid']) {
      const p = kid(g, k);
      if (p) grow(num(p[1]), num(p[2]));
    }
    if (g[0] === 'gr_circle') {
      const c = kid(g, 'center'), e = kid(g, 'end');
      if (c && e) {
        const r = Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]));
        grow(num(c[1]) - r, num(c[2]) - r);
        grow(num(c[1]) + r, num(c[2]) + r);
      }
    }
    for (const pts of kids(g, 'pts')) for (const xy of kids(pts, 'xy')) grow(num(xy[1]), num(xy[2]));
  }
  const footprints: KicadBoard['footprints'] = [];
  for (const f of [...kids(root, 'footprint'), ...kids(root, 'module')]) {
    const at = kid(f, 'at');
    const fx = num(at?.[1]), fy = num(at?.[2]), rot = num(at?.[3]);
    const props = Object.fromEntries(kids(f, 'property').map((p) => [String(p[1]), String(p[2])]));
    const fpText = Object.fromEntries(kids(f, 'fp_text').map((p) => [String(p[1]), String(p[2])]));
    const ref = props.Reference ?? fpText.reference ?? '?';
    const value = props.Value ?? fpText.value ?? '';
    const back = String(kid(f, 'layer')?.[1] ?? '').startsWith('B.');
    const a = (-rot * Math.PI) / 180; // KiCad turns clockwise on screen (y down)
    const pads = kids(f, 'pad').map((p) => {
      const pat = kid(p, 'at'), size = kid(p, 'size');
      const px = num(pat?.[1]), py = num(pat?.[2]);
      const net = kid(p, 'net');
      return {
        num: String(p[1]),
        net: net ? String(net[2] ?? net[1] ?? '') : '',
        x: fx + px * Math.cos(a) - py * Math.sin(a),
        y: fy + px * Math.sin(a) + py * Math.cos(a),
        tht: p[2] === 'thru_hole',
        w: num(size?.[1]),
        h: num(size?.[2]),
        type: String(kid(p, 'pintype')?.[1] ?? ''), // from the schematic: input, output, power_in, power_out, passive...
        fn: String(kid(p, 'pinfunction')?.[1] ?? ''), // the pin's name on its chip: VCC, EN, SDA...
      };
    });
    for (const p of pads) if (!Number.isFinite(minX)) grow(p.x, p.y);
    footprints.push({ ref, value, lib: String(f[1] ?? ''), x: fx, y: fy, rot, back, pads });
  }
  if (!Number.isFinite(minX)) throw new Error('the board has no outline (Edge.Cuts) and no parts');
  const thick = num(kid(kid(root, 'general') ?? [], 'thickness')?.[1]) || 1.6;
  return { name: fileName.replace(/\.kicad_pcb$/i, ''), w: maxX - minX, h: maxY - minY, x0: minX, y0: minY, thickness: thick, footprints };
}

/** Which footprints become pins on the bench: connectors and headers (J*, P*, CN*, terminal blocks). */
export const isConnector = (f: KicadBoard['footprints'][number]) =>
  /^(J|P|CN|X|CON|TB)\d/i.test(f.ref) || /PinHeader|PinSocket|Connector|TerminalBlock|JST|Molex|USB/i.test(f.lib);

const kindOfNet = (net: string): PinKind => {
  const n = net.replace(/^\//, '').toUpperCase();
  if (/^(GND|AGND|DGND|PGND|VSS|0V)\b/.test(n)) return 'gnd';
  if (/^(SDA|SCL)\d*$/.test(n) || /_(SDA|SCL)$/.test(n)) return 'i2c';
  if (/^\+?\d+V\d*|^VCC|^VDD|^VIN|^VBAT|^VBUS|^VSYS|^V\+/.test(n)) return 'vin';
  return 'io';
};

/** What's wrong in the board's own design, from its pins' types (KiCad copies them from the
 *  schematic): a chip's power pin on ground, a regulator output on ground, two outputs joined, an
 *  enable pin held off, an input left unconnected. */
export function designIssues(b: KicadBoard): { level: 'fault' | 'warn'; what: string }[] {
  const out: { level: 'fault' | 'warn'; what: string }[] = [];
  const nets = new Map<string, { ref: string; num: string; type: string; fn: string }[]>();
  let typed = 0;
  for (const f of b.footprints)
    for (const p of f.pads) {
      if (p.type) typed++;
      if (!p.net) continue;
      if (!nets.has(p.net)) nets.set(p.net, []);
      nets.get(p.net)!.push({ ref: f.ref, num: p.num, type: p.type, fn: p.fn });
    }
  if (!typed) return [{ level: 'warn', what: 'its pads have no pin types (made without a schematic?), so only its connections can be checked, not its design' }];
  const isGnd = (n: string) => /^\/?(GND|AGND|DGND|PGND|VSS|0V|GNDA|GNDD)$/i.test(n);
  const isSupply = (n: string) => /^\/?(\+?\d+(\.\d+)?V\d*|VCC|VDD|VIN|VBUS|VBAT|VSYS|\+3V3|\+5V|3V3)$/i.test(n);
  const pin = (x: { ref: string; num: string; fn: string }) => `${x.ref} pin ${x.num}${x.fn ? ` (${x.fn})` : ''}`;
  for (const [net, pads] of nets) {
    const name = net.replace(/^\//, '');
    for (const x of pads) {
      if (isGnd(net) && x.type === 'power_in' && /^(VCC|VDD|V\+|VIN|AVCC|AVDD|DVDD|VBAT|VS|VIO|VDDIO|IOVDD)/i.test(x.fn)) out.push({ level: 'fault', what: `${pin(x)} is a power input, but it's on ${name}: the chip gets no power` });
      if (isSupply(net) && x.type === 'power_in' && /^(GND|VSS|AGND|DGND|PGND)/i.test(x.fn)) out.push({ level: 'fault', what: `${pin(x)} is a ground pin, but it's on ${name}: that shorts the supply to ground` });
      if (isGnd(net) && x.type === 'power_out') out.push({ level: 'fault', what: `${pin(x)} is a supply output (a regulator's), but it's on ${name}: a short` });
      if (isGnd(net) && x.type === 'input' && /^(~|N|\/)?(EN|ENABLE|CE|RUN|SHDN|ON)\b|^~?\{?(EN|CE|SHDN)/i.test(x.fn) && !/^(~|N|\/)/.test(x.fn)) out.push({ level: 'fault', what: `${pin(x)} enables the chip, but it's tied to ${name}: the chip stays switched off` });
      if (isGnd(net) && /^(~|N|\/)?\{?(RST|RESET|NRST|MCLR)/i.test(x.fn) && /^(~|N|\/)/i.test(x.fn)) out.push({ level: 'fault', what: `${pin(x)} is a reset, active low, tied to ${name}: the chip is held in reset forever` });
    }
    const powerOuts = pads.filter((x) => x.type === 'power_out');
    if (powerOuts.length > 1 && new Set(powerOuts.map((x) => x.ref)).size > 1) out.push({ level: 'fault', what: `two supply outputs are joined on ${name} (${powerOuts.map(pin).join(', ')}): regulators fight` });
    const outs = pads.filter((x) => x.type === 'output');
    if (outs.length > 1 && new Set(outs.map((x) => x.ref)).size > 1) out.push({ level: 'warn', what: `outputs joined on ${name} (${outs.map(pin).join(', ')}): when they disagree it's a short` });
    if (/^unconnected-/i.test(net)) for (const x of pads) if (x.type === 'input') out.push({ level: 'warn', what: `${pin(x)} is an input left unconnected: it floats` });
    if (pads.length === 1 && x0(pads).type === 'power_in') out.push({ level: 'warn', what: `${pin(x0(pads))} (a power input) is connected to nothing` });
    const drivers = pads.filter((x) => /output|power_out|bidirectional|tri_state|passive/.test(x.type));
    if (pads.length > 1 && !drivers.length && pads.every((x) => x.type === 'input') && !isGnd(net) && !isSupply(net)) out.push({ level: 'warn', what: `${name} connects only inputs (${pads.map(pin).join(', ')}): nothing on the board drives it (fine if it comes from a connector)` });
  }
  return out;
}
const x0 = <T>(a: T[]) => a[0];

/** The board as a library part. connectorsOnly: only connector pads become pins (else every through-hole pad). */
export function kicadPart(b: KicadBoard, opts: { id: string; name: string; color: string; connectorsOnly: boolean; glb?: string; description?: string }): LibPart {
  const th = b.thickness / 10; // cm
  const pos = (x: number, y: number, up: number): V3 => [(x - (b.x0 + b.w / 2)) / 10, up, (y - (b.y0 + b.h / 2)) / 10];
  const shape: LibShapeItem[] = [{ box: [b.w / 10, th, b.h / 10], at: [0, th / 2, 0], color: opts.color }];
  const pins: LibPart['pins'] = [];
  const byNet = new Map<string, string[]>();
  for (const f of b.footprints) {
    const conn = isConnector(f);
    const usePads = f.pads.filter((p) => p.num && (opts.connectorsOnly ? conn : p.tht || conn));
    if (!opts.glb) {
      // without the 3D model: a plain block per part, headers for connectors
      const xs = f.pads.map((p) => p.x), ys = f.pads.map((p) => p.y);
      if (xs.length && !f.back) {
        const w = Math.max(1, Math.max(...xs) - Math.min(...xs) + 1.2), h = Math.max(1, Math.max(...ys) - Math.min(...ys) + 1.2);
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        const tall = conn ? 0.25 : 0.12;
        shape.push({ box: [w / 10, tall, h / 10], at: pos(cx, cy, th + tall / 2), color: conn ? '#151618' : '#23252a', collide: false });
      }
    }
    for (const p of usePads) {
      const id = `${f.ref}.${p.num}`;
      const up = th + (conn && p.tht ? 0.6 : 0.05);
      pins.push({ id, label: `${f.ref} pin ${p.num}${p.net ? ` (${p.net.replace(/^\//, '')})` : ''}`, at: pos(p.x, p.y, up), kind: kindOfNet(p.net) });
      if (conn && p.tht && !opts.glb) shape.push({ box: [0.064, 0.6, 0.064], at: pos(p.x, p.y, th + 0.3), color: '#d9b54a', collide: false });
      if (p.net && !/^(unconnected|Net-\()/i.test(p.net)) {
        if (!byNet.has(p.net)) byNet.set(p.net, []);
        byNet.get(p.net)!.push(id);
      }
    }
  }
  // the board's copper: pins on the same net are joined
  const shorts: [string, string][] = [];
  for (const ids of byNet.values()) for (let i = 1; i < ids.length; i++) shorts.push([ids[0], ids[i]]);
  const conns = b.footprints.filter(isConnector).map((f) => f.ref);
  return {
    id: opts.id,
    name: opts.name,
    category: 'My boards',
    description: opts.description ?? `Imported from KiCad (${b.name}.kicad_pcb): ${(b.w / 10).toFixed(1)} x ${(b.h / 10).toFixed(1)} cm, ${pins.length} pins on ${conns.join(', ') || 'its pads'}. Pins on the same net are joined, like its copper.`,
    swatch: opts.color,
    mass: Math.max(2, Math.round((b.w * b.h * b.thickness) / 1000 * 1.9 + b.footprints.length * 0.3)),
    shape,
    glb: opts.glb,
    glbAt: opts.glb ? [-(b.x0 + b.w / 2) / 10, th, -(b.y0 + b.h / 2) / 10] : undefined,
    pins,
    shorts,
    designIssues: designIssues(b),
  };
}
