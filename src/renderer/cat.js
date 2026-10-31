import * as THREE from 'three';

/** A small procedural cat. Local forward is +Z; feet on y = 0. */
export class Cat {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const fur = new THREE.MeshToonMaterial({ color: 0xe9a15a, transparent: true });
    const cream = new THREE.MeshToonMaterial({ color: 0xfff1dc, transparent: true });
    const dark = new THREE.MeshBasicMaterial({ color: 0x2b2018, transparent: true });
    const pink = new THREE.MeshBasicMaterial({ color: 0xff8fa8, transparent: true });
    this.materials = [fur, cream, dark, pink];
    const sphere = new THREE.SphereGeometry(1, 20, 14);
    const mesh = (geo, mat, parent, pos, scale = [1, 1, 1]) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos);
      m.scale.set(...scale);
      parent.add(m);
      return m;
    };

    this.body = mesh(sphere, fur, this.group, [0, 0.15, 0], [0.1, 0.09, 0.17]);
    mesh(sphere, cream, this.group, [0, 0.12, 0.05], [0.075, 0.06, 0.11]);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.25, 0.16);
    this.group.add(this.head);
    mesh(sphere, fur, this.head, [0, 0, 0], [0.078, 0.07, 0.07]);
    mesh(sphere, cream, this.head, [0, -0.022, 0.05], [0.04, 0.03, 0.03]);
    mesh(sphere, pink, this.head, [0, -0.005, 0.072], [0.008, 0.006, 0.006]);
    const ear = new THREE.ConeGeometry(0.03, 0.06, 4);
    for (const s of [-1, 1]) {
      const e = mesh(ear, fur, this.head, [s * 0.045, 0.065, 0], [1, 1, 0.6]);
      e.rotation.z = -s * 0.3;
    }
    this.eyes = [-1, 1].map((s) => mesh(sphere, dark, this.head, [s * 0.03, 0.012, 0.062], [0.011, 0.014, 0.006]));

    const leg = new THREE.CylinderGeometry(0.02, 0.018, 0.12, 8);
    leg.translate(0, -0.06, 0);
    this.legs = [
      [-0.055, 0.12],
      [0.055, 0.12],
      [-0.055, -0.11],
      [0.055, -0.11],
    ].map(([x, z]) => mesh(leg, fur, this.group, [x, 0.12, z]));

    this.tail = [];
    let parent = this.group;
    let pos = [0, 0.19, -0.16];
    const seg = new THREE.CylinderGeometry(0.016, 0.019, 0.08, 8);
    seg.translate(0, 0.04, 0);
    for (let i = 0; i < 4; i++) {
      const t = mesh(seg, fur, parent, pos);
      t.rotation.x = i === 0 ? -0.9 : -0.25;
      this.tail.push(t);
      parent = t;
      pos = [0, 0.08, 0];
    }
    this.time = 0;
  }

  get headWorld() {
    return this.head.getWorldPosition(new THREE.Vector3());
  }

  /** pose: { x, z, facing, size, walking, happy, opacity } */
  update(dt, pose) {
    this.time += dt;
    const t = this.time;
    const g = this.group;
    g.visible = pose.opacity > 0.01;
    if (!g.visible) return;
    g.position.set(pose.x, 0, pose.z);
    g.rotation.y = pose.facing;
    g.scale.setScalar(pose.size);
    for (const m of this.materials) m.opacity = pose.opacity;

    const w = pose.walking;
    this.legs.forEach((l, i) => {
      l.rotation.x = Math.sin(t * 11 + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.55 * w;
    });
    this.body.position.y = 0.15 + Math.abs(Math.sin(t * 11)) * 0.008 * w;
    this.head.rotation.x = -0.35 * pose.happy;
    this.head.rotation.z = Math.sin(t * 2.2) * 0.12 * pose.happy;
    for (const e of this.eyes) e.scale.y = 0.014 * (1 - 0.8 * pose.happy);
    this.tail.forEach((s, i) => {
      s.rotation.z = Math.sin(t * (3 + 2 * pose.happy) - i * 0.6) * (0.25 + 0.2 * pose.happy);
    });
  }
}
