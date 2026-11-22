// Libraries: add-on packs of parts (an LED matrix, an LCD, someone's own board...) that are not part
// of the app itself. A library is one JSON file (.benchlib):
//   - parts, described as DATA: shapes, pins, screens, internal copper (and optionally a 3D model)
//   - optionally CODE for what its parts do (runs in a sealed-off worker: lib/worker.ts)
//   - optionally SKETCH code: Arduino-style libraries a program can #include (e.g. LedControl.h)
// This file: the format, checking a library someone downloaded, and turning its parts into part types.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxMesh, cylMesh, group, headerRow, mesh } from '../parts/geo';
import type { BodyDef, JointDef, ParamDef, PartType, PinDef, PinKind, V3 } from '../parts/types';
import { glbFromBase64 } from '../kit/netboard';

export const LIB_FORMAT = 'bench-library';
export const LIB_FORMAT_VERSION = 1;
const P = 0.254; // 0.1 inch, cm

export interface LibShapeItem {
  box?: V3; // w, h, d (cm)
  cyl?: [number, number]; // radius, height (along Y)
  sphere?: number; // radius
  header?: { n: number; pitch?: number; dir?: 'x' | 'z' }; // a row of header pins (first pin at `at`)
  screen?: LibScreen;
  camera?: LibCamera;
  ranger?: LibRanger;
  /** a light sensor's eye: the part's code reads how bright it is there (part.light(id)) */
  light?: LibLight;
  /** this solid piece senses touch: the part's code reads what presses on it (part.touch(id)) */
  touch?: string;
  /** a 3D model's look (an imported .stl): base64 of its corner points (Float32, x y z in cm) and of
   *  its triangles (Uint32, three corner numbers each). Only drawn: `hull` pieces are its solid shape. */
  model?: { v: string; i: string };
  /** a convex solid piece: its corner points (x, y, z, x, y, z... cm) and its volume (cm^3). Not drawn.
   *  A model's physical shape is a few of these (holes and hollows stay open). Needs app 0.5.0. */
  hull?: { p: number[]; vol: number };
  at?: V3; // centre (header: first pin's base)
  rot?: V3; // degrees, XYZ
  color?: string;
  collide?: boolean; // part of its physical shape (default: yes for box / cyl / sphere / hull)
}
export interface LibScreen {
  id: string;
  size: [number, number]; // w, d (cm): a flat panel facing up
  px: [number, number]; // columns, rows: pixels, or characters in text mode
  /** pixels: on/off or a CSS colour each; text: characters; rgb: a colour number (0xRRGGBB) each, for
   *  big full-colour screens (TFTs) */
  mode?: 'pixels' | 'text' | 'rgb';
  on?: string; // lit colour (pixels) / text colour
  off?: string; // unlit pixel colour
  bg?: string; // panel colour
  dots?: boolean; // pixels drawn as round LED dots (default) or, false, as square pixels (an image)
}
/** A camera: the part's code gets pictures of the bench from here (part.camera(id) in device.js). */
export interface LibCamera {
  id: string;
  px: [number, number]; // width, height of its pictures (at most 160 x 120)
  fov?: number; // degrees, top to bottom (default 60)
  look?: V3; // which way it looks, in the part's frame (default [1, 0, 0]: along +x)
  range?: number; // how far it sees, cm (default 500)
}
/** A distance sensor's beam: the part's code reads how far the first thing along it is (part.ranger(id)). */
export interface LibRanger {
  id: string;
  look?: V3; // which way, in the part's frame (default [1, 0, 0])
  max?: number; // cm it can see (default 400; at most 1000)
}
/** A light sensor's eye: how much light reaches it from where it looks (lux). */
export interface LibLight {
  id: string;
  look?: V3; // which way, in the part's frame (default [0, 1, 0]: up)
  fov?: number; // how wide it sees, degrees (default 90)
}
/** A piece of the part that moves: a shaft, a horn, a slider, a wheel. It is joined to the part's
 *  main body by a joint, turning about (or sliding along) `axis` through `at`. */
