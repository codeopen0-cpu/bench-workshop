// What you move things with while running: a small ball where the mouse is. Faint while it hovers
// over something it can take, bright while it holds something, orange while it pushes (Shift). The
// physics of it is in sim.ts (grab*, handPush); this is how it looks.
import * as THREE from 'three';

export type HandPose = 'open' | 'grip' | 'flat';

const COLORS: Record<HandPose, number> = { open: 0xffd25a, grip: 0xffd25a, flat: 0xff8a3a };

export class HandModel {
  root = new THREE.Group();
  pose: HandPose = 'open';
  private mat = new THREE.MeshStandardMaterial({ color: 0xffd25a, emissive: 0xffd25a, emissiveIntensity: 0.4, roughness: 0.4, transparent: true, opacity: 0.6 });
  private ball: THREE.Mesh;

  constructor() {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.mat);
    this.ball.castShadow = true;
    this.root.add(this.ball);
    this.root.visible = false;
    this.root.traverse((o) => (o.userData.isHand = true));
    this.setPose('open');
  }

  setPose(p: HandPose) {
    this.pose = p;
    this.mat.color.setHex(COLORS[p]);
    this.mat.emissive.setHex(COLORS[p]);
    this.mat.opacity = p === 'open' ? 0.55 : 0.95;
    // (the pushing ball is the solid one in the physics: 1.2 cm across; the others just mark the point)
    this.ball.scale.setScalar(p === 'flat' ? 1.2 : 0.45);
  }

  /** Put the ball at a point (where it holds, hovers or pushes). */
  place(at: THREE.Vector3, _camera?: THREE.Camera) {
    this.root.position.copy(at);
    this.root.visible = true;
  }

  hide() {
    this.root.visible = false;
  }
}
