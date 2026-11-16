// A project: the parts on the bench, what each is glued to, and where. This is what gets saved.
import { PART_BY_ID } from './parts/catalog';
import type { Q4, V3 } from './parts/types';

export interface PartInst {
  uid: string;
  type: string;
  name: string;
  params: Record<string, any>;
  /** Glued to this body of another part (null = loose on the bench). pos/rot are then in that body's frame. */
  parent: { uid: string; body: string } | null;
  pos: V3;
  rot: Q4;
  /** Fixed to the bench: doesn't fall or move (a stand, a wall, a test rig). */
  pinned?: boolean;
}

export interface PinRef {
  uid: string;
  pin: string;
}
export interface Wire {
  id: string;
  a: PinRef;
  b: PinRef;
  color: string;
  /** cable length, cm: it can slacken but never stretch; pulled tight it drags the part at its other end */
  length?: number;
}
export interface Program {
  lang: 'js' | 'arduino'; // JavaScript, or simple Arduino C++ (translated to JavaScript)
  source: string;
  firmware?: string; // rp2040 boards: a .uf2 to run instead, base64
  firmwareName?: string;
}

export interface Project {
  format: 'bench-workshop';
  version: 1;
  name: string;
  parts: PartInst[];
  wires: Wire[];
  programs: Record<string, Program>; // by part uid
  boards?: any[]; // (unused: own boards are libraries now)
  /** the libraries its parts come from (written on save, so whoever opens it knows what to install) */
  libraries?: { id: string; name: string; version: string }[];
  /** the bench's Wi-Fi network, that boards with Wi-Fi join (default: "Workshop" / "bench1234") */
  wifi?: { ssid: string; pass: string };
  /** how bright the room is, 0 (dark) .. 1 (a lit room, the default): light sensors see it */
  room?: number;
  /** gravity as a share of Earth's (default 1): 0.165 the Moon, 0.1 floaty */
  gravity?: number;
}

export const newProject = (name = 'Untitled'): Project => ({ format: 'bench-workshop', version: 1, name, parts: [], wires: [], programs: {}, boards: [] });

let counter = 0;
export function newUid(): string {
  counter++;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

export function uniqueName(project: Project, base: string): string {
  const used = new Set(project.parts.map((p) => p.name));
  for (let i = 1; ; i++) {
    const n = `${base} ${i}`;
    if (!used.has(n)) return n;
  }
}

/** Check a loaded file; returns the problems found (empty = fine). Unknown part types are dropped. */
export function validate(data: any): { project: Project | null; problems: string[] } {
  const problems: string[] = [];
  if (!data || data.format !== 'bench-workshop') return { project: null, problems: ['not a Bench Workshop project file'] };
  if (data.version !== 1) problems.push(`made by a newer version (format ${data.version}); some things may not load`);
  const parts: PartInst[] = [];
  const uids = new Set<string>();
  for (const p of data.parts ?? []) {
    const type = PART_BY_ID.get(p.type);
    if (!type) {
      problems.push(`unknown part type "${p.type}" (${p.name}) left out`);
      continue;
    }
    if (!p.uid || uids.has(p.uid)) p.uid = newUid();
    uids.add(p.uid);
    parts.push({
      uid: p.uid,
      type: p.type,
      name: String(p.name ?? type.name),
      params: { ...type.defaults, ...(p.params ?? {}) },
      parent: p.parent ?? null,
      pos: (p.pos ?? [0, 0, 0]) as V3,
      rot: (p.rot ?? [0, 0, 0, 1]) as Q4,
      pinned: !!p.pinned,
    });
  }
  for (const p of parts)
    if (p.parent && !parts.some((q) => q.uid === p.parent!.uid)) {
      problems.push(`${p.name} was glued to a part that's missing; it's loose now`);
      p.parent = null;
    }
  const wires: Wire[] = [];
  for (const w of data.wires ?? []) {
    if (!w?.a || !w?.b || !uids.has(w.a.uid) || !uids.has(w.b.uid)) {
      problems.push('a wire to a missing part was left out');
      continue;
    }
    wires.push({ id: w.id || newUid(), a: { uid: w.a.uid, pin: String(w.a.pin) }, b: { uid: w.b.uid, pin: String(w.b.pin) }, color: w.color || '#e04848', length: Number(w.length) > 0 ? Number(w.length) : undefined });
  }
  const programs: Record<string, Program> = {};
  for (const [uid, prog] of Object.entries<any>(data.programs ?? {}))
    if (uids.has(uid) && prog && typeof prog.source === 'string')
      programs[uid] = { lang: prog.lang === 'arduino' ? 'arduino' : 'js', source: prog.source, firmware: prog.firmware, firmwareName: prog.firmwareName };
  return {
    project: { format: 'bench-workshop', version: 1, name: String(data.name ?? 'Untitled'), parts, wires, programs, boards: Array.isArray(data.boards) ? data.boards : [],
      wifi: data.wifi && typeof data.wifi.ssid === 'string' ? { ssid: String(data.wifi.ssid).slice(0, 32), pass: String(data.wifi.pass ?? '').slice(0, 63) } : undefined,
      room: typeof data.room === 'number' && data.room >= 0 && data.room <= 1 ? data.room : undefined,
      gravity: typeof data.gravity === 'number' && data.gravity >= 0 && data.gravity <= 3 ? data.gravity : undefined },
    problems,
  };
}

/** Parts in an order where every parent comes before what is glued to it. */
export function parentFirst(parts: PartInst[]): PartInst[] {
  const byUid = new Map(parts.map((p) => [p.uid, p]));
  const out: PartInst[] = [];
  const seen = new Set<string>();
  const visit = (p: PartInst, stack: Set<string>) => {
    if (seen.has(p.uid)) return;
    if (stack.has(p.uid)) {
      p.parent = null; // a glue loop can't exist; break it
      return;
    }
    stack.add(p.uid);
    if (p.parent) {
      const q = byUid.get(p.parent.uid);
      if (q) visit(q, stack);
      else p.parent = null;
    }
    seen.add(p.uid);
    out.push(p);
  };
  for (const p of parts) visit(p, new Set());
  return out;
}

/** Everything glued (directly or not) to part `uid`, the part itself included. */
export function subtree(parts: PartInst[], uid: string): Set<string> {
  const out = new Set([uid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parts)
      if (p.parent && out.has(p.parent.uid) && !out.has(p.uid)) {
        out.add(p.uid);
        grew = true;
      }
  }
  return out;
}

/** A new wire's length: the distance between its pins plus some slack, rounded up to half a cm. */
export const wireLengthFor = (dist: number) => Math.ceil((dist * 1.15 + 1.5) * 2) / 2;
