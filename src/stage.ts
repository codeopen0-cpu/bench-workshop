// The 3D view: renderer, camera, orbit controls, the bench, lights, picking and the move/rotate gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  partsRoot = new THREE.Group(); // build mode: the parts, nested as glued
  runRoot = new THREE.Group(); // run mode: every rigid body, flat
  overlay = new THREE.Group(); // ghosts, grab line...
  ground: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1b1e24);
    this.scene.fog = new THREE.Fog(0x1b1e24, 400, 1400);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
    this.camera.position.set(22, 17, 27);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 3, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 4;
    this.orbit.maxDistance = 1500;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => (this.orbit.enabled = !(e as any).value));
    this.scene.add(this.gizmo.getHelper());

    // lights
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3326, 1.1);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.2));
    sun.position.set(60, 120, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera as THREE.OrthographicCamera;
    s.left = -90; s.right = 90; s.top = 90; s.bottom = -90; s.near = 1; s.far = 400;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    // the bench: a big table top with a 1 cm grid (10 cm lines brighter)
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.95 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.userData.isGround = true;
    this.scene.add(this.ground);
    const fine = new THREE.GridHelper(200, 200, 0x343944, 0x30353f);
    (fine.material as THREE.Material).transparent = true;
    (fine.material as THREE.Material).opacity = 0.5;
    fine.position.y = 0.01;
    const coarse = new THREE.GridHelper(1000, 100, 0x4a5262, 0x3d4452);
    coarse.position.y = 0.02;
    this.scene.add(fine, coarse);

    this.scene.add(this.partsRoot, this.runRoot, this.overlay);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    // (the UI size or the screen changed the pixels per CSS pixel: keep the 3D view sharp)
    const ratio = Math.min(window.devicePixelRatio, 2);
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  private setRay(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /** First hit among `roots` (part meshes) or the bench. */
  pick(ev: { clientX: number; clientY: number }, roots: THREE.Object3D[], includeGround = true) {
    this.setRay(ev);
    const targets = includeGround ? [...roots, this.ground] : roots;
    const hits = this.raycaster.intersectObjects(targets, true).filter((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
    for (const h of hits) {
      if (h.object.userData.ghost) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() : new THREE.Vector3(0, 1, 0);
      return { point: h.point.clone(), normal, object: h.object, ground: !!h.object.userData.isGround };
    }
    return null;
  }

  /** Where the mouse ray meets a plane facing the camera through `through` (for dragging in run mode). */
  /** The mouse's ray into the scene. */
  /** How bright the room is: 1 a lit room, 0 dark (lit LEDs and screens still glow). */
  setRoomLight(f: number) {
    const k = Math.max(0, Math.min(1, f));
    this.hemi.intensity = 0.04 + 1.06 * k;
    this.sun.intensity = 2.2 * k;
    const bg = new THREE.Color(0x1b1e24).multiplyScalar(0.25 + 0.75 * k);
    (this.scene.background as THREE.Color).copy(bg);
    (this.scene.fog as THREE.Fog).color.copy(bg);
  }
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  rayAt(ev: { clientX: number; clientY: number }) {
    this.setRay(ev);
    return this.raycaster.ray;
  }
  pointOnViewPlane(ev: { clientX: number; clientY: number }, through: THREE.Vector3) {
    this.setRay(ev);
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, through);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  frame(objects: THREE.Object3D[]) {
    const box = new THREE.Box3();
    for (const o of objects) box.expandByObject(o);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 5);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, size * 2.2);
  }
}