export interface LibMoving {
  id: string; // its name: other parts can be glued to it ("shaft")
  mass: number; // g
  shape: LibShapeItem[];
  joint: {
    type?: 'turn' | 'slide';
    at: V3;
    axis: V3;
    /** servo: goes to an angle (position); motor: spins with a power; stepper: goes to an angle any
     *  number of turns away; free: no motor (a hinge, an axle, a knob) */
    motor?: 'servo' | 'motor' | 'stepper' | 'free';
    torque?: number; // kg*cm at `volts` (turn); free: its friction (default 0.02)
    force?: number; // N at `volts` (slide)
    speed?: number; // rpm with no load (turn), cm/s (slide)
    volts?: number; // rated voltage (default 5)
    min?: number; // travel: degrees (turn) or cm (slide)
    max?: number;
    /** servo only: it turns any number of turns to the angle it's told (a winch servo, a smart servo):
     *  part.motor(id).to(720) is two turns round. Needs app 0.4.3. */
    multiturn?: boolean;
  };
}
/** A control in the run panel for the part's code: a slider, a button, a switch, a text box, keys. */
export interface LibControl {
  id: string;
  kind: 'slider' | 'button' | 'switch' | 'text' | 'keys';
  label: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number | boolean;
  keys?: string[]; // keys: their labels (a keypad's 1 2 3 A ...)
  cols?: number; // keys: how many in a row
}
/** What the app allows a library part (checked when installing; enforced while running). */
export const LIB_LIMITS = {
  movingPerPart: 8,
  torque: 300, // kg*cm
  force: 2000, // N
  rpm: 30000,
  slideSpeed: 500, // cm/s
  travel: 100, // cm
  controls: 32,
  keys: 64,
  rangers: 4,
  range: 1000, // cm
  touches: 8,
  lights: 4,
  voices: 2, // sounds at once, per part
};
export interface LibPin {
  id: string;
  on?: string; // the moving piece it's on (default: the main body)
  label?: string;
  at: V3;
  kind?: PinKind;
  analog?: boolean;
  vmin?: number;
  vmax?: number;
  pulled?: 'up' | 'down'; // a resistor on the part holds it: fine unwired (the circuit check knows)
}
export interface LibPinRow {
  ids: string[];
  at: V3; // the first pin's header base
  dir?: 'x' | 'z';
  pitch?: number;
  kinds?: Record<string, PinKind>;
  extra?: Record<string, Partial<LibPin>>;
  header?: boolean; // draw a header for them (default yes)
}
export interface LibPart {
  id: string;
  name: string;
  category?: string;
  description?: string;
  swatch?: string;
  mass: number; // g
  params?: ParamDef[];
  defaults?: Record<string, number | string | boolean>;
  shape: LibShapeItem[];
  glb?: string; // base64 .glb (a KiCad 3D export, say): metres, Y up
  glbAt?: V3; // where its origin goes (cm)
  pins?: LibPin[];
  pinRows?: LibPinRow[];
  /** pins joined inside the part (a board's copper: GND to GND2...) */
  shorts?: [string, string][];
  /** problems found in the part's own design (a KiCad import's pin-type check), shown by Check */
  designIssues?: { level: 'fault' | 'warn'; what: string }[];
  /** what it does: a device registered by the library's code */
  device?: string;
  /** pieces that move (joined to the main body) */
  moving?: LibMoving[];
  /** controls in the run panel (for buttons, knobs, keypads, a sensor's reading you set by hand) */
  controls?: LibControl[];
  /** it can make sounds (a buzzer, a speaker): part.sound() in its code */
  sound?: boolean;
  /** an SPI chip on these pins: its code's spi.transfer(bytes, pins) answers the board's SPI transfers
   *  while its CS pin is low */
  spi?: { sck: string; mosi: string; miso?: string; cs: string };
  /** it hears sounds on the bench (a microphone): part.hear() in its code */
  hear?: boolean;
  /** a microcontroller board running Arduino-style sketches written in the app */
  sketch?: { pins: Record<string, number>; analog?: string[]; logicV?: number; power: { vin: string; gnd: string; min: number; max: number }; usb?: boolean; builtinLed?: number };
}
export interface LibSketchFile {
  classes?: string[]; // class names a program declares like C++ objects: "LedControl lc(12, 11, 10, 1);"
  exports?: string[]; // other names a program uses: constants and functions ("NEO_GRB", "makeKeymap")
  /** what the real header #defines that programs test with #if ({ "OV2640_MINI_2MP": 1 }) */
  defines?: Record<string, number>;
  code: string; // JavaScript, run inside the program's thread (it sees the Arduino API)
}
export interface Library {
  format: typeof LIB_FORMAT;
  formatVersion: number;
  id: string; // lowercase-with-dashes
  name: string;
  version: string; // 1.2.3
  author: string;
  /** the GitHub account it belongs to: only they (or the list's maintainer) can change it on the list */
  owner?: string;
  description: string;
  category?: string;
  homepage?: string;
  parts: LibPart[];
  code?: string;
  sketch?: Record<string, LibSketchFile>; // by #include name: "LedControl.h"
  /** ready-wired benches showing (and testing) its parts: opened from the Libraries window */
  examples?: { name: string; description?: string; project: any }[];
  /** the oldest Bench Workshop it works in (its parts use something newer apps added, like cameras) */
  needsApp?: string;
}
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const older = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
};

