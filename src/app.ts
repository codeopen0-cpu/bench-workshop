// Bench Workshop: the app. Build mode (place, glue, move, edit parts) and run mode (physics, motors,
// push things around with the mouse). The project (project.ts) is the single source of truth: the 3D
// view is rebuilt from it after every change, and a run never changes it.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Circuit, type Device } from './elec/circuit';
import { DEVICE_MAKERS, type DeviceHooks } from './elec/devices';
import { EXAMPLES } from './examples';
import { openText, saveText } from './files';
import { Dock } from './ui/dock';
import { LibrariesWindow } from './ui/libraries';
import { importKicad, importModel, makePart } from './ui/partmaker';
import { applyUiScale, autoUiScale, setUiScale, uiScaleSetting, watchUiScale } from './ui/uiscale';
import { PadInput } from './ui/gamepad';
import { Instruments } from './ui/instruments';
import { openSheets } from './ui/sheets';
import { ControlApi } from './net/api';
import { WebView } from './ui/webview';
import { CheckWindow } from './ui/checkwin';
import { Tutorial } from './ui/tutorial';
import { checkCircuit } from './elec/check';
import { BenchNetwork, DEFAULT_WIFI } from './net/wifi';
import { fetchRegistry, installed, installFromRegistry, librariesUsed, missingTypes, onLibrariesChanged } from './lib/store';
import { cameraHook } from './lib/runtime';
import { benchAudio } from './lib/sound';
import { addPinMarkers, pinDef, pinWorld, removePinMarkers, WIRE_COLORS, WireLayer } from './wiring';
import { CATEGORIES, PART_BY_ID, PARTS } from './parts/catalog';
import type { PartType, Q4, V3 } from './parts/types';
import { newProject, newUid, parentFirst, subtree, uniqueName, validate, wireLengthFor, type PartInst, type PinRef, type Project } from './project';
import { Sim, STEP } from './sim';
import { DEFAULT_GLUE, findBonds, GlueCheck, GLUES } from './glue';
import { LoadsPanel, LoadWatch } from './ui/loads';
import { BalanceView } from './ui/balance';
import { Stage } from './stage';
import { HandModel } from './hand';
import { PinGraph } from './ui/pingraph';
import { disposeView, makeView, setHighlight, viewMeshes, type PartView } from './views';

type Mode = 'build' | 'run' | 'paused';
const AUTOSAVE_KEY = 'bench-workshop.autosave';
// (assigning a string to `style` sets its cssText, as in HTML)
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (e as any)[k] = v;
  for (const c of kids) e.append(c);
  return e;
};

