// The circuit check: reads the wiring (without running anything) and finds what would go wrong on
// a real bench. "fault" = it IS broken (a short, a reversed supply, too many volts on a part, a motor
// on a GPIO pin); "warn" = it looks wrong but may be meant (nothing powers a part, an input nothing
// drives). Run it again after a change: what went away shows as fixed.
import type { PinDef } from '../parts/types';
import { boardPinIssues } from './boardpins';
import type { Project } from '../project';
import type { PartView } from '../views';

export interface Issue {
  key: string; // stable, to tell "fixed" apart from "still there"
  level: 'fault' | 'warn';
  what: string;
  parts: string[]; // uids involved (click to select)
}

interface PinAt { uid: string; pin: PinDef; view: PartView }

/** the voltage a power source's + gives (nominal full), or a board's supply pin; null = not a source */
function sourceVolts(v: PartView, pin: PinDef): number | null {
  const p = v.inst.params;
  if (pin.kind !== 'vout') return null;
  switch (v.inst.type) {
    case 'battery-4aa': return (Number(p.count ?? 4) || 4) * (p.cells === 'nimh' ? 1.3 : p.cells === 'lithiumAA' ? 1.75 : 1.6);
    case 'battery-9v': return 9.6;
    case 'battery-cr2032': return 3.05;
    case 'battery-18650': return 4.2 * (Number(p.count ?? 1) || 1);
    case 'battery-lipo': return 4.2 * (Number(p.cells ?? 2) || 2);
    case 'power-bank': return 5.1;
    case 'bench-supply': return Number(p.volts ?? 5);
  }
  const id = `${pin.id} ${pin.label ?? ''}`.toUpperCase();
  if (/3V3|3\.3/.test(id)) return 3.3;
  if (/\b5V\b|VBUS|\+5/.test(id)) return 5;
  const m = /\+?(\d+(?:\.\d+)?)V/.exec(id);
  return m ? Number(m[1]) : null;
}
const isPowerPart = (v: PartView) => /^(battery-|power-bank|bench-supply)/.test(v.inst.type);
const busName = (p: PinDef) => {
  const s = `${p.id} ${p.label ?? ''}`.toUpperCase();
  return /\bSDA\b/.test(s) ? 'SDA' : /\bSCL\b/.test(s) ? 'SCL' : null;
};

