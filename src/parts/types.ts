// What a part is made of. Units everywhere: centimetres, grams, seconds, radians.
// (Small robot parts are a few cm; working in cm keeps the physics numbers well-sized.)
import type * as THREE from 'three';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number]; // x, y, z, w

export type Shape =
  | { kind: 'box'; hx: number; hy: number; hz: number } // half sizes
  | { kind: 'cylinder'; halfHeight: number; radius: number } // along the body's Y axis
  | { kind: 'ball'; radius: number }
  /** a convex piece given by its corner points (x, y, z, x, y, z...): an imported 3D model's shape is a
   *  few of these (see lib/model.ts); `volume` is its size in cm^3, for sharing out the mass */
  | { kind: 'hull'; points: Float32Array; volume: number };

export interface ColliderDef {
  shape: Shape;
  pos?: V3; // in the body's frame
  rot?: Q4;
  friction?: number; // default 0.7
  restitution?: number; // default 0.1
  /** a touch-sensing surface (a library part's "touch"): the run reports what presses on it */
  tag?: string;
  /** its friction is the lower of its own and what it touches (a mecanum wheel's rollers: 0, the
   *  sim adds the grip they really have, one way only) */
  frictionMin?: boolean;
}

/** One rigid piece of a part. A servo has two: the case and the horn (joined by a motor). */
export interface BodyDef {
  name: string;
  pos: V3; // in the part's frame
  rot?: Q4;
  mass: number; // grams
  colliders: ColliderDef[];
  visual: THREE.Object3D; // drawn in the body's frame
}

export interface ActuatorSpec {
  /** servo: goes to an angle; motor: spins with a power -1..1; stepper: goes to an angle any number
   *  of turns away (and skips steps when overloaded); free: no motor, just a little friction */
  kind: 'servo' | 'motor' | 'stepper' | 'free';
  maxTorque: number; // kg*cm (as on datasheets), at the rated voltage (slide joints: kg-force)
  speed: number; // rad/s with no load (slide joints: cm/s)
  minAngle?: number; // servo travel, rad (slide joints: cm)
  maxAngle?: number;
  ratedVolts: number;
  /** driven by a library part's code (not by a slider in the run panel) */
  byCode?: boolean;
  /** (stepper kind) a multi-turn servo: it knows where it is, so it never loses steps; overloaded,
   *  it stalls and keeps trying, as a servo does */
  feedback?: boolean;
}

export interface JointDef {
  kind: 'revolute' | 'prismatic'; // turns about the axis / slides along it
  name: string;
  a: string; // body that stays (e.g. the servo case)
  b: string; // body that turns (the horn)
  anchor: V3; // part frame
  axis: V3; // part frame, unit
  actuator?: ActuatorSpec;
}

export interface ParamDef {
  key: string;
  label: string;
  kind: 'number' | 'color' | 'select' | 'bool';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

/** What a pin is for: decides its colour, and lets the checks spot mistakes. */
export type PinKind =
  | 'gnd' // ground
  | 'vin' // power in (with a voltage range)
  | 'vout' // power out (a regulator or battery terminal)
  | 'io' // a microcontroller pin: in, out, PWM (analog if `analog`)
  | 'in' // a logic / signal input (sensor TRIG, servo signal, driver IN)
  | 'out' // a logic / signal output (sensor ECHO, button)
  | 'motor' // high-current terminal (motor wire, driver output)
  | 'i2c' // SDA / SCL
  | 'port'; // one contact of a click-together module port

export interface PinDef {
  id: string; // unique within the part, e.g. "GP7", "+", "SIG"
  label?: string; // shown next to it (default: id)
  body: string;
  pos: V3; // body frame
  kind: PinKind;
  analog?: boolean; // io pin with an ADC
  /** vin: the voltage range it accepts; above max = damaged */
  vmin?: number;
  vmax?: number;
  /** a resistor on the part pulls it up or down: fine to leave unwired (EN, OE, RUN...) */
  pulled?: 'up' | 'down';
}

/** A click-together connector: 4 contacts (GND, SDA, SCL, VB). Touching opposite-gender ports connect. */
export interface PortDef {
  id: string;
  body: string;
  pos: V3; // centre of the contact row, body frame
  normal: V3; // pointing out of the board edge
  gender: 'male' | 'female';
  pins: [string, string, string, string]; // pin ids for GND, SDA, SCL, VB
}

/** Something on a body that works with other parts mechanically (see sim.ts, mechanics):
 *  gear: meshes with any gear whose teeth reach it (turning the other way, by tooth count);
 *  pulley: turns with the pulleys its belts join (the same way, by size);
 *  chain: turns with the other wheels of the same chain in this part (a tank track's wheels);
 *  mecanum / omni: a wheel of rollers that grips only one way (the rest of the time it slides). */
export interface MechDef {
  kind: 'gear' | 'pulley' | 'chain' | 'mecanum' | 'omni';
  body: string;
  /** its centre and axle, in the body's frame */
  at: V3;
  axis: V3;
  /** pitch radius (gears), belt radius (pulleys), wheel radius (chains, rollers) */
  radius: number;
  teeth?: number;
  /** a gear's thickness (it meshes only with gears beside it, not above it), cm */
  width?: number;
  /** chain: which chain in the part; mecanum: which way its rollers lean, 1 or -1 */
  group?: number;
}

export interface PartBuild {
  bodies: BodyDef[];
  joints: JointDef[];
  pins?: PinDef[];
  ports?: PortDef[];
  mech?: MechDef[];
}

export interface PartType {
  id: string;
  name: string;
  category: string;
  description: string;
  swatch: string; // colour in the parts list
  params: ParamDef[];
  defaults: Record<string, number | string | boolean>;
  build(p: Record<string, any>): PartBuild;
  /** Which body is glued to whatever the part is placed on (default: the first). */
  mountBody?: string;
  /** It always stands upright (a tank track): placed on any face it keeps its Y up, turned only about
   *  the vertical; on a face looking down (a chassis' underside) it hangs below it, its top (this
   *  high, cm) against the face. */
  upright?: (p: Record<string, any>) => number;
  /** Can be programmed: 'sketch' (Arduino-style program in the app) or 'rp2040' (also real .uf2 firmware). */
  programmable?: 'sketch' | 'rp2040';
}

/** kg*cm (datasheet torque) -> g*cm^2/s^2 (the physics' torque unit) */
export const KGCM = 1000 * 981;
export const GRAVITY = 981; // cm/s^2