/** Check a library file; it comes from somewhere else, so nothing in it is trusted to be well-formed. */
export function checkLibrary(raw: any): { lib: Library | null; problems: string[] } {
  const problems: string[] = [];
  const bad = (m: string) => ({ lib: null, problems: [...problems, m] });
  if (!raw || typeof raw !== 'object') return bad('not a library file');
  if (raw.format !== LIB_FORMAT) return bad('not a Bench Workshop library (format is not "bench-library")');
  if (Number(raw.formatVersion) > LIB_FORMAT_VERSION) return bad(`made for a newer Bench Workshop (library format ${raw.formatVersion}); update the app`);
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(raw.id)) return bad('its id must be lowercase letters, digits and dashes');
  for (const k of ['name', 'version', 'author', 'description'])
    if (typeof raw[k] !== 'string' || !raw[k].trim()) return bad(`it has no ${k}`);
  if (!Array.isArray(raw.parts)) return bad('it has no parts list');
  if (typeof raw.needsApp === 'string' && older(APP_VERSION, raw.needsApp)) return bad(`it needs Bench Workshop ${raw.needsApp} or newer (this is ${APP_VERSION}): update the app first`);
  if (raw.code !== undefined && typeof raw.code !== 'string') return bad('its code is not text');
  const ids = new Set<string>();
  for (const p of raw.parts) {
    if (!p || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id)) return bad('a part has no proper id');
    if (ids.has(p.id)) return bad(`two parts are called ${p.id}`);
    ids.add(p.id);
    if (typeof p.name !== 'string') return bad(`part ${p.id} has no name`);
    if (!(Number(p.mass) > 0)) return bad(`part ${p.id} has no mass`);
    if (!Array.isArray(p.shape) || !p.shape.length) return bad(`part ${p.id} has no shape`);
    if (p.device && !raw.code) problems.push(`part ${p.id} uses device "${p.device}" but the library has no code`);
    const lim = limitProblem(p);
    if (lim) return bad(`part ${p.id}: ${lim}`);
  }
  if (raw.sketch && typeof raw.sketch === 'object')
    for (const [name, f] of Object.entries<any>(raw.sketch))
      if (!f || typeof f.code !== 'string') return bad(`sketch library ${name} has no code`);
  return { lib: raw as Library, problems };
}