export function checkCircuit(project: Project, views: Map<string, PartView>, programmableTypes: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], key: string, what: string, parts: string[]) => {
    if (!issues.some((i) => i.key === key)) issues.push({ key, level, what, parts: [...new Set(parts)] });
  };
  // ---- nets: wires, plus the copper inside parts (every board's GND pins are one net; a library
  //      part's declared shorts)
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const pins = new Map<string, PinAt>();
  for (const v of views.values()) {
    const grounds: string[] = [];
    for (const p of v.build.pins ?? []) {
      const k = `${v.inst.uid}/${p.id}`;
      pins.set(k, { uid: v.inst.uid, pin: p, view: v });
      find(k);
      if (p.kind === 'gnd') grounds.push(k);
    }
    for (let i = 1; i < grounds.length; i++) union(grounds[0], grounds[i]);
    for (const [a, b] of ((v.build as any).shorts ?? []) as [string, string][]) union(`${v.inst.uid}/${a}`, `${v.inst.uid}/${b}`);
  }
  for (const w of project.wires) union(`${w.a.uid}/${w.a.pin}`, `${w.b.uid}/${w.b.pin}`);
  const nets = new Map<string, PinAt[]>();
  for (const [k, p] of pins) {
    const r = find(k);
    if (!nets.has(r)) nets.set(r, []);
    nets.get(r)!.push(p);
  }
  const wired = new Set(project.wires.flatMap((w) => [`${w.a.uid}/${w.a.pin}`, `${w.b.uid}/${w.b.pin}`]));
  const nm = (p: PinAt) => `${p.view.inst.name} ${p.pin.label ?? p.pin.id}`;
  const netOf = (uid: string, pin: string) => nets.get(find(`${uid}/${pin}`)) ?? [];

  for (const [, net] of nets) {
    const sources = net.map((p) => ({ p, v: sourceVolts(p.view, p.pin) })).filter((s) => s.v !== null) as { p: PinAt; v: number }[];
    const grounds = net.filter((p) => p.pin.kind === 'gnd');
    const multi = new Set(net.map((p) => p.uid)).size > 1;
    // 1. a supply wired straight to ground
    for (const s of sources) {
      const g = grounds.find((x) => x.uid !== s.p.uid || isPowerPart(s.p.view));
      if (!g) continue;
      const reversed = g.uid !== s.p.uid && net.length >= 2;
      add('fault', `short:${s.p.uid}/${s.p.pin.id}`,
        reversed && !isPowerPart(g.view)
          ? `Short circuit: ${nm(s.p)} (${s.v} V) goes to ${nm(g)}, which is ground. If ${g.view.inst.name}'s power wires are swapped, swap them back; otherwise the supply is shorted (it gets hot, the battery drains or the fuse blows).`
          : `Short circuit: ${nm(s.p)} (${s.v} V) is wired straight to ground (${nm(g)}).`,
        [s.p.uid, g.uid]);
    }
    // 2. two supplies on one net
    for (let i = 0; i < sources.length; i++)
      for (let j = i + 1; j < sources.length; j++) {
        const a = sources[i], b = sources[j];
        if (a.p.uid === b.p.uid) continue;
        if (Math.abs(a.v - b.v) > 0.3) add('fault', `fight:${a.p.uid}/${a.p.pin.id}:${b.p.uid}/${b.p.pin.id}`, `Two supplies wired together: ${nm(a.p)} (${a.v} V) and ${nm(b.p)} (${b.v} V). The higher one forces current into the lower one: something gets hot. Use one supply, or join only their grounds.`, [a.p.uid, b.p.uid]);
        else add('warn', `parallel:${a.p.uid}:${b.p.uid}`, `${nm(a.p)} and ${nm(b.p)} are two supplies in parallel. Real ones don't share evenly; usually one supply per circuit, with grounds joined.`, [a.p.uid, b.p.uid]);
      }
    const top = sources.length ? Math.max(...sources.map((s) => s.v)) : null;
    for (const p of net) {
      // 3. too many volts on a part's supply input
      if (top !== null && p.pin.kind === 'vin' && p.pin.vmax !== undefined && top > p.pin.vmax + 0.05)
        add('fault', `burn:${p.uid}/${p.pin.id}`, `Too many volts: ${nm(p)} takes ${p.pin.vmin ?? 0}-${p.pin.vmax} V, but it's wired to ${top.toFixed(1)} V (${sources.find((s) => s.v === top)!.p.view.inst.name}). It would burn out.`, [p.uid, sources.find((s) => s.v === top)!.p.uid]);
      if (top !== null && p.pin.kind === 'vin' && p.pin.vmin !== undefined && top < p.pin.vmin - 0.05)
        add('warn', `low:${p.uid}/${p.pin.id}`, `Not enough volts: ${nm(p)} needs at least ${p.pin.vmin} V, but its supply gives ${top.toFixed(1)} V.`, [p.uid]);
      // GPIO / signal pins on a supply above what logic takes
      // (only parts with their own supply pin: an LED or a buzzer is meant to sit on a supply)
      const hasVin = (p.view.build.pins ?? []).some((q) => q.kind === 'vin') || programmableTypes.has(p.view.inst.type);
      if (top !== null && hasVin && (p.pin.kind === 'io' || p.pin.kind === 'in') && top > (programmableTypes.has(p.view.inst.type) ? 3.6 : 5.5))
        add('fault', `logic:${p.uid}/${p.pin.id}`, `${nm(p)} is a signal pin, wired to a ${top.toFixed(1)} V supply: ${programmableTypes.has(p.view.inst.type) ? "this board's pins take 3.3 V" : 'signal pins take up to 5 V'}. It would be damaged.`, [p.uid]);
      // 4. a part's power input wired to ground
      if (p.pin.kind === 'vin' && grounds.some((g) => g.uid !== p.uid))
        add('fault', `vin-gnd:${p.uid}/${p.pin.id}`, `${nm(p)} (its power input) is wired to ground: it never gets power, and whatever supplies it is shorted.`, [p.uid, ...grounds.map((g) => g.uid)]);
    }
    // 5. a motor straight on a GPIO pin
    const motor = net.find((p) => p.pin.kind === 'motor' && /^motor/.test(p.view.inst.type));
    const gpio = net.find((p) => p.pin.kind === 'io' && programmableTypes.has(p.view.inst.type));
    if (motor && gpio) add('fault', `motor-gpio:${motor.uid}:${gpio.uid}`, `${nm(motor)} is wired straight to ${nm(gpio)}. A GPIO pin gives ~20 mA; a motor needs hundreds: the pin can't turn it, and the motor's spikes can kill the pin. Put a motor driver (DRV8833) between them.`, [motor.uid, gpio.uid]);
    // 6. SDA joined to SCL
    const sda = net.find((p) => busName(p.pin) === 'SDA'), scl = net.find((p) => busName(p.pin) === 'SCL');
    if (sda && scl) add('fault', `i2c-swap:${sda.uid}/${sda.pin.id}:${scl.uid}/${scl.pin.id}`, `${nm(sda)} is wired to ${nm(scl)}: SDA goes to SDA and SCL to SCL (they're swapped, or joined).`, [sda.uid, scl.uid]);
    // 7. two signal outputs fighting
    const outs = net.filter((p) => p.pin.kind === 'out' && !/^(button|knob)$/.test(p.view.inst.type));
    if (outs.length > 1 && new Set(outs.map((o) => o.uid)).size > 1) add('warn', `outs:${outs.map((o) => `${o.uid}/${o.pin.id}`).join(':')}`, `Two outputs drive the same wire: ${outs.map(nm).join(' and ')}. When they disagree, it's a short.`, outs.map((o) => o.uid));
    void multi;
  }

  // 8. parts in use with no power, or no ground back to their supply
  for (const v of views.values()) {
    const ps = v.build.pins ?? [];
    const used = ps.some((p) => wired.has(`${v.inst.uid}/${p.id}`));
    if (!used || isPowerPart(v)) continue;
    const vins = ps.filter((p) => p.kind === 'vin');
    const selfPowered = v.inst.params.usb === true;
    if (vins.length && !selfPowered) {
      // (a board on USB gives 5 V on its 5V / VBUS pin, too)
      const usb5 = (q: PinAt) => q.pin.kind === 'vin' && programmableTypes.has(q.view.inst.type) && q.view.inst.params.usb === true && /5V|VBUS/i.test(`${q.pin.id} ${q.pin.label ?? ''}`);
      const fed = vins.some((p) => netOf(v.inst.uid, p.id).some((q) => q.uid !== v.inst.uid && (sourceVolts(q.view, q.pin) !== null || q.pin.kind === 'vout' || usb5(q))));
      if (!fed) add('warn', `nopower:${v.inst.uid}`, `${v.inst.name} has no power: wire its ${vins.map((p) => p.label ?? p.id).join(' / ')} to a supply (and its GND to the supply's ground).`, [v.inst.uid]);
      const gnd = ps.find((p) => p.kind === 'gnd');
      if (fed && gnd && !netOf(v.inst.uid, gnd.id).some((q) => q.uid !== v.inst.uid)) add('warn', `nognd:${v.inst.uid}`, `${v.inst.name}'s GND isn't wired: without a ground back to the supply, no current flows and it stays off.`, [v.inst.uid]);
    }
    // inputs nothing drives (only on parts that are wired up)
    for (const p of ps)
      if (p.kind === 'in' && !p.pulled && !netOf(v.inst.uid, p.id).some((q) => q.uid !== v.inst.uid))
        add('warn', `float:${v.inst.uid}/${p.id}`, `${nm({ uid: v.inst.uid, pin: p, view: v })} isn't connected: an input left floating reads random values (wire it, or tie it to GND or the supply).`, [v.inst.uid]);
  }

  // 9. what was found inside imported boards (KiCad: pin types on the board's own nets)
  for (const v of views.values())
    for (const d of ((v.build as any).designIssues ?? []) as { level: Issue['level']; what: string }[])
      add(d.level, `design:${v.inst.type}:${d.what}`, `${v.inst.name} (its own board design): ${d.what}`, [v.inst.uid]);

  // 10. what works here but not on the real board: its special pins (boardpins.ts)
  boardPinIssues(project, views, netOf, sourceVolts, programmableTypes, isPowerPart, add);

  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fault' ? -1 : 1));
  return issues;
}