export class App {
  stage: Stage;
  project: Project = newProject();
  views = new Map<string, PartView>();
  mode: Mode = 'build';
  selected: string | null = null;
  placing: { type: PartType; ghost: PartView; spin: number; valid: boolean; hit: ReturnType<Stage['pick']> } | null = null;
  gluing: string | null = null; // picking what the selected part gets glued to
  belting: string | null = null; // picking the pulley the selected one gets a belt to
  /** a game pad / the keyboard playing a PS2 controller library's receiver */
  private pad = new PadInput();
  /** the control API: the bench driven by programs on this PC (toolbar: API) */
  api = new ControlApi({
    mode: () => this.mode,
    time: () => this.sim?.time ?? 0,
    project: () => this.project,
    run: () => this.run(),
    stop: () => this.stop(),
    pause: () => this.pause(),
    advance: (s) => this.advance(s),
    bodies: (uid) => {
      const out: { name: string; rb: any }[] = [];
      for (const [k, g] of ((this.sim as any)?.byKey ?? new Map()) as Map<string, any>) if (k.startsWith(uid + '/')) out.push({ name: k.slice(uid.length + 1), rb: (g as any).rb });
      return out;
    },
    pose: (uid) => {
      const v = this.views.get(uid);
      if (!v) return null;
      v.root.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      v.root.matrixWorld.decompose(p, q, new THREE.Vector3());
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      return { pos: [r3(p.x), r3(p.y), r3(p.z)], rot: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)] };
    },
    device: (uid) => this.circuit?.devices.find((d) => d.view.inst.uid === uid) as any,
    pinVolts: (uid) => {
      const v = this.views.get(uid);
      const out: Record<string, number | null> = {};
      for (const pin of v?.build.pins ?? []) out[pin.id] = this.circuit ? Math.round(this.circuit.avg(uid, pin.id) * 1000) / 1000 : null;
      return out;
    },
    serialText: (uid) => this.dock.serialText(uid),
    load: (json) => {
      const { project, problems } = validate(json);
      if (project) { this.stop(); this.load(project, null); }
      return problems;
    },
    setProgram: (uid, source, lang) => {
      this.project.programs[uid] = { lang: lang as any, source };
      this.dirty = true;
      this.dock.projectChanged();
    },
    isBoard: (uid) => !!PART_BY_ID.get(this.instOf(uid)?.type ?? '')?.programmable,
    log: (m, l) => this.log(m, l),
  });
  async toggleApi() {
    try {
      if (this.api.on) await this.api.stopApi();
      else {
        const url = await this.api.start();
        this.hint(`Control API: ${url}  (GET / there lists what it does; programs on this PC only)`);
      }
      try { localStorage.setItem('bench.api', this.api.on ? '1' : '0'); } catch { /* not kept */ }
    } catch (e: any) {
      this.log(`control API: could not open port 7420 (${e?.message ?? e}): is another copy using it?`, 'bad');
    }
    this.refreshAll();
  }
  /** weight and balance on the bench (made when first used) */
  private _balance: BalanceView | null = null;
  get balance() {
    if (!this._balance) this._balance = new BalanceView({ stage: this.stage, views: () => this.views, hint: (t) => this.hint(t) });
    return this._balance;
  }
  /** the ruler and the multimeter (made when first used) */
  private _ins: Instruments | null = null;
  get ins() {
    if (!this._ins) {
      this._ins = new Instruments({
        stage: this.stage,
        pinAt: (ev) => this.pinAt(ev),
        pinWorld: (ref, out) => !!pinWorld(this.views, ref, out),
        circuit: () => this.circuit,
        pinLabel: (ref) => this.pinLabel(ref),
        hint: (t) => this.hint(t),
        pickRoots: () => [this.mode === 'build' ? this.stage.partsRoot : this.stage.runRoot],
        shapesOf: (uid, body) => this.views.get(uid)?.build.bodies.find((b) => b.name === body)?.colliders ?? [],
      });
      this._ins.onChange = () => this.refreshAll();
    }
    return this._ins;
  }
  sim: Sim | null = null;
  circuit: Circuit | null = null;
  wiring = false; // wire mode: click pin, then pin
  wireStart: PinRef | null = null;
  selectedWire: string | null = null;
  wires = new WireLayer();
  dock: Dock;
  net: BenchNetwork | null = null;
  webView = new WebView();
  tutorial = new Tutorial({
    project: () => this.project,
    mode: () => this.mode,
    status: (uid) => this.circuit?.devices.find((d) => d.view.inst.uid === uid)?.status?.() ?? [],
    newBench: () => this.newBench(),
    setProgram: (uid, source) => {
      this.snapshot();
      this.project.programs[uid] = { lang: 'arduino', source };
      this.changed(false);
    },
    openProgram: (uid) => this.openProgram(uid),
    checkOpened: () => this.checker.opened,
  });
  checker = new CheckWindow(
    () => checkCircuit(this.project, this.views, new Set(PARTS.filter((p) => p.programmable).map((p) => p.id))),
    (uids) => {
      if (this.mode !== 'build') return;
      this.select(uids[0] ?? null);
      const roots = uids.map((u) => this.views.get(u)?.root).filter((r): r is THREE.Group => !!r);
      if (roots.length) this.stage.frame(roots);
    },
  );
  libraries = new LibrariesWindow({
    project: () => this.project,
    log: (m, l) => this.log(m, l),
    openProject: async (raw: any) => {
      await this.ensureLibraries(raw);
      const { project, problems } = validate(JSON.parse(JSON.stringify(raw)));
      if (!project) return this.log(`couldn't open it: ${problems.join('; ')}`, 'bad');
      this.load(project, null);
      for (const p of problems) this.log(p, 'warn');
    },
    makers: [
      { label: 'Import KiCad board...', title: 'Make a part from a KiCad board (.kicad_pcb, and its 3D export if you have it)', run: () => importKicad(this.partHost) },
      { label: 'Import 3D model (.stl)...', title: 'Bring in your own design (.stl from CAD or a slicer) as a part: see how it looks and works on the bench', run: () => importModel(this.partHost) },
      { label: 'Make a part...', title: 'Make a board here: size, colour, header rows, a microcontroller', run: () => makePart(this.partHost) },
    ],
  });
  private partHost = {
    project: () => this.project,
    log: (m: string, l?: 'info' | 'warn' | 'bad') => this.log(m, l),
    place: (typeId: string) => {
      const t = PART_BY_ID.get(typeId);
      if (t) this.startPlacing(t);
    },
  };
  private pressed: Device | null = null;
  private rubber: THREE.Line;
  speed = 1;
  filePath: string | null = null;
  dirty = false;
  private undo: string[] = [];
  private redo: string[] = [];
  private acc = 0;
  private last = performance.now();
  private grabLine: THREE.Line;
  /** the grab ball (run mode): how it looks; how high it lifts what it holds / the pushing ball rides */
  private hand = new HandModel();
  pinGraph!: PinGraph;
  loads!: LoadsPanel;
  loadWatch = new LoadWatch();
  private pushLift = 0;
  private lastPointer: PointerEvent | null = null;
  /** what the mouse moves a held thing across: a plane facing the camera through where it was taken,
   *  fixed for the whole drag (re-taking it through the thing as it lags made it creep towards you) */
  private grabPlane: THREE.Plane | null = null;
  private pointerDown: { x: number; y: number; button: number } | null = null;
  private dom = {
    toolbar: document.getElementById('toolbar')!,
    catalog: document.getElementById('catalog')!,
    inspector: document.getElementById('inspector')!,
    status: document.getElementById('status')!,
    viewport: document.getElementById('viewport')!,
  };
  private hintEl = el('div', { className: 'hint' });
  private toastHost = el('div', { className: 'toast-host' });
  private statusEls = { mode: el('span', { className: 'mode-pill mode-build', textContent: 'BUILD' }), parts: el('span'), time: el('span'), log: el('span', { id: 'log' }) };
  private readouts: (() => void)[] = [];
  private fps = 0;

  constructor(private R: typeof RAPIER_NS) {
    this.stage = new Stage(this.dom.viewport);
    // cameras on library parts: render the bench from where the camera is, as small pictures
    {
      const rt = new THREE.WebGLRenderTarget(4, 4);
      rt.texture.colorSpace = THREE.SRGBColorSpace; // (the same colours as on screen)
      const cam = new THREE.PerspectiveCamera();
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), look = new THREE.Vector3(), up = new THREE.Vector3();
      // a close-up sensor (a line sensor, a colour sensor) shines its own LED at what it looks at:
      // a light at the camera, on only while it takes its picture (always in the scene, so adding it
      // doesn't make every material rebuild)
      const ownLed = new THREE.PointLight(0xffffff, 0, 0, 2);
      this.stage.scene.add(ownLed);
      cameraHook.render = (marker, def) => {
        const [w, h] = def.px;
        if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
        marker.updateWorldMatrix(true, false);
        pos.setFromMatrixPosition(marker.matrixWorld);
        marker.getWorldQuaternion(q);
        look.set(...(def.look ?? [1, 0, 0])).normalize().applyQuaternion(q);
        up.set(0, 1, 0).applyQuaternion(q);
        cam.fov = def.fov ?? 60;
        cam.aspect = w / h;
        cam.near = 0.2;
        cam.far = def.range ?? 500;
        cam.updateProjectionMatrix();
        cam.position.copy(pos);
        cam.up.copy(up);
        cam.lookAt(pos.clone().add(look));
        const r = this.stage.renderer;
        const prev = r.getRenderTarget();
        const close = (def.range ?? 500) <= 20;
        if (close) {
          ownLed.position.copy(pos);
          ownLed.intensity = 1.2; // (a dim LED: white paper looks white, black tape stays dark)
        }
        r.setRenderTarget(rt);
        r.render(this.stage.scene, cam);
        r.setRenderTarget(prev);
        ownLed.intensity = 0;
        const raw = new Uint8Array(w * h * 4);
        r.readRenderTargetPixels(rt, 0, 0, w, h, raw);
        const out = new Uint8Array(w * h * 4); // (GL rows start at the bottom: turn it the right way up)
        for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        return out;
      };
    }
    this.dom.viewport.append(this.hintEl, this.toastHost);
    this.grabLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffd25a }));
    this.grabLine.visible = false;
    this.stage.overlay.add(this.grabLine);
    this.stage.overlay.add(this.hand.root);
    this.pinGraph = new PinGraph(this.dom.viewport, () => this.views);
    this.loads = new LoadsPanel({
      viewport: this.dom.viewport,
      sim: () => this.sim,
      circuit: () => this.circuit,
      glue: () => this.glueCheck,
      select: (uid) => this.select(uid),
      log: (m, l) => this.log(m, l),
    }, this.loadWatch);
    this.rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xffd25a, dashSize: 0.3, gapSize: 0.2 }));
    this.rubber.visible = false;
    this.stage.overlay.add(this.rubber);
    this.stage.scene.add(this.wires.group);
    this.dock = new Dock(this.dom.viewport, {
      program: (uid) => this.project.programs[uid],
      setProgram: (uid, p) => {
        this.project.programs[uid] = p;
        this.dirty = true;
        try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.project)); } catch { /* no autosave */ }
      },
      boardName: (uid) => this.nameOf(uid),
      canLoadFirmware: (uid) => PART_BY_ID.get(this.instOf(uid)?.type ?? '')?.programmable === 'rp2040',
      loadFirmware: (uid) => this.loadFirmware(uid),
      sendSerial: (uid, text) => {
        this.circuit?.devices.find((d) => d.view.inst.uid === uid)?.sendSerial?.(text);
        // (watching the real board too: it gets what's typed as well)
        void import('./ui/realboard').then((m) => m.realLinks.get(uid)?.mon.send(text.endsWith('\n') ? text : `${text}\n`).catch(() => {}));
      },
      saveForIde: (uid) => {
        let issues: import('./elec/check').Issue[] = [];
        try { issues = this.checker.check().now; } catch { /* (the check is extra) */ }
        void import('./ui/arduinoexport').then((m) => m.saveForIde(this.project, this.views, uid, issues, (msg, l) => this.log(msg, l))).catch((e) => this.log(`couldn't save it: ${(e as Error).message}`, 'bad'));
      },
      realBoard: (uid) => {
        const inst = this.instOf(uid);
        const prog = this.project.programs[uid];
        if (!inst) return;
        void import('./ui/realboard').then((m) => m.openRealBoard({
          board: { uid, type: inst.type, name: inst.name, source: prog?.source ?? '', lang: prog?.lang ?? 'arduino' },
          log: (msg, l) => this.log(msg, l),
          serial: (text) => this.dock.appendRealSerial(uid, text),
        }));
      },
    });
    this.stage.gizmo.addEventListener('mouseDown', () => {
      this.snapshot();
      const v = this.selected ? this.views.get(this.selected) : null;
      if (!v) return;
      this.placePivot(v);
      v.root.updateWorldMatrix(true, false);
      this.pivotDrag = this.pivot.matrixWorld.clone().invert().multiply(v.root.matrixWorld);
    });
    this.stage.gizmo.addEventListener('mouseUp', () => {
      this.pivotDrag = null;
      const v = this.selected ? this.views.get(this.selected) : null;
      if (v) this.placePivot(v);
    });
    this.stage.gizmo.addEventListener('objectChange', () => this.gizmoMoved());

    this.buildToolbar();
    this.buildCatalog();
    onLibrariesChanged(() => {
      this.buildCatalog();
      this.refreshAll();
    });
    this.dom.status.append(this.statusEls.mode, this.statusEls.parts, this.statusEls.time, this.statusEls.log);
    this.bindInput();

    const saved = (() => { try { return localStorage.getItem(AUTOSAVE_KEY); } catch { return null; } })();
    if (saved) {
      const { project, problems } = validate(JSON.parse(saved));
      if (project && project.parts.length) {
        this.project = project;
        this.log(`your last bench is back (${project.parts.length} parts)` + (problems.length ? `; ${problems.join('; ')}` : ''));
      }
    }
    this.rebuild();
    this.refreshAll();
    requestAnimationFrame((t) => this.frame(t));
    this.log('ready: pick a part on the left, then click on the bench to place it');
  }

  // ------------------------------------------------------------------------------------ messages
  log(msg: string, level: 'info' | 'warn' | 'bad' = 'info') {
    this.statusEls.log.textContent = msg;
    this.statusEls.log.className = level === 'info' ? '' : level;
    console[level === 'info' ? 'log' : 'warn'](`[bench] ${msg}`);
    if (level !== 'info') this.toast(msg, level);
  }
  toast(msg: string, level: 'info' | 'warn' | 'bad' = 'info') {
    const t = el('div', { className: `toast ${level === 'info' ? '' : level}`, textContent: msg });
    this.toastHost.append(t);
    setTimeout(() => t.remove(), level === 'info' ? 3500 : 8000);
  }

  // ------------------------------------------------------------------------------------ project <-> view
  rebuild() {
    for (const v of this.views.values()) disposeView(v);
    this.views.clear();
    this.stage.gizmo.detach();
    for (const inst of parentFirst(this.project.parts)) {
      const v = makeView(inst);
      const parentObj = inst.parent ? this.views.get(inst.parent.uid)?.bodies.get(inst.parent.body) : null;
      if (inst.parent && !parentObj) inst.parent = null; // its body no longer exists (part type changed)
      (parentObj ?? this.stage.partsRoot).add(v.root);
      v.root.position.set(...inst.pos);
      v.root.quaternion.set(...inst.rot);
      this.views.set(inst.uid, v);
    }
    if (this.selected && !this.views.has(this.selected)) this.selected = null;
    if (this.selectedWire && !this.project.wires.some((w) => w.id === this.selectedWire)) this.selectedWire = null;
    // wires saved before wires had a length: as long as they are now, plus the usual slack
    for (const w of this.project.wires)
      if (!w.length) {
        const pa = pinWorld(this.views, w.a), pb = pinWorld(this.views, w.b);
        if (pa && pb) w.length = wireLengthFor(pa.distanceTo(pb));
      }
    this.applySelection();
  }

  /** Pin markers: on every part while wiring, on the selected part otherwise, none while running. */
  private refreshMarkers() {
    for (const v of this.views.values()) {
      const show = this.mode === 'build' && (this.wiring || v.inst.uid === this.selected);
      if (show && v.build.pins?.length) addPinMarkers(v);
      else removePinMarkers(v);
    }
  }

  /** Wire two pins (from code, or the Wire tool). Returns the wire's id, or null if it's not allowed. */
  connect(a: PinRef, b: PinRef, color?: string) {
    const va = this.views.get(a.uid), vb = this.views.get(b.uid);
    if (!va || !vb || !pinDef(va, a.pin) || !pinDef(vb, b.pin)) throw new Error(`no such pin: ${a.uid}/${a.pin} or ${b.uid}/${b.pin}`);
    if (a.uid === b.uid && a.pin === b.pin) return null;
    const same = (x: PinRef, y: PinRef) => x.uid === y.uid && x.pin === y.pin;
    if (this.project.wires.some((w) => (same(w.a, a) && same(w.b, b)) || (same(w.a, b) && same(w.b, a)))) return null;
    this.snapshot();
    const id = newUid();
    const length = wireLengthFor(pinWorld(this.views, a)!.distanceTo(pinWorld(this.views, b)!));
    this.project.wires.push({ id, a, b, color: color ?? WIRE_COLORS[this.project.wires.length % WIRE_COLORS.length], length });
    this.changed(false);
    this.log(`wired ${this.nameOf(a.uid)} ${a.pin} to ${this.nameOf(b.uid)} ${b.pin} (${length} cm of wire)`);
    return id;
  }
  deleteWire(id: string) {
    this.snapshot();
    this.project.wires = this.project.wires.filter((w) => w.id !== id);
    if (this.selectedWire === id) this.selectedWire = null;
    this.changed(false);
    this.log('wire removed');
  }
  toggleWiring(on = !this.wiring) {
    if (this.mode !== 'build') this.stop();
    this.cancelPlacing();
    this.wiring = on;
    this.wireStart = null;
    this.rubber.visible = false;
    this.refreshMarkers();
    this.refreshAll();
  }
  async loadFirmware(uid: string) {
    const { openBinary } = await import('./files');
    const f = await openBinary(['uf2']);
    if (!f) return;
    const prog = this.project.programs[uid] ?? { lang: 'js', source: '' };
    let b64 = '';
    const bytes = f.bytes;
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.project.programs[uid] = { ...prog, firmware: btoa(b64), firmwareName: f.name.split(/[\\/]/).pop() };
    this.dirty = true;
    this.dock.refreshFirmwareNote();
    this.log(`${this.nameOf(uid)} will run ${f.name.split(/[\\/]/).pop()} (${Math.round(bytes.length / 1024)} KB)`);
  }

  private snapshot() {
    this.undo.push(JSON.stringify(this.project));
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
  }
  private changed(rebuild = true) {
    this.dirty = true;
    if (rebuild) this.rebuild();
    this.refreshAll();
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.project)); } catch { /* storage off: no autosave */ }
  }
  undoStep(back: boolean) {
    if (this.mode !== 'build') return;
    const from = back ? this.undo : this.redo, to = back ? this.redo : this.undo;
    const s = from.pop();
    if (!s) return;
    this.dock.flush();
    to.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.dock.projectChanged();
    this.changed();
    this.log(back ? 'undone' : 'redone');
  }

  /** World matrix of something that hangs off part `uid` (or the bench). */
  private worldOf(inst: PartInst) {
    return this.views.get(inst.uid)!.root.matrixWorld.clone();
  }
  /** Set a part's pose (and parent) so that it lands at world matrix `m`. */
  private setWorld(inst: PartInst, m: THREE.Matrix4, parent: { uid: string; body: string } | null) {
    let local = m.clone();
    if (parent) {
      const pb = this.views.get(parent.uid)!.bodies.get(parent.body)!;
      pb.updateWorldMatrix(true, false);
      local = pb.matrixWorld.clone().invert().multiply(m);
    }
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    local.decompose(p, q, s);
    inst.parent = parent;
    inst.pos = p.toArray() as V3;
    inst.rot = q.toArray() as Q4;
  }

  // ------------------------------------------------------------------------------------ building
  startPlacing(type: PartType) {
    if (this.mode !== 'build') this.stop();
    this.cancelPlacing();
    const inst: PartInst = { uid: 'ghost', type: type.id, name: type.name, params: { ...type.defaults }, parent: null, pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    const ghost = makeView(inst);
    for (const m of viewMeshes(ghost)) {
      const mat = (m.material as THREE.MeshStandardMaterial);
      mat.transparent = true;
      mat.opacity = 0.55;
      mat.depthWrite = false;
      m.userData.ghost = true;
      m.castShadow = false;
    }
    ghost.root.visible = false;
    this.stage.overlay.add(ghost.root);
    this.placing = { type, ghost, spin: 0, valid: false, hit: null };
    this.select(null);
    this.refreshAll();
  }
  cancelPlacing() {
    this.gridDots.visible = false;
    if (!this.placing) return;
    disposeView(this.placing.ghost);
    this.placing = null;
    this.refreshAll();
  }
  private placingPose(hit: NonNullable<ReturnType<Stage['pick']>>, spin: number, snap = false, type?: PartType, params?: Record<string, any>) {
    const n = hit.normal.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(n, spin));
    const p = hit.point.clone();
    if (type?.upright) {
      // (it stands upright whatever it's put on: turned only about the vertical; under something, it
      //  hangs below with its top against the face)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin);
      if (n.y < -0.5) p.y -= type.upright({ ...type.defaults, ...(params ?? {}) });
    }
    if (hit.ground) {
      p.y = 0;
      if (snap && this.grid.snap) {
        p.x = this.snapTo(p.x);
        p.z = this.snapTo(p.z);
      }
    } else if (snap && this.grid.snap && hit.object?.userData?.uid) {
      p.copy(this.snapOnPart(hit.object.userData.uid, hit.object.userData.body, p, n));
    }
    return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
  }

  // ------------------------------------------------------------------------------------ the grid
  /** snapping while building: on/off, the step (cm), and whether a part you put things on gets a grid
   *  of its own that fits it (each side divided evenly, so its edges and middle are on it) */
  grid = (() => {
    const d = { snap: true, size: 0.5, fit: true };
    try { return { ...d, ...JSON.parse(localStorage.getItem('bench.grid') ?? '{}') }; } catch { return d; }
  })() as { snap: boolean; size: number; fit: boolean };
  setGrid(change: Partial<App['grid']>) {
    Object.assign(this.grid, change);
    try { localStorage.setItem('bench.grid', JSON.stringify(this.grid)); } catch { /* not remembered */ }
    this.stage.gizmo.setRotationSnap(this.grid.snap ? THREE.MathUtils.degToRad(5) : null);
    this.gridDots.visible = false;
    this.showGridState?.();
    console.info(`[grid] snap ${this.grid.snap ? `on, ${this.grid.size} cm` : 'off'}, parts' own grids ${this.grid.fit ? 'on' : 'off'}`);
  }
  private showGridState: (() => void) | null = null;
  private snapTo(x: number, step = this.grid.size) {
    return Math.round(x / step) * step;
  }
  /** A body's box in its own frame (its own pieces only: not the parts glued onto it). */
  private bodyBox(uid: string, body: string) {
    const o = this.views.get(uid)?.bodies.get(body);
    const box = new THREE.Box3();
    if (!o) return box;
    o.updateWorldMatrix(true, true);
    const inv = o.matrixWorld.clone().invert();
    const m = new THREE.Matrix4(), b = new THREE.Box3();
    o.traverse((x) => {
      const mesh = x as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.uid !== uid || (mesh.userData.body && mesh.userData.body !== body) || !mesh.visible) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      b.copy(mesh.geometry.boundingBox!).applyMatrix4(m.multiplyMatrices(inv, mesh.matrixWorld));
      box.union(b);
    });
    return box;
  }
  /** The grid on one side of a body: for each of the side's two directions, where its lines start and
   *  how far apart they are. Its own grid fits the side (an even number of steps edge to edge, about
   *  the grid size, so both edges and the middle are on it); without, the plain grid from its centre. */
  private faceGrid(box: THREE.Box3, axis: number) {
    const out: { axis: number; lo: number; hi: number; start: number; step: number }[] = [];
    for (const a of [0, 1, 2]) {
      if (a === axis) continue;
      const lo = box.min.getComponent(a), hi = box.max.getComponent(a), w = hi - lo;
      if (this.grid.fit && w > 1e-6) {
        const n = Math.max(2, 2 * Math.round(w / (2 * this.grid.size)));
        out.push({ axis: a, lo, hi, start: lo, step: w / n });
      } else out.push({ axis: a, lo, hi, start: 0, step: this.grid.size });
    }
    return out;
  }
  /** A point on a part, moved to the nearest point of that part's grid (on a flat side; on a slanted or
   *  curved one it stays where it is). In and out: world coordinates. */
  private snapOnPart(uid: string, body: string, world: THREE.Vector3, normal: THREE.Vector3) {
    const o = this.views.get(uid)?.bodies.get(body);
    if (!o) return world.clone();
    const box = this.bodyBox(uid, body);
    if (box.isEmpty()) return world.clone();
    o.updateWorldMatrix(true, false);
    const local = o.worldToLocal(world.clone());
    const ln = normal.clone().transformDirection(o.matrixWorld.clone().invert());
    const axis = [0, 1, 2].reduce((b, a) => (Math.abs(ln.getComponent(a)) > Math.abs(ln.getComponent(b)) ? a : b), 0);
    if (Math.abs(ln.getComponent(axis)) < 0.95) return world.clone();
    for (const g of this.faceGrid(box, axis)) {
      const v = g.start + Math.round((local.getComponent(g.axis) - g.start) / g.step) * g.step;
      local.setComponent(g.axis, Math.min(g.hi, Math.max(g.lo, v)));
    }
    this.showGridDots(uid, body, box, axis, Math.sign(ln.getComponent(axis)));
    return o.localToWorld(local);
  }
  /** dots showing the grid of the side you're putting something on (or moving something along) */
  private gridDots = (() => {
    const p = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x7fd4ff, size: 4, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.85 }));
    p.visible = false;
    p.renderOrder = 10;
    p.matrixAutoUpdate = false;
    return p;
  })();
  private gridDotsKey = '';
  private showGridDots(uid: string, body: string, box: THREE.Box3, axis: number, side: number) {
    const o = this.views.get(uid)!.bodies.get(body)!;
    if (!this.gridDots.parent) this.stage.overlay.add(this.gridDots);
    const key = `${uid}/${body}/${axis}/${side}/${this.grid.size}/${this.grid.fit}`;
    if (key !== this.gridDotsKey) {
      this.gridDotsKey = key;
      const [g1, g2] = this.faceGrid(box, axis);
      const ticks = (g: (typeof g1)) => {
        const t: number[] = [];
        const first = g.start + Math.ceil((g.lo - g.start) / g.step - 1e-6) * g.step;
        for (let v = first; v <= g.hi + 1e-6 && t.length < 400; v += g.step) t.push(v);
        return t;
      };
      const a = ticks(g1), b = ticks(g2);
      const pts: number[] = [];
      const h = side > 0 ? box.max.getComponent(axis) : box.min.getComponent(axis);
      const v = new THREE.Vector3();
      for (const x of a) for (const y of b) {
        if (pts.length > 3 * 6000) break;
        v.setComponent(axis, h + side * 0.01);
        v.setComponent(g1.axis, x);
        v.setComponent(g2.axis, y);
        pts.push(v.x, v.y, v.z);
      }
      this.gridDots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.gridDots.geometry.computeBoundingSphere();
    }
    o.updateWorldMatrix(true, false);
    this.gridDots.matrix.copy(o.matrixWorld);
    this.gridDots.matrixWorldNeedsUpdate = true;
    this.gridDots.visible = true;
  }
  /** A part moved with the arrows: onto the grid (the bench's, or its own grid on the part it's glued
   *  to, along the side it sits on). */
  private snapMoved(v: PartView) {
    if (!this.grid.snap) return;
    const r = v.root;
    const par = v.inst.parent;
    if (!par) {
      r.position.x = this.snapTo(r.position.x);
      r.position.z = this.snapTo(r.position.z);
      r.position.y = Math.round(r.position.y * 10) / 10; // (up and down: to the millimetre)
      return;
    }
    const box = this.bodyBox(par.uid, par.body);
    if (box.isEmpty()) return;
    // the side it sits on: its own "up" (the way it was put on), in the parent body's frame
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.quaternion);
    const axis = [0, 1, 2].reduce((b, a) => (Math.abs(up.getComponent(a)) > Math.abs(up.getComponent(b)) ? a : b), 0);
    for (const g of this.faceGrid(box, axis)) {
      const val = g.start + Math.round((r.position.getComponent(g.axis) - g.start) / g.step) * g.step;
      r.position.setComponent(g.axis, val);
    }
    r.position.setComponent(axis, Math.round(r.position.getComponent(axis) * 100) / 100);
    if (Math.abs(up.getComponent(axis)) > 0.95) this.showGridDots(par.uid, par.body, box, axis, Math.sign(up.getComponent(axis)));
  }
  private placingMove(ev: PointerEvent) {
    const pl = this.placing!;
    const hit = this.stage.pick(ev, [this.stage.partsRoot]);
    pl.hit = hit;
    pl.valid = !!hit;
    pl.ghost.root.visible = !!hit;
    if (!hit) return;
    if (hit.ground || !this.grid.snap) this.gridDots.visible = false;
    const m = this.placingPose(hit, pl.spin, true, pl.type);
    m.decompose(pl.ghost.root.position, pl.ghost.root.quaternion, pl.ghost.root.scale);
    const onto = hit.ground ? 'the bench' : this.project.parts.find((p) => p.uid === hit.object.userData.uid)?.name;
    this.hint(`Click to put ${pl.type.name} on ${onto}${hit.ground ? '' : ' (it gets glued to it)'}  ·  R turn  ·  Shift-click keeps placing  ·  Esc stop`);
  }
  private placingClick(ev: PointerEvent) {
    const pl = this.placing!;
    this.placingMove(ev);
    if (!pl.valid || !pl.hit) return;
    this.snapshot();
    const inst: PartInst = {
      uid: newUid(), type: pl.type.id, name: uniqueName(this.project, pl.type.name), params: { ...pl.type.defaults },
      parent: null, pos: [0, 0, 0], rot: [0, 0, 0, 1],
    };
    const parent = pl.hit.ground ? null : { uid: pl.hit.object.userData.uid as string, body: pl.hit.object.userData.body as string };
    if (pl.type.fixed && !parent) inst.pinned = true; // (a course put on the bench stays put)
    this.setWorld(inst, this.placingPose(pl.hit, pl.spin, true, pl.type, inst.params), parent);
    this.gridDots.visible = false;
    this.project.parts.push(inst);
    this.changed();
    this.log(`${inst.name} placed${parent ? ` on ${this.nameOf(parent.uid)}` : ''}`);
    if (!ev.shiftKey) {
      this.cancelPlacing();
      this.select(inst.uid);
    }
  }

  /** Place a part from code (examples, tests): its mounting face on `point`, facing along `normal`,
   *  turned `spin` rad about it, glued to `onto` (or loose). Returns the new part's uid. */
  placeAt(typeId: string, point: V3, normal: V3, opts: { spin?: number; along?: V3; onto?: { uid: string; body: string } | null; params?: Record<string, any>; name?: string; pinned?: boolean } = {}) {
    if (opts.along) {
      // turn about the normal so the part's own X axis (its length, for blocks) points `along`
      const n = new THREE.Vector3(...normal).normalize();
      const x0 = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n));
      const want = new THREE.Vector3(...opts.along).projectOnPlane(n).normalize();
      opts = { ...opts, spin: Math.atan2(x0.clone().cross(want).dot(n), x0.dot(want)) };
    }
    const type = PART_BY_ID.get(typeId);
    if (!type) throw new Error(`no part type ${typeId}`);
    const inst: PartInst = {
      uid: newUid(), type: typeId, name: opts.name ?? uniqueName(this.project, type.name), params: { ...type.defaults, ...(opts.params ?? {}) },
      parent: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], pinned: opts.pinned ?? (type.fixed && !opts.onto ? true : undefined),
    };
    const hit = { point: new THREE.Vector3(...point), normal: new THREE.Vector3(...normal).normalize(), object: null as any, ground: false };
    this.setWorld(inst, this.placingPose(hit, opts.spin ?? 0, false, type, inst.params), opts.onto ?? null);
    this.project.parts.push(inst);
    this.changed();
    return inst.uid;
  }
  /** World position and +Y direction of a part's body (for placing things on it from code). */
  bodyFrame(uid: string, body: string) {
    const o = this.views.get(uid)!.bodies.get(body)!;
    o.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const q = new THREE.Quaternion().setFromRotationMatrix(o.matrixWorld);
    return { pos: p, quat: q, up: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
  }

  select(uid: string | null) {
    this.selected = uid;
    this.gluing = null;
    this.belting = null;
    if (uid) this.selectedWire = null;
    this.applySelection();
    this.refreshAll();
  }
  private applySelection() {
    for (const v of this.views.values()) setHighlight(v, v.inst.uid === this.selected);
    const v = this.selected ? this.views.get(this.selected) : null;
    if (v && this.mode === 'build' && !this.wiring) {
      this.placePivot(v);
      this.stage.gizmo.attach(this.pivot);
    } else this.stage.gizmo.detach();
    this.refreshMarkers();
  }

  // ------------------------------------------------------------------------------------ the pivot
  /** where the move / turn arrows sit on the selected part: its centre (default), its centre of mass,
   *  or its base (where it's glued on). The arrows move this handle; the part follows it. */
  pivotMode: 'centre' | 'mass' | 'base' = (() => {
    try { const m = localStorage.getItem('bench.pivot'); return m === 'mass' || m === 'base' ? m : 'centre'; } catch { return 'centre'; }
  })();
  setPivotMode(m: App['pivotMode']) {
    this.pivotMode = m;
    try { localStorage.setItem('bench.pivot', m); } catch { /* not remembered */ }
    this.showGridState?.();
    const v = this.selected ? this.views.get(this.selected) : null;
    if (v) this.placePivot(v);
    console.info(`[pivot] move and turn about the part's ${m === 'mass' ? 'centre of mass' : m}`);
  }
  pivot = new THREE.Object3D();
  /** the handle's place when a drag began, and the part's (relative to it) */
  private pivotDrag: THREE.Matrix4 | null = null;
  /** A part's own pieces (not what's glued on it): their middle, or their middle weighted by weight. */
  pivotPoint(v: PartView, mode = this.pivotMode) {
    v.root.updateWorldMatrix(true, true);
    if (mode === 'base') return new THREE.Vector3().setFromMatrixPosition(v.root.matrixWorld);
    const all = new THREE.Box3(), b = new THREE.Box3();
    const byBody = new Map<string, THREE.Box3>();
    v.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.uid !== v.inst.uid || !m.visible || m.userData.ghost) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
      all.union(b);
      const name = m.userData.body ?? 'body';
      if (!byBody.has(name)) byBody.set(name, new THREE.Box3());
      byBody.get(name)!.union(b);
    });
    if (all.isEmpty()) return new THREE.Vector3().setFromMatrixPosition(v.root.matrixWorld);
    if (mode === 'centre') return all.getCenter(new THREE.Vector3());
    // centre of mass: each body's middle, weighted by its weight
    const c = new THREE.Vector3();
    let total = 0;
    for (const bd of v.build.bodies) {
      const box = byBody.get(bd.name);
      if (!box || box.isEmpty()) continue;
      c.addScaledVector(box.getCenter(new THREE.Vector3()), bd.mass);
      total += bd.mass;
    }
    return total > 0 ? c.divideScalar(total) : all.getCenter(new THREE.Vector3());
  }
  /** Put the handle on the part's pivot, turned as the part is (its arrows along the part's own axes). */
  placePivot(v: PartView) {
    if (!this.pivot.parent) this.stage.overlay.add(this.pivot);
    this.pivot.position.copy(this.pivotPoint(v));
    v.root.getWorldQuaternion(this.pivot.quaternion);
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
  }
  /** The handle moved: the part goes with it, keeping where it was relative to it. */
  private followPivot(v: PartView) {
    if (!this.pivotDrag) return;
    this.pivot.updateMatrixWorld(true);
    const world = this.pivot.matrixWorld.clone().multiply(this.pivotDrag);
    const parent = v.root.parent!;
    parent.updateWorldMatrix(true, false);
    const local = parent.matrixWorld.clone().invert().multiply(world);
    const sc = new THREE.Vector3();
    local.decompose(v.root.position, v.root.quaternion, sc);
    v.root.updateMatrixWorld(true);
  }
  private gizmoMoved() {
    const v = this.selected ? this.views.get(this.selected) : null;
    if (!v) return;
    if (this.stage.gizmo.dragging && this.pivotDrag) this.followPivot(v);
    if (this.stage.gizmo.dragging && this.stage.gizmo.mode === 'translate') this.snapMoved(v);
    if (!this.stage.gizmo.dragging) this.placePivot(v); // (moved another way: R, undo...)
    this.stretchWires(v.inst.uid);
    v.inst.pos = v.root.position.toArray() as V3;
    v.inst.rot = v.root.quaternion.toArray() as Q4;
    this.dirty = true;
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.project)); } catch { /* no autosave */ }
    this.refreshReadouts();
  }

  /** Wires don't stretch: moving a part drags along the loose parts its tight wires lead to (and
   *  theirs, down the chain). A part fixed to the bench holds, and then the part being moved stops. */
  /** While building, the wires of a part being dragged follow it: longer as it moves away, shorter
   *  again as it comes back (always the distance plus a little slack), and nothing else moves. Wires
   *  of parts not being moved keep the length they have. (While running, wires keep their length.) */
  stretchWires(moved: string) {
    const inMoved = subtree(this.project.parts, moved); // the part and everything glued to it
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    for (const w of this.project.wires) {
      if (!inMoved.has(w.a.uid) && !inMoved.has(w.b.uid)) continue;
      if (inMoved.has(w.a.uid) && inMoved.has(w.b.uid)) continue; // both ends move together
      if (!pinWorld(this.views, w.a, pa) || !pinWorld(this.views, w.b, pb)) continue;
      w.length = wireLengthFor(pa.distanceTo(pb));
    }
  }

  /** (the old behaviour: tight wires drag the loose parts at their other ends; kept for scripts) */
  pullWires(moved: string) {
    const inst = (uid: string) => this.project.parts.find((p) => p.uid === uid);
    const topOf = (uid: string) => {
      let p = inst(uid);
      while (p?.parent) p = inst(p.parent.uid);
      return p;
    };
    const mover = topOf(moved);
    if (!mover) return;
    const done = new Set<string>([mover.uid]);
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), d = new THREE.Vector3();
    const shift = (p: PartInst, by: THREE.Vector3) => {
      const v = this.views.get(p.uid)!;
      v.root.position.add(by);
      v.root.updateMatrixWorld(true);
      p.pos = v.root.position.toArray() as V3;
    };
    let held = false;
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const w of this.project.wires) {
        if (!w.length || !pinWorld(this.views, w.a, pa) || !pinWorld(this.views, w.b, pb)) continue;
        const dist = pa.distanceTo(pb);
        if (dist <= w.length + 0.01) continue;
        const ta = topOf(w.a.uid), tb = topOf(w.b.uid);
        if (!ta || !tb || ta === tb) continue;
        const aIn = done.has(ta.uid), bIn = done.has(tb.uid);
        if (aIn === bIn) continue; // neither reached yet (a later pass), or both already placed
        const follower = aIn ? tb : ta;
        d.subVectors(aIn ? pa : pb, aIn ? pb : pa).multiplyScalar((dist - w.length) / dist);
        if (follower.pinned) {
          // it can't come along: the part being moved stops at the wire's length instead
          shift(mover, d.negate());
          held = true;
          continue;
        }
        const fy = this.views.get(follower.uid)!.root.position.y;
        if (d.y < 0) d.y = Math.max(d.y, -Math.max(0, fy - 0.01)); // not into the bench
        shift(follower, d);
        done.add(follower.uid);
        changed = true;
      }
      if (!changed) break;
    }
    if (done.size > 1 || held) console.info(`[bench] moving ${mover.name}: ${done.size - 1} part(s) pulled along by wires${held ? ', held back by a wire to a fixed part' : ''}`);
  }

  deleteSelected() {
    if (!this.selected || this.mode !== 'build') return;
    this.snapshot();
    const gone = this.selected;
    for (const p of this.project.parts) if (p.parent?.uid === gone) this.setWorld(p, this.worldOf(p), null); // loose, same place
    const name = this.nameOf(gone);
    this.project.parts = this.project.parts.filter((p) => p.uid !== gone);
    this.project.wires = this.project.wires.filter((w) => w.a.uid !== gone && w.b.uid !== gone);
    if (this.project.belts) this.project.belts = this.project.belts.filter((b) => b.a !== gone && b.b !== gone);
    delete this.project.programs[gone];
    this.selected = null;
    this.changed();
    this.log(`${name} removed (anything glued to it stays where it was, loose)`);
  }
  duplicateSelected() {
    if (!this.selected || this.mode !== 'build') return;
    this.snapshot();
    const ids = subtree(this.project.parts, this.selected);
    const map = new Map<string, string>();
    for (const id of ids) map.set(id, newUid());
    const copies: PartInst[] = [];
    for (const p of this.project.parts)
      if (ids.has(p.uid)) {
        const c: PartInst = JSON.parse(JSON.stringify(p));
        c.uid = map.get(p.uid)!;
        c.name = uniqueName({ ...this.project, parts: [...this.project.parts, ...copies] }, PART_BY_ID.get(p.type)!.name);
        if (c.parent && map.has(c.parent.uid)) c.parent = { ...c.parent, uid: map.get(c.parent.uid)! };
        if (this.project.programs[p.uid]) this.project.programs[c.uid] = JSON.parse(JSON.stringify(this.project.programs[p.uid]));
        if (p.uid === this.selected) {
          const m = this.worldOf(p).premultiply(new THREE.Matrix4().makeTranslation(3, 0, 3));
          this.project.parts.push(c); // temporarily, so setWorld can see the parent view
          this.setWorld(c, m, null);
          this.project.parts.pop();
        }
        copies.push(c);
      }
    this.project.parts.push(...copies);
    for (const w of [...this.project.wires]) // wires between copied parts are copied too
      if (map.has(w.a.uid) && map.has(w.b.uid))
        this.project.wires.push({ ...w, id: newUid(), a: { ...w.a, uid: map.get(w.a.uid)! }, b: { ...w.b, uid: map.get(w.b.uid)! } });
    this.changed();
    this.select(map.get(this.selected)!);
    this.log(`duplicated (${copies.length} part${copies.length > 1 ? 's' : ''})`);
  }
  unglueSelected() {
    const inst = this.instOf(this.selected);
    if (!inst?.parent) return;
    this.snapshot();
    this.setWorld(inst, this.worldOf(inst), null);
    this.changed();
    this.log(`${inst.name} is loose now`);
  }
  /** a part's pulley (or gear) that a belt can go round: its mechanical description */
  private beltWheel(uid: string) {
    const v = this.views.get(uid);
    return v?.build.mech?.find((m) => m.kind === 'pulley' || m.kind === 'gear') ?? null;
  }
  addBelt(a: string, b: string) {
    if (!this.beltWheel(a) || !this.beltWheel(b)) {
      this.log(`a belt goes between two pulleys: ${this.nameOf(b)} isn't one`, 'warn');
      this.refreshInspector();
      return null;
    }
    if ((this.project.belts ?? []).some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))) {
      this.log(`${this.nameOf(a)} and ${this.nameOf(b)} already have a belt`, 'warn');
      return null;
    }
    this.snapshot();
    const belt = { id: newUid(), a, b };
    (this.project.belts ??= []).push(belt);
    this.changed();
    const ra = this.beltWheel(a)!.radius, rb = this.beltWheel(b)!.radius;
    this.log(`belt from ${this.nameOf(a)} to ${this.nameOf(b)}: ${this.nameOf(b)} turns ${(ra / rb).toFixed(2)}x as fast, the same way`);
    return belt.id;
  }
  removeBelt(id: string) {
    this.snapshot();
    this.project.belts = (this.project.belts ?? []).filter((x) => x.id !== id);
    this.changed();
  }
  /** belts drawn round their pulleys, wherever the pulleys are now (built or running) */
  private beltGroup = new THREE.Group();
  private beltMeshes = new Map<string, { mesh: THREE.Mesh; key: string }>();
  private drawBelts() {
    if (!this.beltGroup.parent) this.stage.overlay.add(this.beltGroup);
    const live = new Set<string>();
    for (const bt of this.project.belts ?? []) {
      const pa = this.beltPose(bt.a), pb = this.beltPose(bt.b);
      if (!pa || !pb) continue;
      live.add(bt.id);
      const key = [...pa.c.toArray(), ...pb.c.toArray(), ...pa.n.toArray()].map((x) => x.toFixed(3)).join(',');
      let m = this.beltMeshes.get(bt.id);
      if (m && m.key === key) continue;
      const pts = beltPath(pa.c, pa.r, pb.c, pb.r, pa.n);
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0), pts.length * 2, 0.08, 6, true);
      if (!m) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: bt.color ?? '#202226', roughness: 0.8 }));
        this.beltGroup.add(mesh);
        m = { mesh, key };
        this.beltMeshes.set(bt.id, m);
      } else {
        m.mesh.geometry.dispose();
        m.mesh.geometry = geo;
        m.key = key;
      }
    }
    for (const [id, m] of this.beltMeshes) if (!live.has(id)) {
      m.mesh.geometry.dispose();
      this.beltGroup.remove(m.mesh);
      this.beltMeshes.delete(id);
    }
  }
  private beltPose(uid: string) {
    const v = this.views.get(uid), d = this.beltWheel(uid);
    const o = d && v?.bodies.get(d.body);
    if (!d || !o) return null;
    o.updateWorldMatrix(true, false);
    return { c: new THREE.Vector3(...d.at).applyMatrix4(o.matrixWorld), n: new THREE.Vector3(...d.axis).transformDirection(o.matrixWorld).normalize(), r: d.radius };
  }
  private glueTo(targetUid: string, body: string) {
    const inst = this.instOf(this.gluing)!;
    this.gluing = null;
    if (subtree(this.project.parts, inst.uid).has(targetUid)) {
      this.log(`can't glue ${inst.name} to ${this.nameOf(targetUid)}: that one is already glued onto ${inst.name}`, 'warn');
      this.refreshInspector();
      return;
    }
    this.snapshot();
    this.setWorld(inst, this.worldOf(inst), { uid: targetUid, body });
    this.changed();
    this.log(`${inst.name} glued to ${this.nameOf(targetUid)} (${body})`);
  }

  // ------------------------------------------------------------------------------------ running
  run() {
    if (this.mode === 'paused') {
      this.mode = 'run';
      this.refreshAll();
      return;
    }
    if (this.mode === 'run') return;
    benchAudio.unlock(); // (a click: sound may start now)
    // a quick look at the wiring first: say if something is broken (it still runs: seeing it fail is useful too)
    try {
      const { now } = this.checker.check();
      const broken = now.filter((i) => i.level === 'fault');
      if (broken.length) this.log(`Check found ${broken.length} broken thing${broken.length > 1 ? 's' : ''} in the wiring (press Check): ${broken[0].what}`, 'bad');
    } catch (e) {
      console.warn('[check] failed:', e);
    }
    this.cancelPlacing();
    this.wiring = false;
    this.wireStart = null;
    this.rubber.visible = false;
    this.mode = 'run'; // (markers off before the bodies move)
    this.refreshMarkers();
    this.stage.gizmo.detach();
    for (const v of this.views.values()) setHighlight(v, false);
    try {
      const views = parentFirst(this.project.parts).map((p) => this.views.get(p.uid)!);
      const bonds = findBonds(views); // (where each glued part sits: before the bodies move to the run scene)
      this.sim = new Sim(this.R, views, this.stage.runRoot, (m, l) => this.log(m, l), this.project.belts ?? []);
      this.sim.glue = this.glueCheck = new GlueCheck(this.sim, bonds, this.project.glue ?? DEFAULT_GLUE, (m, l) => this.log(m, l));
      if ((this.project.gravity ?? 1) !== 1) this.sim.setGravity(this.project.gravity ?? 1);
      for (const w of this.project.wires) {
        const va = this.views.get(w.a.uid), vb = this.views.get(w.b.uid);
        const da = va && pinDef(va, w.a.pin), db = vb && pinDef(vb, w.b.pin);
        const pa = pinWorld(this.views, w.a), pb = pinWorld(this.views, w.b);
        if (da && db && pa && pb) this.sim.addWire(w.id, { uid: w.a.uid, body: da.body }, pa, { uid: w.b.uid, body: db.body }, pb, w.length ?? wireLengthFor(pa.distanceTo(pb)));
      }
      if (this.sim.ropes) console.info(`[bench] ${this.sim.ropes} wires hold their length between moving pieces (they snap past ${Sim.WIRE_BREAK_N} N)`);
      this.sim.onWireSnap = (id, n) => {
        const w = this.project.wires.find((x) => x.id === id);
        this.circuit?.snapWire(id);
        if (w) this.log(`a wire snapped: ${this.nameOf(w.a.uid)} ${w.a.pin} to ${this.nameOf(w.b.uid)} ${w.b.pin} (pulled with ${n.toFixed(1)} N). It's back when you press Stop; give it more length (select it) if it needs to stretch.`, 'warn');
      };
      this.net = new BenchNetwork(this.project.wifi ?? DEFAULT_WIFI, (m, l) => this.log(m, l));
      const hooks: DeviceHooks = {
        net: this.net,
        serial: (uid, text) => this.dock.appendSerial(uid, text),
        log: (m, l) => this.log(m, l),
        program: (uid) => this.project.programs[uid],
        error: (uid, line, msg) => this.dock.markError(uid, line, msg),
      };
      const devices = views.map((v) => DEVICE_MAKERS[v.inst.type]?.(v, hooks, this.project) ?? null).filter((d): d is Device => !!d);
      for (const d of devices) if (PART_BY_ID.get(d.view.inst.type)?.programmable) this.dock.appendSerial(d.view.inst.uid, '\n--- run started ---\n');
      this.circuit = new Circuit(this.project, views, devices, this.sim, (m, l) => this.log(m, l));
      this.circuit.build();
      this.pinGraph.restart();
      this.loadWatch.reset();
    } catch (e) {
      this.log(`couldn't start: ${(e as Error).message}`, 'bad');
      console.error(e);
      this.circuit?.dispose();
      this.circuit = null;
      this.sim?.dispose();
      this.sim = null;
      this.stage.runRoot.clear();
      this.mode = 'build';
      this.rebuild();
      return;
    }
    this.mode = 'run';
    this.acc = 0;
    this.refreshAll();
  }
  /** Run the simulation forward `seconds` (for tests and scripts), letting program threads keep up. */
  async advance(seconds: number) {
    if (!this.sim) this.run();
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      this.circuit?.step(STEP);
      this.sim!.step();
      if (this.circuit) this.pinGraph.sample(this.circuit);
      // the scene follows the bodies every frame's worth (1/60 s), as it does live: cameras (line
      // sensors, colour trackers) look from where their part is now, not where the call started
      if (i % 4 === 3) this.sim!.sync();
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
    this.sim!.sync();
  }
  /** Run every example for a while and report what happened (tools/check_examples.mjs). */
  async checkExamples(opts: import('./dev/examplecheck').CheckOptions = {}) {
    const m = await import('./dev/examplecheck');
    return m.checkExamples(this, opts);
  }
  pause() {
    if (this.mode === 'run') this.mode = 'paused';
    else if (this.mode === 'paused') this.mode = 'run';
    this.refreshAll();
  }
  stop() {
    if (this.mode === 'build') return;
    this.glueCheck = null;
    this.circuit?.dispose();
    this.circuit = null;
    benchAudio.clear();
    this.net?.dispose(); // (boards' web servers close: their pages stop answering)
    this.net = null;
    this.webView.stopped();
    this.pressed = null;
    this.sim?.dispose();
    this.sim = null;
    this.stage.runRoot.clear();
    this.grabLine.visible = false;
    this.hand.hide();
    this.mode = 'build';
    this.rebuild(); // everything back where it was built
    this.refreshAll();
    this.log('stopped: back to building (positions as built)');
  }

  private frame(t: number) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    if (this.sim && this.mode === 'run') {
      // a game pad or the keyboard playing a PS2 controller's receiver, if one is on the bench
      if (this.circuit) this.pad.update(this.circuit.devices);
      this.acc += dt * this.speed;
      let n = 0;
      while (this.acc >= STEP && n < 40) {
        this.circuit?.step(STEP);
        this.sim.step();
        if (this.circuit) this.pinGraph.sample(this.circuit);
        this.acc -= STEP;
        n++;
      }
      if (n === 40) this.acc = 0; // the PC can't keep up: slow motion rather than a spiral
      this.moveHeld(dt);
      this.sim.sync();
      const gp = this.sim.grabPoint();
      if (gp) {
        const pos = this.grabLine.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, gp.x, gp.y, gp.z);
        pos.needsUpdate = true;
        this.hand.place(gp, this.stage.camera);
      }
    }
    const broken = this.circuit?.broken;
    // the camera never rolls, whatever turned it
    if (this.stage.camera.up.y !== 1) this.stage.camera.up.set(0, 1, 0);
    this.wires.sync(broken?.size ? this.project.wires.filter((w) => !broken.has(w.id)) : this.project.wires, this.views, this.selectedWire);
    if (Math.floor(t / 200) !== Math.floor((t - dt * 1000) / 200)) this.refreshReadouts();
    if (this.project.belts?.length || this.beltMeshes.size) this.drawBelts();
    this._ins?.update();
    this._balance?.update();
    this.stage.render();
    requestAnimationFrame((x) => this.frame(x));
  }

  // ------------------------------------------------------------------------------------ wiring
  /** The pin nearest the mouse on screen (within 14 px), if any. */
  private pinAt(ev: { clientX: number; clientY: number }) {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    let best: { ref: PinRef; d: number; depth: number } | null = null;
    const p = new THREE.Vector3();
    for (const v of this.views.values())
      for (const pd of v.build.pins ?? []) {
        const body = v.bodies.get(pd.body)!;
        p.set(...pd.pos).applyMatrix4(body.matrixWorld).project(this.stage.camera);
        if (p.z > 1) continue;
        const x = (p.x * 0.5 + 0.5) * r.width + r.left, y = (-p.y * 0.5 + 0.5) * r.height + r.top;
        const d = Math.hypot(x - ev.clientX, y - ev.clientY);
        if (d < 14 && (!best || d < best.d - 2 || (Math.abs(d - best.d) <= 2 && p.z < best.depth))) best = { ref: { uid: v.inst.uid, pin: pd.id }, d, depth: p.z };
      }
    return best?.ref ?? null;
  }
  private pinLabel(ref: PinRef) {
    const v = this.views.get(ref.uid)!;
    const d = pinDef(v, ref.pin)!;
    return `${v.inst.name}: ${d.label ?? d.id}`;
  }
  private wiringMove(ev: PointerEvent) {
    const pin = this.pinAt(ev);
    const pos = this.rubber.geometry.attributes.position as THREE.BufferAttribute;
    if (this.wireStart) {
      const a = this.views.get(this.wireStart.uid)!;
      const ad = pinDef(a, this.wireStart.pin)!;
      const pa = new THREE.Vector3(...ad.pos).applyMatrix4(a.bodies.get(ad.body)!.matrixWorld);
      let pb: THREE.Vector3 | null = null;
      if (pin) {
        const b = this.views.get(pin.uid)!;
        const bd = pinDef(b, pin.pin)!;
        pb = new THREE.Vector3(...bd.pos).applyMatrix4(b.bodies.get(bd.body)!.matrixWorld);
      } else pb = this.stage.pointOnViewPlane(ev, pa);
      if (pb) {
        pos.setXYZ(0, pa.x, pa.y, pa.z);
        pos.setXYZ(1, pb.x, pb.y, pb.z);
        pos.needsUpdate = true;
        this.rubber.computeLineDistances();
        this.rubber.visible = true;
      }
    }
    this.hint(pin
      ? `${this.pinLabel(pin)}  ·  click to ${this.wireStart ? 'connect' : 'start a wire'}`
      : this.wireStart ? `From ${this.pinLabel(this.wireStart)}: click the pin to wire it to  ·  Esc cancel` : 'Wire tool: click a pin, then another pin  ·  C or Esc to leave');
  }
  private wiringClick(ev: PointerEvent) {
    const pin = this.pinAt(ev);
    if (!pin) {
      if (this.wireStart) { this.wireStart = null; this.rubber.visible = false; }
      else { // clicking a wire while wiring selects it (to delete)
        const hit = this.stage.pick(ev, [this.wires.group], false);
        if (hit?.object.userData.wireId) {
          this.selectedWire = hit.object.userData.wireId;
          this.refreshInspector();
        }
      }
      return;
    }
    if (!this.wireStart) {
      this.wireStart = pin;
      return;
    }
    const id = this.connect(this.wireStart, pin);
    this.wireStart = null;
    this.rubber.visible = false;
    if (id) this.selectedWire = id;
    this.refreshAll();
  }

  // ------------------------------------------------------------------------------------ the hand
  /** Let go of what the grab holds. */
  private releaseGrab(ev: { clientX: number; clientY: number }) {
    this.sim?.grabEnd();
    this.grabLine.visible = false;
    this.grabPlane = null;
    this.stage.orbit.enabled = true;
    this.hand.setPose('open');
    this.handHover(ev);
  }
  /** Turn the camera round its target by a mouse movement (pixels): left-right about the vertical,
   *  up-down within limits. It never rolls: "up" stays straight up. The plane a held thing moves on
   *  turns to face the camera again, through where it is held now (so it doesn't jump). */
  private turnCamera(dx: number, dy: number) {
    const cam = this.stage.camera, o = this.stage.orbit;
    const off = cam.position.clone().sub(o.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= dx * 0.006;
    sph.phi = Math.max(0.08, Math.min(o.maxPolarAngle, sph.phi - dy * 0.006));
    cam.position.copy(o.target).add(new THREE.Vector3().setFromSpherical(sph));
    cam.up.set(0, 1, 0);
    cam.lookAt(o.target);
    const t = this.sim?.grabTarget();
    if (t) {
      const n = new THREE.Vector3();
      cam.getWorldDirection(n);
      this.grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, t);
    }
  }
  /** Each frame while holding something: WASD move the camera (as it faces), R / F up and down, and
   *  what it holds comes along, staying where it is in front of the camera. Shift is faster. */
  private moveHeld(dt: number) {
    if (!this.sim || !this.grabLine.visible || !this.keysDown.size) return;
    const k = this.keysDown;
    const fwd = new THREE.Vector3();
    this.stage.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3()
      .addScaledVector(fwd, (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0))
      .addScaledVector(right, (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0))
      .addScaledVector(new THREE.Vector3(0, 1, 0), (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0));
    if (move.lengthSq() < 1e-6) return;
    const speed = k.has('shift') ? 80 : 25; // cm/s
    move.normalize().multiplyScalar(speed * dt);
    const t = this.sim.grabTarget();
    if (!t) return;
    // the camera (and the point it turns round) moves; the held point moves with it, so it stays the
    // same distance in front of the camera (it can't go under the bench: then it just rests there)
    const cam = this.stage.camera, o = this.stage.orbit;
    cam.position.add(move);
    o.target.add(move);
    t.add(move);
    t.y = Math.max(0.3, t.y);
    this.sim.grabMove(t);
    this.grabPlane?.translate(move);
    const pos = this.grabLine.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(1, t.x, t.y, t.z);
    pos.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------ the hand (hover)
  /** Run mode, nothing held: the faint ball on what the mouse points at (something it can take), or,
   *  with Shift, the solid ball rolling along the bench (shoving things; the wheel raises it). */
  private handHover(ev: { clientX: number; clientY: number; shiftKey?: boolean }, shift = !!ev.shiftKey) {
    if (!this.sim) return;
    if (shift) {
      const y = 1.2 + this.pushLift;
      const ray = this.stage.rayAt(ev);
      const at = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
      if (!at || at.distanceTo(ray.origin) > 2000) return;
      this.hand.setPose('flat');
      this.hand.place(at, this.stage.camera);
      this.sim.handPush(at);
      this.hint(`Pushing with the ball: move the mouse to shove things${this.pushLift ? ` (${this.pushLift.toFixed(1)} cm up)` : ''}, wheel raises / lowers it, let go of Shift to stop`);
      return;
    }
    this.sim.handPush(null);
    const hit = this.stage.pick(ev, [this.stage.runRoot], false);
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.isBody) o = o.parent;
    const uid = hit?.object.userData.uid as string | undefined;
    const loose = !!(o && uid && this.sim.poseOf(uid, (hit!.object.userData.body as string) ?? 'body')?.fixed === false);
    if (hit && loose) {
      this.hand.setPose('open');
      this.hand.place(hit.point, this.stage.camera);
      this.stage.renderer.domElement.style.cursor = 'grab';
    } else {
      this.hand.hide();
      this.stage.renderer.domElement.style.cursor = '';
    }
  }

  // ------------------------------------------------------------------------------------ input
  private bindInput() {
    const c = this.stage.renderer.domElement;
    c.addEventListener('pointerdown', (ev) => {
      this.pointerDown = { x: ev.clientX, y: ev.clientY, button: ev.button };
      this.lastPointer = ev;
      if (this.mode !== 'build' && ev.button === 0 && this._ins?.mode) { this._ins.click(ev); return; }
      if (this.mode !== 'build' && ev.button === 0 && this.sim) {
        const hit = this.stage.pick(ev, [this.stage.runRoot], false);
        const dev = hit && this.circuit?.devices.find((d) => d.view.inst.uid === hit.object.userData.uid && d.press);
        if (dev && this.circuit) { // a button: press it (released on mouse up)
          dev.press!(true);
          this.pressed = dev;
          this.circuit.dirty = true;
          this.stage.orbit.enabled = false;
          return;
        }
        if (hit) {
          let o: THREE.Object3D | null = hit.object;
          while (o && !o.userData.isBody) o = o.parent;
          if (o && this.sim.grabStart(o, hit.point)) {
            this.stage.orbit.enabled = false;
            const n = new THREE.Vector3();
            this.stage.camera.getWorldDirection(n);
            this.grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
            this.hand.setPose('grip');
            this.hand.place(hit.point, this.stage.camera);
            this.hint(`Holding it (grip ${Math.round(this.sim.grip * 100)} %): mouse moves it; W A S D / R F move the camera and it comes along (Shift: faster), right-drag turns the camera, Q / E turn it, wheel = grip, let go to drop it`);
            this.grabLine.visible = true;
            const pos = this.grabLine.geometry.attributes.position as THREE.BufferAttribute;
            pos.setXYZ(1, hit.point.x, hit.point.y, hit.point.z);
            pos.needsUpdate = true;
            c.setPointerCapture(ev.pointerId);
          }
        }
      }
    });
    c.addEventListener('pointermove', (ev) => {
      if (this.placing) this.placingMove(ev);
      if (this.wiring) this.wiringMove(ev);
      const prevPointer = this.lastPointer;
      this.lastPointer = ev;
      if (this.sim && this.mode !== 'build' && !this.grabLine.visible) this.handHover(ev);
      if (this.sim && this.grabLine.visible && !(ev.buttons & 1)) {
        // (the left button came up while the right was down: no pointerup for that, so let go here)
        this.releaseGrab(ev);
        return;
      }
      if (this.sim && this.grabLine.visible && ev.buttons & 2) {
        // holding something, right button down: turn the camera round (it stays level), and the held
        // thing goes with the mouse: under the pointer, as far from the camera as it was
        if (!prevPointer) return;
        const held = this.sim.grabTarget();
        const dist = held ? this.stage.camera.position.distanceTo(held) : 0;
        this.turnCamera(ev.clientX - prevPointer.clientX, ev.clientY - prevPointer.clientY);
        if (held && dist > 0) {
          const ray = this.stage.rayAt(ev);
          const target = ray.origin.clone().addScaledVector(ray.direction, dist);
          target.y = Math.max(0.3, target.y);
          this.sim.grabMove(target);
          const n = new THREE.Vector3();
          this.stage.camera.getWorldDirection(n);
          this.grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, target);
          const pos = this.grabLine.geometry.attributes.position as THREE.BufferAttribute;
          pos.setXYZ(1, target.x, target.y, target.z);
          pos.needsUpdate = true;
        }
        return;
      }
      if (this.sim && this.grabLine.visible) {
        const ray = this.stage.rayAt(ev);
        const target = this.grabPlane ? ray.intersectPlane(this.grabPlane, new THREE.Vector3()) : null;
        if (target && target.distanceTo(ray.origin) < 5000) {
          target.y = Math.max(0.3, target.y);
          this.sim.grabMove(target);
          const pos = this.grabLine.geometry.attributes.position as THREE.BufferAttribute;
          pos.setXYZ(1, target.x, target.y, target.z);
          pos.needsUpdate = true;
        }
      }
    });
    c.addEventListener('pointerup', (ev) => {
      const d = this.pointerDown;
      this.pointerDown = null;
      if (this.pressed) {
        this.pressed.press!(false);
        this.pressed = null;
        if (this.circuit) this.circuit.dirty = true;
        this.stage.orbit.enabled = true;
        return;
      }
      if (this.sim && this.grabLine.visible) {
        if (ev.button === 2) return; // (the right button up: still holding with the left)
        this.releaseGrab(ev);
        return;
      }
      if (!d || d.button !== 0 || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) return; // that was a camera drag
      if (this.mode === 'build' && this._ins?.mode) { this._ins.click(ev); return; }
      if (this.mode !== 'build') return;
      if ((this.stage.gizmo as any).dragging) return;
      if (this.placing) return this.placingClick(ev);
      if (this.wiring) return this.wiringClick(ev);
      const hit = this.stage.pick(ev, [this.stage.partsRoot, this.wires.group], false);
      if (hit?.object.userData.wireId && !this.gluing) {
        this.selected = null;
        this.selectedWire = hit.object.userData.wireId;
        this.applySelection();
        this.refreshInspector();
        return;
      }
      if (this.selectedWire) this.selectedWire = null;
      if (this.belting) {
        const from = this.belting;
        this.belting = null;
        if (hit && hit.object.userData.uid !== from) this.addBelt(from, hit.object.userData.uid);
        else this.refreshInspector();
        return;
      }
      if (this.gluing) {
        if (hit && hit.object.userData.uid !== this.gluing) this.glueTo(hit.object.userData.uid, hit.object.userData.body);
        else {
          this.gluing = null;
          this.refreshInspector();
        }
        return;
      }
      this.select(hit ? (hit.object.userData.uid as string) : null);
    });
    c.addEventListener('wheel', (ev) => {
      if (!this.sim || this.mode === 'build') return;
      const notch = Math.sign(ev.deltaY) * Math.min(3, Math.max(1, Math.abs(ev.deltaY) / 100));
      if (this.grabLine.visible) {
        // the wheel sets how hard the grab pulls (the camera doesn't zoom meanwhile; nothing moves)
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const g = this.sim.setGrip(this.sim.grip * Math.pow(1.25, -notch));
        this.hint(`Grip: ${Math.round(g * 100)} % (${Math.round(g * 60)} N)${g <= 0.05 ? ' (gentlest)' : ''}  ·  wheel up = firmer, down = gentler  ·  Q / E turn it  ·  let go to drop it`);
      } else if (ev.shiftKey) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.pushLift = Math.max(0, Math.min(40, this.pushLift - notch * 0.8));
        this.handHover(ev as unknown as PointerEvent);
      }
    }, { capture: true, passive: false });
    window.addEventListener('keyup', (ev) => this.keysDown.delete(ev.key.toLowerCase()));
    window.addEventListener('blur', () => this.keysDown.clear());
    c.addEventListener('contextmenu', (ev) => { if (this.mode !== 'build') ev.preventDefault(); });
    window.addEventListener('keyup', (ev) => {
      if (ev.key === 'Shift' && this.sim && this.mode !== 'build' && !this.grabLine.visible) {
        this.sim.handPush(null);
        if (this.lastPointer) this.handHover(this.lastPointer, false);
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.sim && !this.grabLine.visible) {
        this.sim.handPush(null);
        this.hand.hide();
      }
    });
    c.addEventListener('dblclick', () => {
      const v = this.selected ? this.views.get(this.selected) : null;
      if (v) this.stage.frame([v.root]);
    });
    window.addEventListener('keydown', (ev) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = ev.key.toLowerCase();
      if (this.mode === 'run' && !ev.ctrlKey && this.pad.claims(ev.key)) return; // (a PS2 pad is being played)
      if ((ev.ctrlKey || ev.metaKey) && k === 'f' && this.catSearch && !document.querySelector('.modal')) {
        ev.preventDefault(); // Ctrl+F: search the parts list
        this.catSearch.focus();
        this.catSearch.select();
        return;
      }
      if (this.sim && this.grabLine.visible && !ev.ctrlKey && ['w', 'a', 's', 'd', 'r', 'f', 'shift'].includes(k)) {
        // holding something: these move it (see moveHeld), and nothing else
        this.keysDown.add(k);
        ev.preventDefault();
        return;
      }
      if (this.sim && this.grabLine.visible && (k === 'q' || k === 'e') && !ev.ctrlKey) {
        this.sim.grabTurn(k === 'q' ? 15 : -15);
        return;
      }
      if (ev.key === 'Shift' && this.sim && this.mode !== 'build' && !this.grabLine.visible && this.lastPointer) {
        this.handHover(this.lastPointer, true);
        return;
      }
      if (ev.ctrlKey && k === 's') { ev.preventDefault(); this.save(); }
      else if (ev.ctrlKey && k === 'o') { ev.preventDefault(); this.open(); }
      else if (ev.ctrlKey && k === 'z') { ev.preventDefault(); this.undoStep(true); }
      else if (ev.ctrlKey && k === 'y') { ev.preventDefault(); this.undoStep(false); }
      else if (ev.ctrlKey && k === 'd') { ev.preventDefault(); this.duplicateSelected(); }
      else if (k === ' ') { ev.preventDefault(); this.mode === 'build' ? this.run() : this.pause(); }
      else if (k === 'escape') {
        if (this._ins?.mode) this._ins.setMode(this._ins.mode);
        else if (this.placing) this.cancelPlacing();
        else if (this.wireStart) { this.wireStart = null; this.rubber.visible = false; this.refreshAll(); }
        else if (this.wiring) this.toggleWiring(false);
        else if (this.mode !== 'build') this.stop();
        else { this.selectedWire = null; this.select(null); }
      }
      else if (k === 'delete' || k === 'backspace') { if (this.selectedWire && this.mode === 'build') this.deleteWire(this.selectedWire); else this.deleteSelected(); }
      else if (k === 'c' && !ev.ctrlKey) this.toggleWiring();
      else if (k === 'm' && !ev.ctrlKey) this.ins.setMode('ruler');
      else if (k === 'v' && !ev.ctrlKey) this.ins.setMode('meter');
      else if (k === 'r') {
        if (this.placing) { this.placing.spin += Math.PI / 2; this.refreshAll(); }
        else if (this.selected && this.mode === 'build') {
          const v = this.views.get(this.selected)!;
          this.snapshot();
          v.root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
          this.gizmoMoved();
        }
      } else if (k === 'g' && !ev.ctrlKey) {
        this.setGrid({ snap: !this.grid.snap });
        this.log(`snap to grid: ${this.grid.snap ? 'on' : 'off'}`);
      } else if (k === 'w') this.stage.gizmo.setMode('translate');
      else if (k === 'e') this.stage.gizmo.setMode('rotate');
      else if (k === 'f') {
        const v = this.selected ? this.views.get(this.selected) : null;
        this.stage.frame(v ? [v.root] : [this.stage.partsRoot]);
      }
    });
    // (moving: snapped by snapMoved, to the bench's grid or the part's own; turning: 5 degree steps)
    this.stage.gizmo.setTranslationSnap(null);
    this.stage.gizmo.setRotationSnap(this.grid.snap ? THREE.MathUtils.degToRad(5) : null);
    this.stage.gizmo.addEventListener('dragging-changed', (e: any) => { if (!e.value) this.gridDots.visible = false; });
  }

  // ------------------------------------------------------------------------------------ files
  async save() {
    this.project.libraries = librariesUsed(this.project); // whoever opens it learns what to install
    const text = JSON.stringify(this.project, null, 1);
    try {
      const path = await saveText(`${this.project.name || 'bench'}.bench`, text);
      if (!path) return;
      this.filePath = path;
      this.dirty = false;
      this.refreshAll();
      this.log(`saved ${path}`);
    } catch (e) {
      this.log(`couldn't save: ${(e as Error).message}`, 'bad');
    }
  }
  async open() {
    try {
      const f = await openText();
      if (!f) return;
      const raw = JSON.parse(f.text);
      await this.ensureLibraries(raw);
      const { project, problems } = validate(raw);
      if (!project) return this.log(`couldn't open ${f.name}: ${problems.join('; ')}`, 'bad');
      this.load(project, f.name);
      for (const p of problems) this.log(p, 'warn');
    } catch (e) {
      this.log(`couldn't open: ${(e as Error).message}`, 'bad');
    }
  }
  /** A project with parts from libraries that aren't installed: offer to get them from the library list. */
  async ensureLibraries(raw: any) {
    const missing = missingTypes(raw);
    if (!missing.length) return;
    const ids = [...new Set(missing.filter((t) => t.includes('/')).map((t) => t.split('/')[0]))].filter((id) => !installed.has(id));
    const named = (raw.libraries ?? []).filter((l: any) => ids.includes(l?.id)).map((l: any) => `${l.name ?? l.id} ${l.version ?? ''}`.trim());
    if (!ids.length) return;
    const list = (named.length ? named : ids).join('\n');
    if (!confirm(`This project uses parts from libraries you don't have:\n\n${list}\n\nGet them from the library list now? (Without them, those parts are left out.)`)) return;
    try {
      const list = await fetchRegistry();
      for (const id of ids) {
        const e = list.find((x) => x.id === id);
        if (!e) {
          this.log(`library ${id} isn't on the library list: ask whoever made the project for its .benchlib file`, 'warn');
          continue;
        }
        const r = await installFromRegistry(e);
        this.log(r.message, r.ok ? 'info' : 'warn');
      }
    } catch (e) {
      this.log(`couldn't get the library list: ${(e as Error).message}`, 'warn');
    }
  }

  load(project: Project, from: string | null) {
    this.stop();
    this.dock.flush(); // (typing in the program editor belongs to the old project)
    this.snapshot();
    this.project = project;
    this.filePath = from;
    this.selected = null;
    this.dock.projectChanged();
    this.changed();
    this.showRoom();
    this.showGravity();
    this.dirty = false;
    this.stage.frame([this.stage.partsRoot]);
    this.log(`opened ${project.name} (${project.parts.length} parts)`);
  }
  newBench() {
    this.stop();
    this.dock.flush();
    this.snapshot();
    this.project = newProject();
    this.filePath = null;
    this.selected = null;
    this.dock.projectChanged();
    this.changed();
    this.showRoom();
    this.showGravity();
    this.log('new, empty bench (Ctrl+Z brings the old one back)');
  }

  // ------------------------------------------------------------------------------------ UI
  private nameOf(uid: string) {
    return this.project.parts.find((p) => p.uid === uid)?.name ?? '?';
  }
  private instOf(uid: string | null) {
    return uid ? this.project.parts.find((p) => p.uid === uid) ?? null : null;
  }
  private hint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.style.display = text ? '' : 'none';
  }

  private toolbarButtons: Record<string, HTMLButtonElement> = {};
  private showRoom = () => {};
  private showGravity = () => {};
  /** keys held down now (lower case): WASD / R F move the camera, carrying what the grab holds */
  private keysDown = new Set<string>();
  /** the glue check while running (glue.ts) */
  glueCheck: GlueCheck | null = null;
  private buildToolbar() {
    const b = (key: string, label: string, title: string, fn: () => void, cls = '') => {
      const x = el('button', { textContent: label, title, className: cls, onclick: fn });
      this.toolbarButtons[key] = x;
      return x;
    };
    const gravity = el('select', { title: 'Gravity: real Earth gravity, or less (things fall slower and float more)' }) as HTMLSelectElement;
    const GRAVS: [number, string][] = [[1, 'Gravity: Earth'], [0.38, 'Gravity: Mars'], [0.165, 'Gravity: Moon'], [0.05, 'Gravity: floaty']];
    for (const [g, label] of GRAVS) gravity.append(el('option', { value: String(g), textContent: label }));
    gravity.onchange = () => {
      const g = Number(gravity.value);
      this.project.gravity = g === 1 ? undefined : g;
      this.dirty = true;
      this.sim?.setGravity(g);
      this.log(`${gravity.selectedOptions[0].textContent}${g === 1 ? ' (real)' : ` (${Math.round(g * 100)} % of Earth's)`}`);
    };
    gravity.style.cssText = 'background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px';
    this.showGravity = () => { gravity.value = String(this.project.gravity ?? 1); if (!gravity.value) gravity.value = '1'; };
    const glue = el('select', { title: 'How strong the glue is: glued parts come apart when they are pulled, bent or twisted harder than it holds (a crash, a strong servo, the hand)' }) as HTMLSelectElement;
    for (const [id, g] of Object.entries(GLUES)) glue.append(el('option', { value: id, textContent: `Glue: ${g.name}`, title: g.note }));
    glue.onchange = () => {
      this.project.glue = glue.value === DEFAULT_GLUE ? undefined : glue.value;
      this.dirty = true;
      this.glueCheck?.setGlue(glue.value);
      const g = GLUES[glue.value];
      this.log(`Glue: ${g.name}${isFinite(g.mpa) ? ` (${g.mpa} MPa: ${g.note})` : ` (${g.note})`}`);
    };
    glue.style.cssText = gravity.style.cssText;
    const showGlue = () => { glue.value = this.project.glue ?? DEFAULT_GLUE; };
    const prevShow = this.showGravity;
    this.showGravity = () => { prevShow(); showGlue(); };
    const speed = el('select', { title: 'Simulation speed' }) as HTMLSelectElement;
    for (const s of [0.1, 0.25, 0.5, 1, 2]) speed.append(el('option', { value: String(s), textContent: `${s}x`, selected: s === 1 }));
    speed.onchange = () => (this.speed = Number(speed.value));
    speed.style.cssText = 'background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px';
    const examples = el('select', { title: 'Open an example project' }) as HTMLSelectElement;
    examples.style.cssText = speed.style.cssText;
    examples.append(el('option', { value: '', textContent: 'Examples...' }));
    // library parts' sounds (buzzers...): on or off, remembered
    const roomBtn = el('button', { title: 'How bright the room is: light sensors see it (lit LEDs and screens still glow in the dark)' }) as HTMLButtonElement;
    const ROOMS: [number, string][] = [[1, 'Room: lit'], [0.35, 'Room: dim'], [0, 'Room: dark']];
    this.showRoom = () => {
      const r = this.project.room ?? 1;
      this.stage.setRoomLight(r);
      roomBtn.textContent = (ROOMS.find(([v]) => Math.abs(v - r) < 0.01) ?? [r, `Room: ${Math.round(r * 100)}%`])[1];
    };
    roomBtn.onclick = () => {
      const i = ROOMS.findIndex(([v]) => Math.abs(v - (this.project.room ?? 1)) < 0.01);
      const next = ROOMS[(i + 1) % ROOMS.length][0];
      this.project.room = next === 1 ? undefined : next;
      this.dirty = true;
      this.showRoom();
      this.log(`room light: ${ROOMS[(i + 1) % ROOMS.length][1].slice(6)}`);
    };
    queueMicrotask(() => this.showRoom());
    const soundBtn = el('button', { title: 'Sounds from parts (buzzers, speakers): on / off' }) as HTMLButtonElement;
    const showSound = () => {
      soundBtn.textContent = benchAudio.muted ? 'Sound: off' : 'Sound: on';
      soundBtn.classList.toggle('active', !benchAudio.muted);
    };
    soundBtn.onclick = () => { benchAudio.unlock(); benchAudio.setMuted(!benchAudio.muted); };
    benchAudio.onChange = showSound;
    showSound();
    EXAMPLES.forEach((x, i) => examples.append(el('option', { value: String(i), textContent: x.name, title: x.description })));
    examples.onchange = async () => {
      const x = EXAMPLES[Number(examples.value)];
      examples.value = '';
      if (!x) return;
      const raw = JSON.parse(x.text);
      await this.ensureLibraries(raw);
      const { project, problems } = validate(raw);
      if (project) {
        this.load(project, null);
        this.toast(x.description);
      }
      for (const p of problems) this.log(p, 'warn');
    };
    // the grid: a button that opens a small panel (snap on/off and its step, parts' own grids)
    const gridWrap = el('div', { className: 'tb-menu' });
    const gridBtn = el('button', { title: 'Snap to a grid while placing and moving parts (G turns it on or off)' }) as HTMLButtonElement;
    const snapBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const fitBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const sizeSel = el('select', { className: 'tb-select' }) as HTMLSelectElement;
    for (const [v, label] of [[0.1, '1 mm'], [0.25, '2.5 mm'], [0.254, '0.1 inch (headers)'], [0.5, '5 mm'], [1, '1 cm'], [2, '2 cm'], [5, '5 cm']] as [number, string][])
      sizeSel.append(el('option', { value: String(v), textContent: label }));
    const pivotSel = el('select', { className: 'tb-select', title: 'Where the move and turn arrows sit on the selected part' },
      el('option', { value: 'centre', textContent: 'its centre' }),
      el('option', { value: 'mass', textContent: 'its centre of mass' }),
      el('option', { value: 'base', textContent: 'its base (where it is glued)' })) as HTMLSelectElement;
    pivotSel.onchange = () => this.setPivotMode(pivotSel.value as App['pivotMode']);
    const pop = el('div', { className: 'tb-pop', hidden: true },
      el('label', { className: 'tb-row' }, snapBox, el('span', { textContent: 'Snap to grid' }), sizeSel),
      el('label', { className: 'tb-row' }, fitBox, el('span', { textContent: 'Parts get their own grid' })),
      el('label', { className: 'tb-row' }, el('span', { textContent: 'Move and turn about' }), pivotSel),
      el('div', { className: 'tb-note', textContent: "A part's own grid fits it: its sides are divided evenly, so odd sizes still have their edges and middle on the grid. Blue dots show it while you place or move something on the part. G turns snapping on and off." }));
    this.showGridState = () => {
      gridBtn.textContent = this.grid.snap ? `Grid: ${sizeSel.querySelector<HTMLOptionElement>(`option[value="${this.grid.size}"]`)?.textContent ?? `${this.grid.size} cm`}` : 'Grid: off';
      gridBtn.classList.toggle('active', this.grid.snap);
      snapBox.checked = this.grid.snap;
      fitBox.checked = this.grid.fit;
      fitBox.disabled = !this.grid.snap;
      sizeSel.value = String(this.grid.size);
      pivotSel.value = this.pivotMode;
      sizeSel.disabled = !this.grid.snap;
    };
    snapBox.onchange = () => this.setGrid({ snap: snapBox.checked });
    fitBox.onchange = () => this.setGrid({ fit: fitBox.checked });
    sizeSel.onchange = () => this.setGrid({ size: Number(sizeSel.value) });
    gridBtn.onclick = (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      // (it floats over everything, under its button: the toolbar scrolls when the window is narrow)
      const r = gridBtn.getBoundingClientRect();
      pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
      pop.style.top = `${r.bottom + 6}px`;
    };
    pop.onclick = (e) => e.stopPropagation();
    document.addEventListener('click', () => (pop.hidden = true));
    gridWrap.append(gridBtn, pop);
    queueMicrotask(() => this.showGridState?.());
    // how big the buttons and text are: follows Windows' scaling and the screen, or chosen
    const uiSel = el('select', { className: 'tb-select', title: 'How big the buttons and text are. Auto follows your display settings and screen size.' }) as HTMLSelectElement;
    const showUi = () => {
      uiSel.replaceChildren(el('option', { value: 'auto', textContent: `UI: auto (${Math.round(autoUiScale() * 100)} %)` }),
        ...[0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2].map((f) => el('option', { value: String(f), textContent: `UI: ${Math.round(f * 100)} %` })));
      uiSel.value = uiScaleSetting();
    };
    uiSel.onchange = async () => { await setUiScale(uiSel.value); showUi(); };
    showUi();
    applyUiScale().then(showUi);
    watchUiScale(showUi);
    this.dom.toolbar.append(
      el('div', { className: 'brand', innerHTML: 'Bench <span>Workshop</span>' }),
      b('new', 'New', 'New, empty bench', () => this.newBench()),
      b('open', 'Open', 'Open a project (Ctrl+O)', () => this.open()),
      b('save', 'Save', 'Save the project (Ctrl+S)', () => this.save()),
      examples,
      b('libraries', 'Libraries', 'Add-on parts (displays, sensors, boards...): browse, install, make your own', () => this.libraries.open()),
      el('div', { className: 'sep' }),
      b('undo', 'Undo', 'Ctrl+Z', () => this.undoStep(true)),
      b('redo', 'Redo', 'Ctrl+Y', () => this.undoStep(false)),
      el('div', { className: 'sep' }),
      b('wire', 'Wire', 'Wire tool (C): click a pin, then another pin', () => this.toggleWiring()),
      b('program', 'Program', 'Edit the selected board\'s program, and see its serial monitor', () => this.openProgram()),
      b('ruler', 'Ruler', 'Measure the distance between two points (M)', () => this.ins.setMode('ruler')),
      b('balance', 'Balance', 'Weight and balance: each build\'s weight, its centre of mass, what it stands on and how far it can lean before it tips over (live while running)', () => { const on = this.balance.toggle(); this.toolbarButtons.balance?.classList.toggle('active', on); }),
      b('meter', 'Meter', 'A multimeter: click a pin for its volts, a second pin for the volts between them; live while running (V)', () => this.ins.setMode('meter')),
      b('api', 'API', 'Control API: let your own programs (Python, scripts) drive the bench at http://127.0.0.1:7420/ (this PC only)', () => void this.toggleApi()),
      b('sheets', 'Parts list', 'What to buy (with rough prices) and a wiring sheet, to build it for real', () => openSheets({ project: () => this.project, views: () => this.views, typeOf: (id) => PART_BY_ID.get(id), stage: this.stage, log: (m, l) => this.log(m, l) })),
      b('check', 'Check', 'Check the wiring for mistakes (shorts, reversed or too-high supplies, missing power...) without running', () => this.checker.open()),
      el('div', { className: 'sep' }),
      b('run', 'Run', 'Start the physics (Space)', () => this.run(), 'primary'),
      b('pause', 'Pause', 'Pause / carry on (Space)', () => this.pause()),
      b('stop', 'Stop', 'Back to building; everything returns to where you built it (Esc)', () => this.stop(), 'danger'),
      speed,
      gravity,
      glue,
      soundBtn,
      roomBtn,
      b('pingraph', 'Pin graph', 'Graph pins\' voltages over time while running (a logic analyzer)', () => this.pinGraph.toggle()),
      b('loads', 'Loads', 'While running: how hard each glue joint, servo, motor, driver, battery and propeller works, of what it can take (find what is too weak before buying it)', () => this.loads.toggle()),
      el('div', { className: 'sep' }),
      gridWrap,
      el('div', { className: 'spacer' }),
      uiSel,
      b('learn', 'Learn', 'Lessons: wiring and programming, step by step, with what changes on a real bench', () => this.tutorial.open(), 'primary'),
      b('help', 'Help', 'How to use the bench', () => this.showHelp()),
    );
  }
  /** the parts list's search box (kept across rebuilds, so installing a library keeps what you typed) */
  private catSearch: HTMLInputElement | null = null;
  /** Show only the parts whose name, description, category or kind has every word typed. */
  private filterCatalog() {
    const words = (this.catSearch?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const g of this.dom.catalog.querySelectorAll<HTMLElement>('.cat-group')) {
      let any = false;
      for (const item of g.querySelectorAll<HTMLElement>('.cat-item')) {
        const hay = item.dataset.search ?? '';
        const ok = words.every((w) => hay.includes(w));
        item.hidden = !ok;
        if (ok) { any = true; if (item.dataset.type) shown++; }
      }
      g.hidden = !any;
    }
    const none = this.dom.catalog.querySelector<HTMLElement>('.cat-none');
    if (none) {
      none.hidden = !words.length || shown > 0;
      none.textContent = `No parts match "${this.catSearch!.value.trim()}". Libraries has more parts to add.`;
    }
  }
  private buildCatalog() {
    if (!this.catSearch) {
      const s = el('input', { type: 'search', className: 'cat-search', placeholder: 'Search parts  (Ctrl+F)', title: 'Type part of a name or what it does: servo, oled, distance, i2c... Esc clears' }) as HTMLInputElement;
      s.oninput = () => this.filterCatalog();
      s.onkeydown = (e) => {
        if (e.key === 'Escape') { s.value = ''; this.filterCatalog(); s.blur(); }
        if (e.key === 'Enter') { // Enter picks the first part showing, ready to place
          const first = [...this.dom.catalog.querySelectorAll<HTMLElement>('.cat-item[data-type]')].find((i) => !i.hidden);
          if (first) { first.click(); s.blur(); }
        }
      };
      this.catSearch = s;
    }
    this.dom.catalog.replaceChildren(this.catSearch, el('div', { className: 'cat-none', hidden: true }));
    const extra = [...new Set(PARTS.map((p) => p.category))].filter((c) => !CATEGORIES.includes(c)).sort();
    for (const cat of [...CATEGORIES.slice(0, -1), ...extra, CATEGORIES[CATEGORIES.length - 1]]) {
      const items = PARTS.filter((p) => p.category === cat);
      const mine = cat === 'My boards'; // always shown: it's where you add your own
      if (!items.length && !mine) continue;
      const g = el('div', { className: 'cat-group' }, el('h3', { textContent: cat }));
      if (mine) {
        const action = (label: string, title: string, run: () => void) => {
          const a = el('div', { className: 'cat-item cat-action', title, onclick: run }, el('span', { className: 'cat-swatch cat-plus', textContent: '+' }), el('span', { className: 'cat-name', textContent: label }));
          a.dataset.search = `${label} ${title} ${cat}`.toLowerCase();
          return a;
        };
        g.append(
          action('Import 3D model (.stl)...', 'Bring in your own design (.stl from CAD or a slicer): see how it looks and works on the bench', () => importModel(this.partHost)),
          action('Import KiCad board...', 'Make a part from your KiCad board (.kicad_pcb), with its 3D look if you export a .glb', () => importKicad(this.partHost)),
          action('Make a part...', 'Make a board here: size, colour, header rows, optionally a microcontroller that runs sketches', () => makePart(this.partHost)),
        );
      }
      for (const p of items) {
        const item = el('div', { className: 'cat-item', title: p.description, onclick: () => (this.placing?.type === p ? this.cancelPlacing() : this.startPlacing(p)) },
          el('span', { className: 'cat-swatch', style: `background:${p.swatch}` }),
          el('span', { className: 'cat-name', textContent: p.name }));
        item.dataset.type = p.id;
        item.dataset.search = `${p.name} ${p.description ?? ''} ${p.category} ${p.id.replace(/[/_-]/g, ' ')}`.toLowerCase();
        g.append(item);
      }
      this.dom.catalog.append(g);
    }
    this.filterCatalog();
  }

  refreshAll() {
    const m = this.mode;
    const pill = this.statusEls.mode;
    pill.textContent = m === 'build' ? 'BUILD' : m === 'run' ? 'RUNNING' : 'PAUSED';
    pill.className = `mode-pill mode-${m === 'paused' ? 'pause' : m}`;
    this.toolbarButtons.run.disabled = m === 'run';
    this.toolbarButtons.pause.disabled = m === 'build';
    this.toolbarButtons.stop.disabled = m === 'build';
    this.toolbarButtons.undo.disabled = m !== 'build' || !this.undo.length;
    this.toolbarButtons.redo.disabled = m !== 'build' || !this.redo.length;
    this.toolbarButtons.pause.textContent = m === 'paused' ? 'Carry on' : 'Pause';
    benchAudio.setPaused(m !== 'run');
    this.toolbarButtons.wire.classList.toggle('active', this.wiring);
    this.toolbarButtons.ruler?.classList.toggle('active', this._ins?.mode === 'ruler');
    this.toolbarButtons.api?.classList.toggle('active', this.api.on);
    this.toolbarButtons.meter?.classList.toggle('active', this._ins?.mode === 'meter');
    this.toolbarButtons.program.disabled = !this.programmableSelected();
    for (const item of this.dom.catalog.querySelectorAll<HTMLElement>('.cat-item')) item.classList.toggle('placing', !!item.dataset.type && this.placing?.type.id === item.dataset.type);
    this.statusEls.parts.textContent = `${this.project.parts.length} parts`;
    document.title = `Bench Workshop - ${this.project.name}${this.dirty ? ' *' : ''}`;
    if (this.placing) this.hint(`Click on the bench or a part to put ${this.placing.type.name} there  ·  R turn  ·  Shift-click keeps placing  ·  Esc stop`);
    else if (this.gluing) this.hint(`Click the part to glue ${this.nameOf(this.gluing)} to  ·  click empty space to cancel`);
    else if (this.belting) this.hint(`Click the pulley the belt from ${this.nameOf(this.belting)} goes to  ·  click empty space to cancel`);
    else if (this.wiring) this.hint(this.wireStart ? `From ${this.pinLabel(this.wireStart)}: click the pin to wire it to  ·  Esc cancel` : 'Wire tool: click a pin, then another pin  ·  C or Esc to leave');
    else if (m !== 'build') this.hint('Drag a part to push it  ·  click a button to press it  ·  the panel on the right shows what each part is doing  ·  Esc back to building');
    else if (!this.project.parts.length) this.hint('Pick a part on the left, then click on the bench to place it  ·  or open one of the Examples');
    else this.hint('');
    this.refreshInspector();
  }

  private refreshReadouts() {
    for (const f of this.readouts) f();
    if (this.sim) this.statusEls.time.textContent = `t = ${this.sim.time.toFixed(2)} s  ·  ${Math.round(this.fps)} fps`;
    else this.statusEls.time.textContent = `${Math.round(this.fps)} fps`;
  }

  private programmableSelected() {
    const inst = this.instOf(this.selected);
    return !!inst && !!PART_BY_ID.get(inst.type)?.programmable;
  }
  openProgram(uid = this.selected) {
    if (!uid || !PART_BY_ID.get(this.instOf(uid)?.type ?? '')?.programmable) return this.log('select a board that can be programmed first', 'warn');
    this.dock.open(uid);
  }

  private wireInspector(box: HTMLElement, id: string) {
    const w = this.project.wires.find((x) => x.id === id);
    if (!w) return;
    box.append(el('div', { className: 'insp-title', textContent: 'Wire' }),
      el('div', { className: 'insp-sub', textContent: `${this.pinLabel(w.a)}  →  ${this.pinLabel(w.b)}` }));
    const color = el('input', { type: 'color', value: w.color, onchange: (e: Event) => { this.snapshot(); w.color = (e.target as HTMLInputElement).value; this.changed(false); } });
    box.append(el('div', { className: 'field' }, el('label', { textContent: 'Colour' }), color));
    const pa = pinWorld(this.views, w.a), pb = pinWorld(this.views, w.b);
    const minLen = pa && pb ? Math.ceil(pa.distanceTo(pb) * 2) / 2 : 0.5;
    const len = el('input', {
      type: 'number', min: String(minLen), step: '0.5', value: String(w.length ?? minLen), disabled: this.mode !== 'build',
      onchange: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (!(n > 0)) return;
        this.snapshot();
        w.length = Math.max(minLen, n);
        if (n < minLen) this.log(`a wire can't be shorter than the distance between its pins (${minLen} cm): move them closer first`, 'warn');
        this.changed(false);
      },
    });
    box.append(el('div', { className: 'field' }, el('label', { textContent: 'Length (cm)' }), len));
    box.append(el('div', { className: 'row' }, el('button', { textContent: 'Delete wire', className: 'danger', disabled: this.mode !== 'build', onclick: () => this.deleteWire(id) })));
  }

  refreshInspector() {
    const box = this.dom.inspector;
    box.replaceChildren();
    this.readouts = [];
    if (this.mode !== 'build' && this.sim) return this.runInspector(box);
    if (this.selectedWire) return this.wireInspector(box, this.selectedWire);
    const inst = this.instOf(this.selected);
    if (!inst) {
      box.append(
        el('div', { className: 'insp-title', textContent: this.project.name }),
        el('div', { className: 'insp-sub', textContent: 'Nothing selected. Click a part to edit it.' }),
      );
      const nameField = el('input', { type: 'text', value: this.project.name, onchange: (e: Event) => { this.snapshot(); this.project.name = (e.target as HTMLInputElement).value || 'Untitled'; this.changed(false); } });
      box.append(el('div', { className: 'field' }, el('label', { textContent: 'Project name' }), nameField));
      // the bench's Wi-Fi (what WiFi.begin(name, password) must match)
      const wifi = this.project.wifi ?? DEFAULT_WIFI;
      const setWifi = (k: 'ssid' | 'pass') => (e: Event) => {
        this.snapshot();
        this.project.wifi = { ...wifi, [k]: (e.target as HTMLInputElement).value };
        this.changed(false);
      };
      box.append(
        el('div', { className: 'field' }, el('label', { textContent: 'Bench Wi-Fi name' }), el('input', { type: 'text', value: wifi.ssid, maxLength: 32, onchange: setWifi('ssid') })),
        el('div', { className: 'field' }, el('label', { textContent: 'Bench Wi-Fi password' }), el('input', { type: 'text', value: wifi.pass, maxLength: 63, onchange: setWifi('pass') })),
        el('div', { className: 'note', textContent: 'Boards with Wi-Fi (ESP32) join this network: WiFi.begin("name", "password") must match. Their web pages open from the run panel.' }),
      );
      box.append(el('div', { className: 'note', innerHTML:
        'Parts glue to whatever you place them on. Moving a part moves everything glued to it.<br><br>' +
        '<span class="kbd">W</span> move &nbsp;<span class="kbd">E</span> rotate &nbsp;<span class="kbd">R</span> turn 90° &nbsp;<span class="kbd">F</span> zoom to it<br>' +
        '<span class="kbd">Del</span> remove &nbsp;<span class="kbd">Ctrl+D</span> duplicate &nbsp;<span class="kbd">Space</span> run' }));
      return;
    }
    const type = PART_BY_ID.get(inst.type)!;
    box.append(el('div', { className: 'insp-title', textContent: inst.name }), el('div', { className: 'insp-sub', textContent: type.description }));
    const field = (label: string, input: HTMLElement) => box.append(el('div', { className: 'field' }, el('label', { textContent: label }), input));
    field('Name', el('input', { type: 'text', value: inst.name, onchange: (e: Event) => { this.snapshot(); inst.name = (e.target as HTMLInputElement).value || type.name; this.changed(); } }));
    for (const p of type.params) {
      const val = inst.params[p.key] ?? type.defaults[p.key];
      const set = (v: any) => { this.snapshot(); inst.params[p.key] = v; this.changed(); };
      let input: HTMLElement;
      if (p.kind === 'select') {
        const s = el('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) });
        for (const o of p.options!) s.append(el('option', { value: o.value, textContent: o.label, selected: o.value === val }));
        input = s;
      } else if (p.kind === 'color') input = el('input', { type: 'color', value: val, onchange: (e: Event) => set((e.target as HTMLInputElement).value) });
      else if (p.kind === 'bool') input = el('input', { type: 'checkbox', checked: !!val, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
      else input = el('input', { type: 'number', value: String(val), min: String(p.min ?? ''), max: String(p.max ?? ''), step: String(p.step ?? 'any'),
        onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v)) set(Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v))); } });
      field(p.label + (p.unit ? ` (${p.unit})` : ''), input);
    }
    const mass = type.build({ ...type.defaults, ...inst.params }).bodies.reduce((s, b) => s + b.mass, 0);
    box.append(el('div', { className: 'note', textContent: `Weight: ${mass < 1000 ? mass.toFixed(1) + ' g' : (mass / 1000).toFixed(2) + ' kg'}` }));

    const glue = el('div', { className: 'box' });
    if (inst.parent) glue.append(el('div', { innerHTML: `Glued to <b>${this.nameOf(inst.parent.uid)}</b> (${inst.parent.body})` }));
    else glue.append(el('div', { textContent: 'Loose on the bench (not glued to anything).' }));
    const pin = el('input', { type: 'checkbox', checked: !!inst.pinned, onchange: (e: Event) => { this.snapshot(); inst.pinned = (e.target as HTMLInputElement).checked; this.changed(false); } });
    glue.append(el('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:6px' }, pin, 'Pinned to the bench (never moves)'));
    glue.append(el('div', { className: 'row' },
      el('button', { textContent: this.gluing ? 'Click a part...' : 'Glue to...', className: this.gluing ? 'active' : '', onclick: () => { this.gluing = this.gluing ? null : inst.uid; this.refreshAll(); } }),
      el('button', { textContent: 'Unglue', disabled: !inst.parent, onclick: () => this.unglueSelected() })));
    box.append(glue);
    if (this.beltWheel(inst.uid)) {
      const belts = (this.project.belts ?? []).filter((b) => b.a === inst.uid || b.b === inst.uid);
      const bx = el('div', { className: 'box' }, el('div', { textContent: belts.length ? 'Belts:' : 'No belt yet.' }));
      for (const b of belts) {
        const other = b.a === inst.uid ? b.b : b.a;
        bx.append(el('div', { className: 'row' }, el('span', { textContent: `to ${this.nameOf(other)}`, style: 'flex:1' }), el('button', { textContent: 'Remove', onclick: () => this.removeBelt(b.id) })));
      }
      bx.append(el('div', { className: 'row' }, el('button', { textContent: this.belting ? 'Click a pulley...' : 'Belt to...', className: this.belting ? 'active' : '', title: 'Put a belt from this pulley round another one: they turn together', onclick: () => { this.belting = this.belting ? null : inst.uid; this.gluing = null; this.refreshAll(); } })));
      box.append(bx);
    }
    const pos = el('div', { className: 'note' });
    this.readouts.push(() => {
      const v = this.views.get(inst.uid);
      if (!v) return;
      const p = new THREE.Vector3().setFromMatrixPosition(v.root.matrixWorld);
      pos.textContent = `Position: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} cm`;
    });
    box.append(pos);
    if (type.programmable) {
      const prog = this.project.programs[inst.uid];
      box.append(el('div', { className: 'box' },
        el('div', { innerHTML: `<b>Program</b>: ${prog ? (prog.firmware ? `firmware ${prog.firmwareName ?? ''}` : `${prog.lang === 'arduino' ? 'Arduino C++' : 'JavaScript'}, ${prog.source.split('\n').length} lines`) : 'none yet'}` }),
        el('div', { className: 'row' }, el('button', { textContent: 'Edit program...', className: 'primary', onclick: () => this.openProgram(inst.uid) }))));
    }
    const mine = this.project.wires.filter((w) => w.a.uid === inst.uid || w.b.uid === inst.uid);
    if (type.build({ ...type.defaults, ...inst.params }).pins?.length) {
      const wl = el('div', { className: 'box' }, el('div', { innerHTML: `<b>Wires</b> (${mine.length})${mine.length ? '' : ': none. Press Wire (C) and click pins to connect.'}` }));
      for (const w of mine) {
        const [me, other] = w.a.uid === inst.uid ? [w.a, w.b] : [w.b, w.a];
        wl.append(el('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px' },
          el('span', { className: 'cat-swatch', style: `background:${w.color}` }),
          el('span', { style: 'flex:1', textContent: `${me.pin} → ${this.nameOf(other.uid)} ${other.pin}` }),
          el('button', { textContent: '×', title: 'Remove this wire', onclick: () => this.deleteWire(w.id) })));
      }
      box.append(wl);
    }
    box.append(el('div', { className: 'row' },
      el('button', { textContent: 'Duplicate', onclick: () => this.duplicateSelected() }),
      el('button', { textContent: 'Delete', className: 'danger', onclick: () => this.deleteSelected() })));
    this.refreshReadouts();
  }

  private runInspector(box: HTMLElement) {
    const sim = this.sim!;
    box.append(el('div', { className: 'insp-title', textContent: 'Running' }),
      el('div', { className: 'insp-sub', textContent: 'What every part is doing. Servos and motors without wires can be driven by hand here.' }));
    for (const d of this.circuit?.devices ?? []) {
      if (!d.status && !d.controls) continue;
      const card = el('div', { className: 'box' });
      const head = el('div', {}, el('b', { textContent: d.view.inst.name }));
      card.append(head);
      if (PART_BY_ID.get(d.view.inst.type)?.programmable)
        head.append(' ', el('button', { textContent: 'Serial / program', onclick: () => this.openProgram(d.view.inst.uid) }));
      // a board on Wi-Fi with a web server: its page, in the app's browser (or yours)
      const uid = d.view.inst.uid;
      const web = el('button', { className: 'primary', textContent: 'Open its web page', style: 'display:none', onclick: () => {
        const i = this.net?.info(uid);
        if (i?.server) this.webView.open(d.view.inst.name, i.ip, i.server.url);
      } }) as HTMLButtonElement;
      head.append(' ', web);
      this.readouts.push(() => (web.style.display = this.net?.info(uid)?.server ? '' : 'none'));
      const lines = el('div', { className: 'status-line' });
      card.append(lines);
      this.readouts.push(() => (lines.textContent = (d.status?.() ?? []).join('  ·  ')));
      let keys: HTMLElement | null = null; // (buttons in a row share one block: a keypad's keys)
      for (const ctl of d.controls?.() ?? []) {
        if (ctl.kind === 'button') {
          if (!keys) card.append((keys = el('div', { className: 'ctl-keys' })));
          const b = el('button', { textContent: ctl.label, className: 'ctl-key' }) as HTMLButtonElement;
          if (ctl.cols) b.style.flexBasis = `calc(${100 / ctl.cols}% - 4px)`;
          let down = false;
          const set = (on: boolean) => {
            if (on === down) return;
            down = on;
            b.classList.toggle('down', on);
            ctl.press(on);
          };
          b.onpointerdown = (e) => { b.setPointerCapture(e.pointerId); set(true); };
          b.onpointerup = () => set(false);
          b.onpointercancel = () => set(false);
          keys.append(b);
          continue;
        }
        keys = null;
        if (ctl.kind === 'switch') {
          card.append(el('div', { className: 'field' }, el('label', { textContent: ctl.label }),
            el('input', { type: 'checkbox', checked: ctl.get(), onchange: (e: Event) => ctl.set((e.target as HTMLInputElement).checked) })));
        } else if (ctl.kind === 'text') {
          const box = el('input', { type: 'text', placeholder: ctl.label }) as HTMLInputElement;
          const send = () => { ctl.send(box.value); box.value = ''; };
          box.onkeydown = (e) => { if (e.key === 'Enter') send(); e.stopPropagation(); };
          card.append(el('div', { className: 'row' }, box, el('button', { textContent: 'Send', onclick: send })));
        } else {
          card.append(el('div', { className: 'field' }, el('label', { textContent: ctl.label }),
            el('input', { type: 'range', min: String(ctl.min), max: String(ctl.max), step: String(ctl.step), value: String(ctl.get()), oninput: (e: Event) => ctl.set(Number((e.target as HTMLInputElement).value)) })));
        }
      }
      box.append(card);
    }
    for (const a of sim.actuators) {
      if (a.electrical || (this.circuit && ['GND', 'V+', 'SIG', 'M+', 'M-'].some((p) => this.circuit!.wired(a.view.inst.uid, p)))) continue; // wired: its device drives it
      const servo = a.spec.kind === 'servo';
      const card = el('div', { className: 'box' });
      card.append(el('div', { innerHTML: `<b>${a.view.inst.name}</b>` }));
      const val = el('span');
      const slider = el('input', { type: 'range', min: servo ? '-90' : '-100', max: servo ? '90' : '100', step: '1',
        value: String(servo ? Math.round((a.target * 180) / Math.PI) : Math.round(a.target * 100)),
        oninput: (e: Event) => sim.command(a.id, Number((e.target as HTMLInputElement).value)) });
      card.append(el('div', { className: 'field' }, el('label', { textContent: servo ? 'Angle (deg)' : 'Power (%)' }), slider));
      card.append(val);
      this.readouts.push(() => {
        const deg = Math.round((a.angle * 180) / Math.PI);
        const rpm = Math.round((a.speed * 60) / (2 * Math.PI));
        val.className = a.stallReported ? 'warn' : 'note';
        val.textContent = servo
          ? `at ${deg} deg (asked ${Math.round((a.target * 180) / Math.PI)})${a.stallReported ? ' - stalled' : ''}`
          : `${rpm} rpm`;
      });
      box.append(card);
    }
    for (const w of sim.warnings) box.append(el('div', { className: 'note warn', textContent: w }));
    this.refreshReadouts();
  }

  private showHelp() {
    this.toast('Left: parts. Click one, then click where it goes (on the bench or on another part: it gets glued there). ' +
      'Wire (C): click a pin, then another. Program: write the selected board\'s code. ' +
      'Finding a part: type in the search box at the top of the parts list (Ctrl+F; Enter picks the first one). The Libraries window has its own search. ' +
      'Mechanics: gears mesh when their teeth meet (by tooth count); pulleys turn together through a belt (select one, Belt to...); an Axle (free) holds gears and pulleys; a Tank track has its own motor; mecanum and omni wheels drive any way. ' +
      'ESP32s talk to each other with ESP-NOW (esp_now.h, by MAC address), and BluetoothSerial shows in the serial monitor marked [BT]. A PS2 controller (library) is played with a game pad plugged into this PC, or the keyboard (arrows, 1-4, Q / E, Enter, I J K L). ' +
      'Flying: a Brushless motor + propeller on an ESC (servo signal from a board: 1000 us to arm, up to 2000 for full thrust); wired straight it turns clockwise, two phase wires swapped counter-clockwise, to suit its propeller. ' +
      'The move / turn arrows sit at the centre of the selected part (Grid menu: or its centre of mass, or its base). ' +
      'API (toolbar): your own programs drive the bench at http://127.0.0.1:7420/ (run, step, positions, buttons, serial; GET / there lists it all; this PC only, never web pages). ' +
      'MicroPython: an RP2040 board runs the real MicroPython: choose MicroPython in its program editor and write Python (machine.Pin, PWM, ADC, I2C, time); when the program ends, its >>> prompt is yours in the serial box. ' +
      'Sensors: a Thermal camera (AMG8833, 8 x 8 temperatures; Adafruit_AMG88xx) sees Warm objects; a Lidar (RPLidar A1; the RPLidar library on a serial port) measures all the way round. ' +
      'Courses (parts list): a ramp or hill, stairs, speed bumps, walls, an arena, rough ground, an obstacle field and line tracks to test a robot on; they are fixed in place on the bench. ' +
      'Ruler (M): click two points for the distance. Meter (V): a multimeter: click a pin (red probe), then another (black); it reads live while running. Parts list: what to buy with rough prices, and a wiring sheet to copy, save or print. ' +
      'Your own designs: My boards > Import 3D model (.stl) makes a part of it (its look, its weight, and a solid shape that keeps holes and hollows open). ' +
      'Grid (toolbar, G): parts snap to it when placed or moved; a part you put things on gets its own grid that fits it (odd sizes too), shown as blue dots. UI (toolbar): how big the buttons and text are; auto follows your display settings and screen. ' +
      'Your own boards: My boards (bottom of the parts list) > Import KiCad board or Make a part. Libraries: add-on parts to download. ' +
      'Drag with the left mouse to turn the view, right to slide, wheel to move forward and back the way you look (Ctrl + wheel: zoom).Run starts everything; while running, drag a part to pick it up and carry it (while holding: W A S D and R / F move the camera and what you hold comes along, right-drag turns the camera, Q / E turn it, the wheel sets the grip; let go to drop or throw it); hold Shift to shove things with a small ball. Click buttons to press them. Pin graph shows pins over time; Plot in a serial monitor graphs printed numbers.', 'info');
  }
}