/** A part asking for more than the app allows (moving pieces, controls, sensors), or null. */
export function limitProblem(p: any): string | null {
  const L = LIB_LIMITS;
  const num = (x: any) => typeof x === 'number' && Number.isFinite(x);
  const moving = p.moving ?? [];
  if (!Array.isArray(moving)) return 'its moving pieces are not a list';
  if (moving.length > L.movingPerPart) return `${moving.length} moving pieces (most is ${L.movingPerPart})`;
  const names = new Set(['body']);
  for (const m of moving) {
    if (!m || typeof m.id !== 'string' || !/^[\w-]{1,32}$/.test(m.id) || names.has(m.id)) return 'a moving piece has no proper id (or two have the same one)';
    names.add(m.id);
    if (!(num(m.mass) && m.mass >= 0.5 && m.mass <= 100000)) return `moving piece ${m.id} must weigh 0.5 g to 100 kg`;
    if (!Array.isArray(m.shape) || !m.shape.length) return `moving piece ${m.id} has no shape`;
    const j = m.joint;
    if (!j || !Array.isArray(j.at) || !Array.isArray(j.axis) || j.at.length !== 3 || j.axis.length !== 3 || ![...j.at, ...j.axis].every(num)) return `moving piece ${m.id} needs joint.at and joint.axis ([x, y, z])`;
    if (Math.hypot(...(j.axis as number[])) < 1e-6) return `moving piece ${m.id}: its joint axis is zero`;
    if (j.type !== undefined && j.type !== 'turn' && j.type !== 'slide') return `moving piece ${m.id}: joint.type is "turn" or "slide"`;
    if (j.motor !== undefined && !['servo', 'motor', 'stepper', 'free'].includes(j.motor)) return `moving piece ${m.id}: joint.motor is servo, motor, stepper or free`;
    for (const k of ['torque', 'force', 'speed', 'volts', 'min', 'max']) if (j[k] !== undefined && !num(j[k])) return `moving piece ${m.id}: joint.${k} is not a number`;
    if ((j.torque ?? 0) < 0 || (j.torque ?? 0) > L.torque) return `moving piece ${m.id}: torque ${j.torque} kg*cm (most is ${L.torque})`;
    if ((j.force ?? 0) < 0 || (j.force ?? 0) > L.force) return `moving piece ${m.id}: force ${j.force} N (most is ${L.force})`;
    const slide = j.type === 'slide';
    if ((j.speed ?? 0) < 0 || (j.speed ?? 0) > (slide ? L.slideSpeed : L.rpm)) return `moving piece ${m.id}: speed ${j.speed} ${slide ? 'cm/s' : 'rpm'} (most is ${slide ? L.slideSpeed : L.rpm})`;
    if ((j.volts ?? 5) <= 0 || (j.volts ?? 5) > 60) return `moving piece ${m.id}: rated volts must be above 0 and at most 60`;
    if (slide && (Math.abs(j.min ?? 0) > L.travel || Math.abs(j.max ?? 0) > L.travel)) return `moving piece ${m.id}: travel more than ${L.travel} cm`;
  }
  for (const pin of p.pins ?? []) if (pin?.on !== undefined && !names.has(pin.on)) return `pin ${pin.id} is on "${pin.on}", which is no moving piece of it`;
  const ctl = p.controls ?? [];
  if (!Array.isArray(ctl) || ctl.length > L.controls) return `too many controls (most is ${L.controls})`;
  for (const c of ctl) {
    if (!c || typeof c.id !== 'string' || typeof c.label !== 'string' || c.label.length > 60) return 'a control needs an id and a label (60 characters at most)';
    if (!['slider', 'button', 'switch', 'text', 'keys'].includes(c.kind)) return `control ${c.id}: kind is slider, button, switch, text or keys`;
    if (c.kind === 'keys' && (!Array.isArray(c.keys) || !c.keys.length || c.keys.length > L.keys || c.keys.some((k: any) => typeof k !== 'string' || k.length > 12))) return `control ${c.id}: keys must be 1 to ${L.keys} short labels`;
    if (c.kind === 'slider' && !(num(c.min) && num(c.max) && c.max > c.min)) return `control ${c.id}: a slider needs min < max`;
  }
  const rangers = [...(p.shape ?? []), ...moving.flatMap((m: any) => m.shape ?? [])].filter((x: any) => x?.ranger);
  if (rangers.length > L.rangers) return `${rangers.length} distance sensors (most is ${L.rangers})`;
  for (const r of rangers) if (typeof r.ranger.id !== 'string' || (r.ranger.max !== undefined && !(num(r.ranger.max) && r.ranger.max > 0 && r.ranger.max <= L.range))) return `distance sensor ${r.ranger.id}: max must be 1 to ${L.range} cm`;
  const items = [...(p.shape ?? []), ...moving.flatMap((m: any) => m.shape ?? [])];
  const touches = items.filter((x: any) => x?.touch !== undefined);
  if (touches.length > L.touches) return `${touches.length} touch surfaces (most is ${L.touches})`;
  for (const t of touches) {
    if (typeof t.touch !== 'string' || !/^[\w-]{1,32}$/.test(t.touch)) return 'a touch surface needs a name ("touch": "pad")';
    if (!(t.box || t.cyl || t.sphere) || t.collide === false) return `touch surface ${t.touch} must be a solid box, cylinder or ball`;
  }
  const lights = items.filter((x: any) => x?.light);
  if (lights.length > L.lights) return `${lights.length} light sensors (most is ${L.lights})`;
  for (const l of lights) if (typeof l.light.id !== 'string' || (l.light.fov !== undefined && !(num(l.light.fov) && l.light.fov >= 5 && l.light.fov <= 170))) return `light sensor ${l.light.id}: fov must be 5 to 170 degrees`;
  if (p.spi !== undefined) {
    const pins = new Set([...(p.pins ?? []).map((x: any) => x?.id), ...(p.pinRows ?? []).flatMap((r: any) => r?.ids ?? [])]);
    for (const k of ['sck', 'mosi', 'cs']) if (typeof p.spi?.[k] !== 'string' || !pins.has(p.spi[k])) return `spi.${k} must name one of its pins`;
    if (p.spi.miso !== undefined && !pins.has(p.spi.miso)) return 'spi.miso must name one of its pins';
  }
  for (const s of items) if (s?.screen?.mode === 'rgb' && (s.screen.px?.[0] * s.screen.px?.[1] > 320 * 320)) return `screen ${s.screen.id}: at most 320 x 320 pixels`;
  return null;
}

