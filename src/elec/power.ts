// What power sources do in a run. A battery's voltage = its cells' voltage at their charge, minus
// what its internal resistance loses at the current drawn (so a 9 V battery or a coin cell sags under
// a motor), and the charge goes down with the current over time. A bench supply holds its voltage up
// to its current limit, then lowers it (constant current). A power bank cuts out when overloaded.
import { CHEM } from '../parts/power';
import type { PartView } from '../views';
import type { Circuit, Device } from './circuit';
import { name, type DeviceMaker } from './devices';

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

function batteryDevice(v: PartView, spec: Spec): Device {
  const uid = v.inst.uid;
  const ch = CHEM[spec.chem] ?? CHEM.alkaline;
  let soc = Math.max(0, Math.min(1, Number(v.inst.params.charge ?? 100) / 100));
  let amps = 0, volts = 0, off = false;
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
      const inside = spec.regulated ? (amps * spec.regulated) / (3.7 * 0.9) : amps;
      soc -= (inside * dt) / 3600 / (spec.mAh / 1000);
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
      const left = amps > 0.0005 ? (soc * spec.mAh) / 1000 / (spec.regulated ? (amps * spec.regulated) / 3.33 : amps) : Infinity;
      return [`${volts.toFixed(2)} V`, `${(amps * 1000).toFixed(0)} mA`, `${(soc * 100).toFixed(soc < 0.1 ? 1 : 0)}% charged${Number.isFinite(left) ? `, ${hm(left)} left at this draw` : ''}`];
    },
    controls: () => [{ label: 'Charge (%)', min: 0, max: 100, step: 1, get: () => Math.round(soc * 100), set: (x) => { soc = x / 100; off = false; } }],
  };
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
  };
  return dev;
}

export const POWER_DEVICES: Record<string, DeviceMaker> = {
  'battery-4aa': (v) => batteryDevice(v, { chem: v.inst.params.cells ?? 'alkaline', cells: Number(v.inst.params.count ?? 4) || 4, mAh: CHEM[v.inst.params.cells ?? 'alkaline']?.mAh ?? 2500, maxA: 3 }),
  'battery-9v': (v) => batteryDevice(v, { chem: 'alk9v', cells: 6, mAh: 550, maxA: 0.5 }),
  'battery-cr2032': (v) => batteryDevice(v, { chem: 'coin', cells: 1, mAh: 220, maxA: 0.015 }),
  'battery-18650': (v) => batteryDevice(v, { chem: 'liion', cells: Number(v.inst.params.count ?? 1) || 1, mAh: 3000, maxA: 10 }),
  'battery-lipo': (v) => batteryDevice(v, { chem: 'lipo', cells: Number(v.inst.params.cells ?? 2) || 2, mAh: Number(v.inst.params.mAh ?? 1500) || 1500, maxA: (Number(v.inst.params.mAh ?? 1500) / 1000) * 25 }),
  'power-bank': (v) => batteryDevice(v, { chem: 'liion', cells: 1, mAh: 10000, maxA: 2.1, cutoff: true, regulated: 5.1 }),
  'bench-supply': (v) => benchSupplyDevice(v),
};
