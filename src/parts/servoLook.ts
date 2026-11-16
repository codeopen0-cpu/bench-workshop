// What a hobby servo looks like: a two-piece case with seams, mounting ears with screw holes and
// rubber grommets, a sticker with its model on both sides, the output spline on a round boss (and
// the second gear tower beside it), a tapered horn with holes, and the three-wire lead to its plug.
// Only looks: the physical shape (colliders) and the motor stay in catalog.ts, so arms built on a
// servo behave exactly as before.
import * as THREE from 'three';
import { boxMesh, cylMesh, group, mesh } from './geo';

export interface ServoLook {
  model: string; // printed on the sticker, e.g. "MG996R"
  w: number; h: number; d: number; // case
  ear: number; earY: number;
  shaftX: number;
  boss: number;
  horn: number;
  color: string; // case
  clear?: boolean; // see-through case (an SG90's blue plastic), with its gears showing
  metalSpline?: boolean; // a brass output spline (metal-gear servos)
  sticker: string; // sticker colour
}

/** a sticker: a canvas with the model name, laid on a side of the case */
function sticker(look: ServoLook, width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = Math.max(64, Math.round((256 * height) / width));
  const g = c.getContext('2d')!;
  g.fillStyle = look.sticker;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(0, c.height * 0.72, c.width, c.height * 0.06); // a stripe
  g.fillStyle = '#ffffff';
  g.font = `bold ${Math.round(c.height * 0.34)}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(look.model, c.width / 2, c.height * 0.38);
  g.font = `${Math.round(c.height * 0.13)}px "Segoe UI", sans-serif`;
  g.fillText(look.clear ? 'MICRO SERVO' : 'METAL GEAR SERVO', c.width / 2, c.height * 0.88);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
}

export function servoCaseLook(s: ServoLook) {
  const caseMat = { transparent: !!s.clear, opacity: s.clear ? 0.78 : 1, roughness: s.clear ? 0.25 : 0.65 };
  const seamH = 0.05;
  const darker = new THREE.Color(s.color).multiplyScalar(0.6).getStyle();
  const v = group(
    // bottom cover, middle, top cover (the seams between them a little darker and proud)
    mesh(new THREE.BoxGeometry(s.w, s.h * 0.18, s.d), s.color, 0, s.h * 0.09, 0, caseMat),
    mesh(new THREE.BoxGeometry(s.w, s.h * 0.62, s.d), s.color, 0, s.h * 0.18 + s.h * 0.31, 0, caseMat),
    mesh(new THREE.BoxGeometry(s.w, s.h * 0.2, s.d), s.color, 0, s.h * 0.9, 0, caseMat),
    boxMesh(s.w + 0.02, seamH, s.d + 0.02, darker, 0, s.h * 0.18, 0),
    boxMesh(s.w + 0.02, seamH, s.d + 0.02, darker, 0, s.h * 0.8, 0),
    // the mounting ears, with a screw hole and rubber grommet on each side
    mesh(new THREE.BoxGeometry(s.w + 2 * s.ear, 0.24, s.d), s.color, 0, s.earY, 0, caseMat),
  );
  for (const side of [-1, 1]) {
    const x = side * (s.w / 2 + s.ear * 0.5);
    v.add(cylMesh(s.d * 0.17, 0.26, '#2a2c30', x, s.earY, 0, 20)); // grommet
    v.add(cylMesh(s.d * 0.07, 0.28, '#0b0c0e', x, s.earY, 0, 16)); // the hole through it
  }
  // stickers on both big sides (between the seams)
  const sw = s.w * 0.86, sh = s.h * 0.5;
  for (const side of [-1, 1]) {
    const st = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), sticker(s, sw, sh));
    st.position.set(0, s.h * 0.48, side * (s.d / 2 + 0.003));
    if (side < 0) st.rotation.y = Math.PI;
    v.add(st);
  }
  // on top: the round boss with the output spline, and the smaller gear tower beside it
  v.add(cylMesh(s.d * 0.38, s.boss, s.color, s.shaftX, s.h + s.boss / 2, 0));
  v.add(cylMesh(s.d * 0.26, s.boss * 0.5, s.color, s.shaftX - s.d * 0.62, s.h + s.boss * 0.25, 0));
  v.add(cylMesh(s.d * 0.12, 0.12, s.metalSpline ? '#c9a24a' : '#f2f2f2', s.shaftX, s.h + s.boss + 0.06, 0, 18));
  // a see-through case shows its white nylon gears
  if (s.clear)
    for (const [gx, gy, r] of [[s.shaftX, s.h * 0.82, s.d * 0.34], [s.shaftX - s.d * 0.55, s.h * 0.7, s.d * 0.26], [s.shaftX - s.d * 0.1, s.h * 0.58, s.d * 0.3]] as const)
      v.add(cylMesh(r, s.d * 0.5, '#f4f4f0', gx, gy, 0, 24).rotateX(Math.PI / 2));
  return v;
}

/** the horn: a tapered arm with holes along it, from the hub out along +x (its collider's shape) */
export function servoHornLook(s: ServoLook, hornT: number) {
  const hub = s.d * 0.32, tip = s.d * 0.12, L = s.horn;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, hub, Math.PI / 2, (3 * Math.PI) / 2, false);
  shape.lineTo(L, -tip);
  shape.absarc(L, 0, tip, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(0, hub);
  const holes = Math.max(3, Math.round(L / 0.35));
  for (let i = 1; i <= holes; i++) {
    const x = (L * i) / (holes + 0.6);
    const hole = new THREE.Path();
    hole.absarc(x, 0, Math.min(0.055, tip * 0.5), 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: hornT, bevelEnabled: false, curveSegments: 18 });
  geo.rotateX(Math.PI / 2); // lie flat (extruded downwards from y = 0)
  geo.translate(0, hornT / 2, 0);
  return group(
    mesh(geo, '#f4f4f2', 0, 0, 0, { roughness: 0.45 }),
    cylMesh(hub * 0.42, 0.04, '#9aa0a8', 0, hornT / 2 + 0.02, 0, 20), // the screw in the middle
  );
}

/** the lead: three wires from the case's end to the plug, which holds the pins */
export function servoLeadLook(s: ServoLook, plugX: number, plugY: number) {
  const v = group(boxMesh(0.5, 0.25, 0.75, '#1d1f24', plugX, plugY, 0));
  const startX = -s.w / 2, startY = s.h * 0.12;
  ([['#6b4226', -0.18], ['#d23b3b', 0], ['#f08c2a', 0.18]] as const).forEach(([color, z]) => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(startX, startY, z * 0.35),
      new THREE.Vector3(startX - 0.15, startY, z * 0.55),
      new THREE.Vector3(plugX + 0.45, plugY, z * 0.9),
      new THREE.Vector3(plugX + 0.25, plugY, z),
    ]);
    v.add(mesh(new THREE.TubeGeometry(curve, 16, 0.035, 6, false), color));
  });
  return v;
}