/** The part type id of a library's part: "library-id/part-id" (two libraries can't clash). */
export const libPartId = (lib: Library, part: LibPart) => `${lib.id}/${part.id}`;

/** A library part as a part type the app can place, draw, simulate and wire. */
export function libPartType(lib: Library, part: LibPart): PartType {
  return {
    id: libPartId(lib, part),
    name: part.name,
    category: part.category ?? lib.category ?? 'Libraries',
    description: `${part.description ?? ''}${part.description ? '\n' : ''}From the library "${lib.name}" ${lib.version} by ${lib.author}.`,
    swatch: part.swatch ?? part.shape.find((s) => s.color)?.color ?? '#888888',
    params: part.params ?? [],
    defaults: part.defaults ?? {},
    programmable: part.sketch ? 'sketch' : undefined,
    build: () => {
      const { visual, solid } = shapesOf(part.shape);
      const pins: PinDef[] = [];
      for (const r of part.pinRows ?? []) {
        const pitch = r.pitch ?? P;
        r.ids.forEach((id, i) => {
          const at: V3 = r.dir === 'z' ? [r.at[0], r.at[1] + 0.6, r.at[2] + i * pitch] : [r.at[0] + i * pitch, r.at[1] + 0.6, r.at[2]];
          const x = r.extra?.[id] ?? {};
          pins.push({ id, body: 'body', pos: at, kind: r.kinds?.[id] ?? x.kind ?? 'io', label: x.label, analog: x.analog, vmin: x.vmin, vmax: x.vmax, pulled: x.pulled });
        });
        if (r.header !== false) {
          const h = headerRow(r.ids.length, pitch, 0, 0, 0);
          if (r.dir === 'z') h.rotation.y = -Math.PI / 2;
          const wrap = group(h);
          wrap.position.set(...r.at);
          visual.add(wrap);
        }
      }
      for (const p of part.pins ?? []) pins.push({ id: p.id, label: p.label, body: p.on ?? 'body', pos: p.at, kind: p.kind ?? 'io', analog: p.analog, vmin: p.vmin, vmax: p.vmax, pulled: p.pulled });
      if (part.glb) {
        glbFromBase64(`${lib.id}/${part.id}`, part.glb).then((scene) => {
          const m = scene.clone(true);
          m.scale.setScalar(100); // metres -> cm
          if (part.glbAt) m.position.set(...part.glbAt);
          m.traverse((x) => { x.userData = { ...x.userData, sharedGeo: true }; });
          visual.add(m);
          for (const s of solid) s.visible = false; // the model replaces the plain shapes
        }).catch((e) => console.warn(`[library] ${lib.id}/${part.id}: its 3D model didn't load: ${e?.message ?? e}`));
      }
      // the pieces that move: each its own body (all start at the part's origin, so their shapes and
      // joint are in the part's frame), joined to the main body
      const bodies: BodyDef[] = [{ name: 'body', pos: [0, 0, 0], mass: part.mass, colliders: collidersOf(part.shape, visual, solid), visual }];
      const joints: JointDef[] = [];
      for (const m of (part.moving ?? []).slice(0, LIB_LIMITS.movingPerPart)) {
        const piece = shapesOf(m.shape);
        bodies.push({ name: m.id, pos: [0, 0, 0], mass: Math.max(0.5, m.mass), colliders: collidersOf(m.shape, piece.visual, piece.solid), visual: piece.visual });
        const j = m.joint;
        const slide = j.type === 'slide';
        // (a multi-turn servo: the stepper's "any number of turns" control, but knowing where it is)
        const multi = j.motor === 'servo' && j.multiturn === true && !slide;
        const kind = multi ? 'stepper' : j.motor ?? 'free';
        const L = LIB_LIMITS;
        const clamp = (x: number, hi: number) => Math.max(0, Math.min(hi, x));
        const axis = new THREE.Vector3(...j.axis).normalize();
        joints.push({
          kind: slide ? 'prismatic' : 'revolute',
          name: m.id,
          a: 'body',
          b: m.id,
          anchor: j.at,
          axis: axis.toArray() as V3,
          actuator: {
            kind,
            byCode: true,
            ...(multi ? { feedback: true } : {}),
            // (turn: kg*cm; slide: newtons as kg-force; free: the friction)
            maxTorque: kind === 'free' ? clamp(j.torque ?? (slide ? (j.force ?? 0.5) / 9.81 : 0.02), slide ? L.force / 9.81 : L.torque) : slide ? clamp(j.force ?? 10, L.force) / 9.81 : clamp(j.torque ?? 1, L.torque),
            speed: slide ? clamp(j.speed ?? 5, L.slideSpeed) : (clamp(j.speed ?? 60, L.rpm) * 2 * Math.PI) / 60,
            ratedVolts: j.volts ?? 5,
            ...(slide
              ? { minAngle: Math.max(-L.travel, j.min ?? -2), maxAngle: Math.min(L.travel, j.max ?? 2) }
              : kind === 'servo' ? { minAngle: ((j.min ?? -90) * Math.PI) / 180, maxAngle: ((j.max ?? 90) * Math.PI) / 180 } : {}),
          },
        });
      }
      return {
        bodies,
        joints,
        pins,
        // (for the circuit check: the part's own copper and design findings)
        shorts: part.shorts,
        designIssues: part.designIssues,
      } as any;
    },
  };
}