/** The loop of a belt round two pulleys (centres ca, cb, radii ra, rb, axle n): round the far side of
 *  each, joined by the two straight runs that touch both. */
function beltPath(ca: THREE.Vector3, ra: number, cb: THREE.Vector3, rb: number, n: THREE.Vector3) {
  const d = cb.clone().sub(ca);
  d.addScaledVector(n, -d.dot(n)); // (in the first pulley's plane)
  const L = Math.max(1e-3, d.length());
  const u = d.divideScalar(L), w = n.clone().cross(u).normalize();
  const s = Math.max(-0.99, Math.min(0.99, (ra - rb) / L));
  const phi = Math.asin(s);
  const pts: THREE.Vector3[] = [];
  const at = (c: THREE.Vector3, r: number, a: number) => c.clone().addScaledVector(u, r * Math.cos(a)).addScaledVector(w, r * Math.sin(a));
  // where the straight runs touch: at angle pi/2 - phi on one side, -(pi/2 - phi) on the other
  const t1 = Math.PI / 2 - phi, t2 = -(Math.PI / 2 - phi);
  const N = 20;
  for (let i = 0; i <= N; i++) pts.push(at(ca, ra, t1 + ((2 * Math.PI - (t1 - t2)) * i) / N)); // round the back of A
  for (let i = 0; i <= N; i++) pts.push(at(cb, rb, t2 + ((t1 - t2) * i) / N)); // round the front of B
  return pts;
}
