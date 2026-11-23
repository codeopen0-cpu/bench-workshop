// What power sources do in a run. A battery's voltage = its cells' voltage at their charge, minus
// what its internal resistance loses at the current drawn (so a 9 V battery or a coin cell sags under
// a motor), and the charge goes down with the current over time. A bench supply holds its voltage up
// to its current limit, then lowers it (constant current). A power bank cuts out when overloaded.
import { CHEM, rateFactor } from '../parts/power';
import type { PartView } from '../views';
import type { Circuit, Device } from './circuit';
import { name, type DeviceHooks, type DeviceMaker } from './devices';

/** what everything on this source's + net draws, by their own estimates (A) */
function loadOf(c: Circuit, self: Device, uid: string) {
  const net = c.net(uid, '+');
  if (!net) return 0;
  let a = 0;
  for (const d of c.devices) if (d !== self && d.current && net.pins.some((k) => k.startsWith(d.view.inst.uid + '/'))) a += d.current();
  return a;
}
const hm = (h: number) => (h > 99 ? '99+ h' : h >= 1 ? `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min` : `${Math.round(h * 60)} min`);

interface Spec { chem: string; cells: number; mAh: number; maxA?: number; cutoff?: boolean; regulated?: number }

function batteryDevice(v: PartView, spec: Spec, hooks?: DeviceHooks): Device {
  const uid = v.inst.uid;
  const ch = CHEM[spec.chem] ?? CHEM.alkaline;
  let soc = Math.max(0, Math.min(1, Number(v.inst.params.charge ?? 100) / 100));
  let amps = 0, volts = 0, off = false;
  // (over the run: the current its cells gave, and for how long: what it averages, so how long a full
  // charge lasts doing this; a regulated pack's 5 V out comes from its cells at their voltage)
  let cellAs = 0, outAs = 0, secs = 0, peak = 0;
  const cellAmps = (out: number) => (spec.regulated ? (out * spec.regulated) / (3.7 * 0.9) : out);
  /** hours a full charge lasts at this cell current (less at big currents: rateFactor) */
  const hoursAt = (cell: number) => (cell > 1e-6 ? ((spec.mAh / 1000) * rateFactor(ch, cell)) / cell : Infinity);
  const life = () => {
    if (secs < 1 || cellAs / secs < 0.0005) return null;
    const avgCell = cellAs / secs;
    return { avgOut: outAs / secs, hours: hoursAt(avgCell), mAh: Math.round(spec.mAh * rateFactor(ch, avgCell)) };
  };
  const dev: Device = {
    view: v,
    drive(c) {
      const open = spec.cells * ch.curve(Math.max(0, soc));
      volts = off || soc <= 0 ? 0 : spec.regulated ?? Math.max(0, open - amps * ch.ohms * spec.cells);
      c.drive(uid, '+', { v: volts, strength: 2, src: `${name(v)} +` });
      c.drive(uid, '-', { v: 0, strength: 3, src: `${name(v)} -` });
    },
    sense(c, dt) {
      amps = loadOf(c, dev, uid);
      if (off) return;
      // (a regulated pack's 5 V out comes from its cells at their voltage: more current inside)
      const inside = cellAmps(amps);
      // (a big current gets less out of it: it drains its charge faster than the current alone says)
      soc -= (inside * dt) / 3600 / ((spec.mAh / 1000) * rateFactor(ch, inside));
      cellAs += inside * dt;
      outAs += amps * dt;
      secs += dt;
      peak = Math.max(peak, amps);
      if (spec.maxA && amps > spec.maxA) {
        if (spec.cutoff) {
          off = true;
          c.warnOnce(`over:${uid}`, `${name(v)} switched itself off: the parts draw ${amps.toFixed(2)} A, more than its ${spec.maxA} A`, 'bad');
        } else {
          const sag = Math.max(0, spec.cells * ch.curve(Math.max(0, soc)) - amps * ch.ohms * spec.cells);
          c.warnOnce(`over:${uid}`, `${name(v)} can give about ${spec.maxA} A, but the parts draw ${amps.toFixed(2)} A: its voltage sags to about ${sag.toFixed(1)} V`);
        }
      }
      if (soc < 0.1 && soc > 0) c.warnOnce(`low:${uid}`, `${name(v)} is nearly flat (${Math.round(soc * 100)}%)`);
      if (soc <= 0) c.warnOnce(`flat:${uid}`, `${name(v)} is flat: no more power`, 'bad');
    },
    status: () => {
      if (off) return ['switched off (overloaded): stop and start the run to reset it'];
      if (soc <= 0) return ['flat'];
      const l = life();
      // (time left: at the run's average so far, steadier than at this moment's draw)
      const left = l ? soc * l.hours : amps > 0.0005 ? soc * hoursAt(cellAmps(amps)) : Infinity;
      return [
        `${volts.toFixed(2)} V`, `${(amps * 1000).toFixed(0)} mA`,
        `${(soc * 100).toFixed(soc < 0.1 ? 1 : 0)}% charged${Number.isFinite(left) ? `, about ${hm(left)} left` : ''}`,
        ...(l ? [`averaging ${(l.avgOut * 1000).toFixed(0)} mA: a full charge lasts about ${hm(l.hours)}`] : []),
      ];
    },
    dispose() {
      const l = life();
      if (!l || !hooks) return;
      hooks.log(`${name(v)}: the parts averaged ${(l.avgOut * 1000).toFixed(0)} mA over ${secs.toFixed(0)} s (peak ${peak.toFixed(2)} A). Doing that, a full charge lasts about ${hm(l.hours)}${l.mAh < spec.mAh * 0.95 ? ` (at that current it gives about ${l.mAh} of its ${spec.mAh} mAh)` : ''}.`);
    },
    controls: () => [{ label: 'Charge (%)', min: 0, max: 100, step: 1, get: () => Math.round(soc * 100), set: (x) => { soc = x / 100; off = false; } }],
    power: () => ({ volts, amps, maxA: spec.maxA, open: off || soc <= 0 ? 0 : spec.regulated ?? spec.cells * ch.curve(Math.max(0, soc)) }),
    // (for scripted tests and the API: the run's average and how long a full charge lasts at it)
    life: () => { const l = life(); return l ? { avgA: l.avgOut, hours: l.hours, mAh: l.mAh, peakA: peak, secs } : null; },
  } as Device;
  return dev;
}

function benchSupplyDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const set = () => Number(v.inst.params.volts ?? 5);
  const limit = () => Math.max(0.01, Number(v.inst.params.amps ?? 1));
  let amps = 0, volts = 0, cc = false;
  const dev: Device = {
    view: v,
    drive(c) {
      // constant voltage up to the limit; past it, the voltage at which the load draws exactly the
      // limit (the load seen as a resistance, V / I, from the last step), eased in so it settles
      const want = set();
      const target = amps > 1e-4 && volts > 0 ? Math.min(want, limit() * (volts / amps)) : want;
      volts = volts > 0 ? volts + (target - volts) * 0.3 : target;
      cc = volts < want - 0.05;
      c.drive(uid, '+', { v: volts, strength: 2, src: `${name(v)} +` });
      c.drive(uid, '-', { v: 0, strength: 3, src: `${name(v)} -` });
    },
    sense(c) {
      amps = loadOf(c, dev, uid);
      if (cc) c.warnOnce(`cc:${uid}`, `${name(v)} hit its ${limit()} A current limit: it lowered its voltage to ${volts.toFixed(2)} V (CC). Raise the limit, or find what draws so much.`);
    },
    status: () => [`${volts.toFixed(2)} V`, `${amps.toFixed(3)} A`, cc ? 'CC (current limit)' : 'CV'],
    power: () => ({ volts, amps, maxA: limit(), open: set() }),
  };
  return dev;
}

export const POWER_DEVICES: Record<string, DeviceMaker> = {
  'battery-4aa': (v, h) => batteryDevice(v, { chem: v.inst.params.cells ?? 'alkaline', cells: Number(v.inst.params.count ?? 4) || 4, mAh: CHEM[v.inst.params.cells ?? 'alkaline']?.mAh ?? 2500, maxA: 3 }, h),
  'battery-9v': (v, h) => batteryDevice(v, { chem: 'alk9v', cells: 6, mAh: 550, maxA: 0.5 }, h),
  'battery-cr2032': (v, h) => batteryDevice(v, { chem: 'coin', cells: 1, mAh: 220, maxA: 0.015 }, h),
  'battery-18650': (v, h) => batteryDevice(v, { chem: 'liion', cells: Number(v.inst.params.count ?? 1) || 1, mAh: 3000, maxA: 10 }, h),
  'battery-lipo': (v, h) => batteryDevice(v, { chem: 'lipo', cells: Number(v.inst.params.cells ?? 2) || 2, mAh: Number(v.inst.params.mAh ?? 1500) || 1500, maxA: (Number(v.inst.params.mAh ?? 1500) / 1000) * 25 }, h),
  'power-bank': (v, h) => batteryDevice(v, { chem: 'liion', cells: 1, mAh: 10000, maxA: 2.1, cutoff: true, regulated: 5.1 }, h),
  'bench-supply': (v) => benchSupplyDevice(v),
};