/** A part's (or moving piece's) shape items as a drawing, plus the items that are solid. */
function shapesOf(items: LibShapeItem[]) {
  const visual = group();
  const solid: THREE.Object3D[] = [];
  for (const it of items) {
    const color = it.color ?? '#888888';
    let o: THREE.Object3D | null = null;
    if (it.box) o = boxMesh(it.box[0], it.box[1], it.box[2], color);
    else if (it.cyl) o = cylMesh(it.cyl[0], it.cyl[1], color);
    else if (it.sphere) o = mesh(new THREE.SphereGeometry(it.sphere, 20, 14), color);
    else if (it.model) {
      o = mesh(modelGeometry(it.model), color, 0, 0, 0, { roughness: 0.55, metalness: 0.05 });
      o.userData.sharedGeo = true; // (one geometry for every copy: not disposed with a part)
    } else if (it.hull) {
      // its solid shape only (the model is the look): an invisible stand-in so the shape has a place
      o = new THREE.Object3D();
    } else if (it.header) {
      o = headerRow(it.header.n, it.header.pitch ?? P, 0, 0, 0);
      if (it.header.dir === 'z') o.rotation.y = -Math.PI / 2;
    } else if (it.screen) o = screenMesh(it.screen);
    else if (it.camera) {
      // an invisible marker: where the camera is and which way it looks (its picture is rendered
      // from here while running; see lib/runtime.ts)
      o = new THREE.Object3D();
      o.userData = { camera: { ...it.camera, px: [Math.min(160, Math.max(4, it.camera.px[0] | 0)), Math.min(120, Math.max(4, it.camera.px[1] | 0))] } };
    } else if (it.light) {
      // a light sensor's eye: an invisible marker too (a tiny picture from here gives its brightness)
      o = new THREE.Object3D();
      o.userData = { light: { ...it.light, fov: Math.min(170, Math.max(5, it.light.fov ?? 90)) } };
    } else if (it.ranger) {
      // a distance sensor's beam: also an invisible marker (measured from here while running)
      o = new THREE.Object3D();
      o.userData = { ranger: { ...it.ranger, max: Math.min(LIB_LIMITS.range, Math.max(1, it.ranger.max ?? 400)) } };
    }
    if (!o) continue;
    const wrap = group(o);
    if (it.at) wrap.position.set(...it.at);
    if (it.rot) wrap.rotation.set(...(it.rot.map((d) => (d * Math.PI) / 180) as V3));
    visual.add(wrap);
    if ((it.box || it.cyl || it.sphere) && it.collide !== false) solid.push(wrap);
  }
  return { visual, solid };
}

