import * as THREE from 'three';

function makeTexture(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  draw(canvas.getContext('2d'));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const heartTexture = () =>
  makeTexture((g) => {
    const path = new Path2D('M64 112 C20 80 6 58 6 38 C6 20 20 8 36 8 C48 8 58 15 64 26 C70 15 80 8 92 8 C108 8 122 20 122 38 C122 58 108 80 64 112 Z');
    const grad = g.createLinearGradient(0, 8, 0, 112);
    grad.addColorStop(0, '#ff8fbf');
    grad.addColorStop(1, '#ff2d78');
    g.shadowColor = 'rgba(255, 60, 130, 0.6)';
    g.shadowBlur = 10;
    g.fillStyle = grad;
    g.fill(path);
    g.shadowBlur = 0;
    g.lineWidth = 5;
    g.strokeStyle = '#ffffff';
    g.stroke(path);
    g.fillStyle = 'rgba(255, 255, 255, 0.75)';
    g.beginPath();
    g.ellipse(38, 34, 12, 7, -0.6, 0, Math.PI * 2);
    g.fill();
  });

const starTexture = () =>
  makeTexture((g) => {
    const glow = g.createRadialGradient(64, 64, 0, 64, 64, 60);
    glow.addColorStop(0, 'rgba(255, 250, 200, 0.9)');
    glow.addColorStop(0.35, 'rgba(255, 220, 90, 0.35)');
    glow.addColorStop(1, 'rgba(255, 220, 90, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fff6c4';
    g.beginPath();
    g.moveTo(64, 4);
    g.quadraticCurveTo(70, 58, 124, 64);
    g.quadraticCurveTo(70, 70, 64, 124);
    g.quadraticCurveTo(58, 70, 4, 64);
    g.quadraticCurveTo(58, 58, 64, 4);
    g.fill();
  });

/** Short-lived sprite particles (hearts, sparkles) drawn in front of the character. */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.textures = { heart: heartTexture(), star: starTexture() };
    this.items = [];
  }

  spawn(kind, position, { size, life, delay = 0, drift = new THREE.Vector3(), grow = 1, spin = 0 }) {
    const material = new THREE.SpriteMaterial({ map: this.textures[kind], transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 10;
    sprite.visible = false;
    sprite.position.copy(position).setZ(5);
    this.scene.add(sprite);
    this.items.push({ kind, sprite, origin: sprite.position.clone(), size, life, age: -delay, drift, grow, spin });
  }

  heart(from, side, scale) {
    this.spawn('heart', from, { size: 0.09 * scale, life: 1.7, grow: 3.2, drift: new THREE.Vector3(side * 0.18, 0.32, 0).multiplyScalar(scale) });
    this.spawn('heart', from, { size: 0.04 * scale, life: 1.2, delay: 0.12, grow: 2, drift: new THREE.Vector3(side * 0.32, 0.18, 0).multiplyScalar(scale) });
    this.spawn('heart', from, { size: 0.035 * scale, life: 1.1, delay: 0.22, grow: 2, drift: new THREE.Vector3(side * 0.08, 0.42, 0).multiplyScalar(scale) });
  }

  sparkle(eye, outward, scale) {
    const offsets = [
      [0.06, 0.04, 0.08, 0],
      [0.1, -0.005, 0.05, 0.1],
      [0.04, 0.09, 0.04, 0.18],
    ];
    for (const [x, y, size, delay] of offsets) {
      const p = eye.clone().add(new THREE.Vector3(outward * x, y, 0).multiplyScalar(scale));
      this.spawn('star', p, { size: size * scale, life: 0.8, delay, spin: 3 });
    }
  }

  update(dt) {
    this.items = this.items.filter((it) => {
      it.age += dt;
      if (it.age < 0) return true;
      const u = it.age / it.life;
      if (u >= 1) {
        this.scene.remove(it.sprite);
        it.sprite.material.dispose();
        return false;
      }
      const s = it.sprite;
      s.visible = true;
      if (it.kind === 'heart') {
        const ease = 1 - (1 - u) ** 2;
        s.position.copy(it.origin).addScaledVector(it.drift, ease);
        s.position.x += Math.sin(u * Math.PI * 3) * 0.015;
        const k = it.size * (1 + (it.grow - 1) * ease) * (u < 0.12 ? u / 0.12 : 1);
        s.scale.set(k, k, 1);
        s.material.rotation = Math.sin(u * Math.PI * 2) * 0.25;
        s.material.opacity = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      } else {
        const k = it.size * Math.sin(Math.PI * u);
        s.scale.set(k, k, 1);
        s.material.rotation = it.spin * it.age;
        s.material.opacity = 1;
      }
      return true;
    });
  }
}