/** A model's geometry from its stored points and triangles (made once per model, then shared). */
const modelCache = new Map<string, THREE.BufferGeometry>();
function modelGeometry(m: { v: string; i: string }) {
  let g = modelCache.get(m.v);
  if (g) return g;
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = new Float32Array(bytes(m.v).buffer), i = new Uint32Array(bytes(m.i).buffer);
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.BufferAttribute(v, 3));
  raw.setIndex(new THREE.BufferAttribute(i, 1));
  // sharp edges stay sharp, curved surfaces look smooth (as in a CAD program)
  g = toCreasedNormals(raw, (35 * Math.PI) / 180);
  raw.dispose();
  modelCache.set(m.v, g);
  return g;
}

/** Its physical shape: each solid box, cylinder and ball as itself (a wheel rolls, a disc spins
 *  without its corners hitting things), or one box around them all for very many pieces. */
function collidersOf(items: LibShapeItem[], visual: THREE.Object3D, solid: THREE.Object3D[]) {
  const list = items.filter((it) => (it.box || it.cyl || it.sphere || it.hull) && it.collide !== false);
  if (!list.length || list.filter((it) => !it.hull).length > 24 || list.length > 64) return [boxAround(visual, solid)];
  return list.map((it) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...((it.rot ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180) as V3)));
    const shape = it.hull
      ? { kind: 'hull' as const, points: new Float32Array(it.hull.p), volume: Math.max(1e-4, it.hull.vol) }
      : it.box
      ? { kind: 'box' as const, hx: Math.max(0.02, it.box[0] / 2), hy: Math.max(0.02, it.box[1] / 2), hz: Math.max(0.02, it.box[2] / 2) }
      : it.cyl
        ? { kind: 'cylinder' as const, halfHeight: Math.max(0.01, it.cyl[1] / 2), radius: Math.max(0.02, it.cyl[0]) }
        : { kind: 'ball' as const, radius: Math.max(0.02, it.sphere!) };
    return { shape, pos: (it.at ?? [0, 0, 0]) as V3, rot: [q.x, q.y, q.z, q.w] as [number, number, number, number], tag: typeof it.touch === 'string' ? it.touch : undefined };
  });
}

/** One box around the solid pieces. */
function boxAround(visual: THREE.Object3D, solid: THREE.Object3D[]) {
  const bb = new THREE.Box3();
  visual.updateMatrixWorld(true);
  for (const s of solid.length ? solid : [visual]) bb.expandByObject(s);
  if (bb.isEmpty()) bb.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 0.2, 0.5));
  const size = bb.getSize(new THREE.Vector3()), centre = bb.getCenter(new THREE.Vector3());
  return { shape: { kind: 'box' as const, hx: Math.max(0.02, size.x / 2), hy: Math.max(0.02, size.y / 2), hz: Math.max(0.02, size.z / 2) }, pos: centre.toArray() as V3 };
}

/** A flat screen: a canvas the part's code draws on (pixels or characters). */
function screenMesh(s: LibScreen) {
  const [cols, rows] = s.px;
  const text = s.mode === 'text';
  const rgb = s.mode === 'rgb';
  const canvas = document.createElement('canvas');
  canvas.width = text ? cols * 12 + 8 : rgb ? cols : Math.max(8, cols * 8);
  canvas.height = text ? rows * 20 + 8 : rgb ? rows : Math.max(8, rows * 8);
  const tex = new THREE.CanvasTexture(canvas);
  if (rgb) {
    tex.magFilter = THREE.NearestFilter; // (sharp pixels, as a real TFT up close)
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(s.size[0], s.size[1]), new THREE.MeshBasicMaterial({ map: tex }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  const screen: ScreenState = { def: s, canvas, tex, cells: text ? Array.from({ length: rows }, () => ' '.repeat(cols)) : new Array(cols * rows).fill(0) };
  m.userData = { screen };
  drawScreen(screen);
  return m;
}

export interface ScreenState {
  def: LibScreen;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  cells: string[] | (number | string)[] | Uint32Array; // text rows, or per pixel: 0/1 (off/on) or a CSS colour; rgb: 0xRRGGBB
  lit?: boolean; // backlight / panel on (default on)
}

export function drawScreen(s: ScreenState) {
  const g = s.canvas.getContext('2d')!;
  const [cols, rows] = s.def.px;
  const lit = s.lit !== false;
  if (s.def.mode === 'rgb') {
    // a full-colour screen: straight into the canvas, one canvas pixel per screen pixel
    const img = g.createImageData(cols, rows);
    const d = img.data, cells = s.cells as ArrayLike<number>;
    for (let i = 0; i < cols * rows; i++) {
      const v = lit ? Number(cells[i]) || 0 : 0;
      d[i * 4] = (v >> 16) & 255;
      d[i * 4 + 1] = (v >> 8) & 255;
      d[i * 4 + 2] = v & 255;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    s.tex.needsUpdate = true;
    return;
  }
  g.fillStyle = lit ? s.def.bg ?? '#101418' : s.def.off ?? '#0b0d10';
  g.fillRect(0, 0, s.canvas.width, s.canvas.height);
  if (s.def.mode === 'text') {
    g.font = '18px monospace';
    g.textBaseline = 'top';
    g.fillStyle = s.def.on ?? '#e8f0ff';
    if (!lit) g.globalAlpha = 0.35;
    (s.cells as string[]).forEach((line, r) => {
      for (let c = 0; c < cols; c++) g.fillText(line[c] ?? ' ', 4 + c * 12, 4 + r * 20);
    });
    g.globalAlpha = 1;
  } else {
    const pw = s.canvas.width / cols, ph = s.canvas.height / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const v = (s.cells as (number | string)[])[r * cols + c];
        g.fillStyle = typeof v === 'string' ? v : v ? s.def.on ?? '#ff3020' : s.def.off ?? '#2a1210';
        if (s.def.dots === false) {
          g.fillRect(Math.floor(c * pw), Math.floor(r * ph), Math.ceil(pw), Math.ceil(ph));
          continue;
        }
        g.beginPath();
        g.arc(c * pw + pw / 2, r * ph + ph / 2, Math.min(pw, ph) * 0.38, 0, Math.PI * 2);
        g.fill();
      }
  }
  s.tex.needsUpdate = true;
}

/** The screens of a placed part, by id. */
export function screensOf(root: THREE.Object3D) {
  const out = new Map<string, ScreenState>();
  root.traverse((o) => {
    const s = o.userData?.screen as ScreenState | undefined;
    if (s) out.set(s.def.id, s);
  });
  return out;
}
