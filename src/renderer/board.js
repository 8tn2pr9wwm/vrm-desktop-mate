import * as THREE from 'three';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const ASPECT = 0.62;
const CHALK_FONT = '"Chalkduster", "Bradley Hand", "Noteworthy", "Marker Felt", "Comic Sans MS", "Hiragino Maru Gothic ProN", sans-serif';

function seeded(seed) {
  let x = Math.floor(seed) >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

// Yomogi (SIL OFL 1.1, assets/fonts/Yomogi-OFL.txt): casual handwritten Japanese for board messages.
// Subset to ASCII, kana, full-width forms and the kanji in BOARD_MESSAGES; re-run pyftsubset when adding kanji.
const HAND_FONT = `"BoardHand", ${CHALK_FONT}`;
const handFont = new FontFace('BoardHand', `url(${new URL('../../assets/fonts/Yomogi-Regular.ttf', location.href)})`);
const handFontReady = handFont.load().then(
  (f) => document.fonts.add(f),
  (e) => console.warn('board font failed to load', e)
);
const NEAT = { font: CHALK_FONT, shift: 0.04, bob: 0.07, tilt: 0.12, squash: 0.08, weight: 0 };
const MESSY = { font: HAND_FONT, shift: 0.07, bob: 0.14, tilt: 0.3, squash: 0.18, weight: 0.05 };

const DOODLE_SPOTS = [[0.12, 0.15], [0.88, 0.15], [0.1, 0.87], [0.9, 0.87], [0.5, 0.92]];
const DOODLES = {
  heart: { color: '#f6a9bf', draw(g, r) {
    g.moveTo(0, r * 0.75);
    g.bezierCurveTo(-r * 1.5, -r * 0.2, -r * 0.7, -r * 1.25, 0, -r * 0.45);
    g.bezierCurveTo(r * 0.7, -r * 1.25, r * 1.5, -r * 0.2, 0, r * 0.75);
  } },
  cat: { color: '#f4f2e8', draw(g, r) {
    g.ellipse(0, r * 0.1, r * 0.95, r * 0.78, 0, -0.1 * Math.PI, 1.1 * Math.PI);
    g.moveTo(-r * 0.92, 0);
    g.lineTo(-r * 0.8, -r * 1.05);
    g.lineTo(-r * 0.3, -r * 0.62);
    g.quadraticCurveTo(0, -r * 0.72, r * 0.3, -r * 0.62);
    g.lineTo(r * 0.8, -r * 1.05);
    g.lineTo(r * 0.92, 0);
    for (const s of [-1, 1]) {
      g.moveTo(s * r * 0.38 + r * 0.06, -r * 0.05);
      g.arc(s * r * 0.38, -r * 0.05, r * 0.06, 0, Math.PI * 2);
      g.moveTo(s * r * 0.55, r * 0.25);
      g.lineTo(s * r * 1.25, r * 0.12);
      g.moveTo(s * r * 0.55, r * 0.38);
      g.lineTo(s * r * 1.2, r * 0.45);
    }
    g.moveTo(-r * 0.16, r * 0.28);
    g.quadraticCurveTo(-r * 0.08, r * 0.4, 0, r * 0.28);
    g.quadraticCurveTo(r * 0.08, r * 0.4, r * 0.16, r * 0.28);
  } },
  star: { color: '#f3e39a', draw(g, r) {
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
  } },
  note: { color: '#a9d8f2', draw(g, r) {
    g.ellipse(-r * 0.35, r * 0.6, r * 0.32, r * 0.22, -0.4, 0, Math.PI * 2);
    g.moveTo(-r * 0.05, r * 0.55);
    g.lineTo(-r * 0.05, -r * 0.9);
    g.quadraticCurveTo(r * 0.3, -r * 0.5, r * 0.6, -r * 0.45);
  } },
  flower: { color: '#f4f2e8', draw(g, r) {
    for (let i = 0; i < 5; i++) {
      const a = (i * 2 * Math.PI) / 5;
      const x = Math.cos(a) * r * 0.55;
      const y = Math.sin(a) * r * 0.55 - r * 0.2;
      g.moveTo(x + r * 0.38, y);
      g.arc(x, y, r * 0.38, 0, Math.PI * 2);
    }
    g.moveTo(0, r * 0.4);
    g.quadraticCurveTo(r * 0.15, r * 0.8, 0, r * 1.1);
  } },
};

// Outside weather, always drawn as one of the doodles when known.
const WEATHER_DOODLES = {
  sun: { color: '#f7c873', draw(g, r) {
    g.moveTo(r * 0.42, 0);
    g.arc(0, 0, r * 0.42, 0, Math.PI * 2);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      g.moveTo(Math.cos(a) * r * 0.62, Math.sin(a) * r * 0.62);
      g.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
    }
  } },
  cloud: { color: '#dfe7ec', draw(g, r) {
    g.moveTo(-r * 0.85, r * 0.35);
    g.quadraticCurveTo(-r * 1.15, -r * 0.05, -r * 0.6, -r * 0.12);
    g.quadraticCurveTo(-r * 0.45, -r * 0.7, r * 0.05, -r * 0.48);
    g.quadraticCurveTo(r * 0.5, -r * 0.8, r * 0.68, -r * 0.15);
    g.quadraticCurveTo(r * 1.15, -r * 0.05, r * 0.85, r * 0.35);
    g.closePath();
  } },
  rain: { color: '#a9c4f2', draw(g, r) {
    g.moveTo(-r * 0.9, 0);
    g.arc(0, 0, r * 0.9, Math.PI, 0);
    for (let i = 0; i < 3; i++) {
      const x = r * 0.9 - i * r * 0.6;
      g.quadraticCurveTo(x - r * 0.3, -r * 0.22, x - r * 0.6, 0);
    }
    g.moveTo(0, -r * 0.9);
    g.lineTo(0, -r * 1.05);
    g.moveTo(0, 0);
    g.lineTo(0, r * 0.75);
    g.arc(-r * 0.15, r * 0.75, r * 0.15, 0, Math.PI);
    for (const [x, y] of [[-r * 1.1, r * 0.25], [r * 1.05, r * 0.4], [r * 0.6, r * 0.85]]) {
      g.moveTo(x, y);
      g.lineTo(x - r * 0.08, y + r * 0.25);
    }
  } },
  snow: { color: '#f4f2e8', draw(g, r) {
    g.moveTo(r * 0.3, -r * 0.5);
    g.arc(0, -r * 0.5, r * 0.3, 0, Math.PI * 2);
    g.moveTo(r * 0.48, r * 0.3);
    g.arc(0, r * 0.3, r * 0.48, 0, Math.PI * 2);
    for (const s of [-1, 1]) {
      g.moveTo(s * r * 0.12 + r * 0.03, -r * 0.55);
      g.arc(s * r * 0.12, -r * 0.55, r * 0.03, 0, Math.PI * 2);
      g.moveTo(s * r * 0.45, r * 0.15);
      g.lineTo(s * r * 0.95, -r * 0.15);
    }
    g.moveTo(-r * 0.32, -r * 0.82);
    g.lineTo(r * 0.32, -r * 0.82);
    g.lineTo(r * 0.2, -r * 1.05);
    g.lineTo(-r * 0.2, -r * 1.05);
    g.closePath();
  } },
};

/** A few small chalk doodles (heart, cat, star...) in the board's free corners, plus the weather when known. */
function doodles(g, rand, w, h, weather) {
  const kinds = Object.keys(DOODLES).sort(() => rand() - 0.5);
  const spots = DOODLE_SPOTS.slice().sort(() => rand() - 0.5);
  const count = 2 + Math.floor(rand() * 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const items = kinds.slice(0, count).map((k) => DOODLES[k]);
  if (WEATHER_DOODLES[weather]) items[0] = WEATHER_DOODLES[weather];
  items.forEach(({ color, draw }, i) => {
    const [sx, sy] = spots[i];
    const r = h * (0.07 + rand() * 0.025);
    g.save();
    g.translate(sx * w, sy * h);
    g.rotate((rand() - 0.5) * 0.5);
    g.strokeStyle = color;
    for (let p = 0; p < 2; p++) {
      g.globalAlpha = p ? 0.45 : 0.85;
      g.lineWidth = p ? 2 : 3.5;
      g.beginPath();
      g.save();
      g.translate((rand() - 0.5) * 2.5, (rand() - 0.5) * 2.5);
      draw(g, r);
      g.restore();
      g.stroke();
    }
    g.restore();
  });
  g.globalAlpha = 1;
}

/** Hand-written look: each glyph gets its own tilt, size, baseline wobble and a few offset chalk passes. */
function chalkText(g, text, cx, cy, size, rand, style = NEAT) {
  g.font = `${size}px ${style.font}`;
  g.strokeStyle = '#f4f2e8';
  g.lineWidth = size * style.weight;
  g.lineJoin = 'round';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f4f2e8';
  const glyphs = [...text];
  const advance = glyphs.map((ch) => (ch === '♥' ? size * 0.85 : g.measureText(ch).width * (ch === ' ' ? 1 : 0.94)));
  let x = cx - advance.reduce((a, b) => a + b, 0) / 2;
  glyphs.forEach((ch, i) => {
    const gx = x + advance[i] / 2 + (rand() - 0.5) * size * style.shift;
    x += advance[i];
    if (ch === ' ') return;
    g.save();
    if (ch === '♥') {
      g.translate(gx, cy);
      g.rotate((rand() - 0.5) * 0.3);
      g.strokeStyle = g.fillStyle = DOODLES.heart.color;
      const lw = g.lineWidth;
      g.lineWidth = Math.max(3, size * 0.07);
      g.lineJoin = 'round';
      g.beginPath();
      DOODLES.heart.draw(g, size * 0.34);
      g.globalAlpha = 0.55;
      g.fill();
      g.globalAlpha = 0.9;
      g.stroke();
      g.restore();
      g.fillStyle = g.strokeStyle = '#f4f2e8';
      g.lineWidth = lw;
      return;
    }
    g.translate(gx, cy + (rand() - 0.5) * size * style.bob);
    g.rotate((rand() - 0.5) * style.tilt);
    g.scale(1 + (rand() - 0.5) * style.squash, 1 + (rand() - 0.5) * style.squash * 1.2);
    for (let p = 0; p < 4; p++) {
      g.globalAlpha = p ? 0.35 : 0.8;
      const ox = (rand() - 0.5) * size * 0.015;
      const oy = (rand() - 0.5) * size * 0.015;
      g.fillText(ch, ox, oy);
      if (style.weight) g.strokeText(ch, ox, oy);
    }
    g.restore();
  });
  g.globalAlpha = 1;
}

/** A small framed blackboard showing the current time in chalk, for the character to hold up. */
export class Board {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = Math.round(512 * ASPECT);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1, ASPECT), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.08, ASPECT + 0.08, 0.03), new THREE.MeshLambertMaterial({ color: 0x8a5a33, transparent: true }));
    face.position.z = 0.016;
    this.group = new THREE.Group();
    this.group.add(frame, face);
    this.group.visible = false;
    this.materials = [face.material, frame.material];
    scene.add(this.group);
    this.shown = '';
    this.message = null;
    handFontReady.then(() => (this.shown = ''));
  }

  /** Show a chalk message ("\n" for line breaks, "♥" drawn as a pink heart) instead of the time; null for the time. */
  setMessage(message) {
    this.message = message;
  }

  /** Outside weather for its doodle: 'sun' | 'cloud' | 'rain' | 'snow', or null for none. */
  setWeather(weather) {
    this.weather = weather;
  }

  draw(date) {
    const key = `${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${this.message}-${this.weather}`;
    if (key === this.shown) return;
    this.shown = key;
    const rand = seeded(date.getTime() / 60000);
    const g = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    const bg = g.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.7);
    bg.addColorStop(0, '#2c3430');
    bg.addColorStop(1, '#151a18');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // faint smudges of erased chalk
    g.fillStyle = 'rgba(255, 255, 255, 0.035)';
    for (let i = 0; i < 7; i++) {
      g.save();
      g.translate(rand() * w, rand() * h);
      g.rotate((rand() - 0.5) * 0.6);
      g.fillRect(-60, -10, 120 + rand() * 120, 14 + rand() * 18);
      g.restore();
    }

    const chalk = this.chalkLayer ??= document.createElement('canvas');
    chalk.width = w;
    chalk.height = h;
    const c = chalk.getContext('2d');
    const pad = (n) => String(n).padStart(2, '0');
    if (this.message) {
      const lines = this.message.split('\n');
      const size = Math.min(92, (w * 0.78) / Math.max(...lines.map((l) => [...l].length)));
      const gap = size * 1.25;
      lines.forEach((line, i) => chalkText(c, line, w * 0.5, h * 0.5 + (i - (lines.length - 1) / 2) * gap, size, rand, MESSY));
    } else {
      chalkText(c, `${date.getMonth() + 1}/${date.getDate()} (${WEEKDAYS[date.getDay()]})`, w * 0.5, h * 0.2, 44, rand);
      chalkText(c, `${date.getHours()}:${pad(date.getMinutes())}`, w * 0.5, h * 0.62, 150, rand);
    }
    doodles(c, rand, w, h, this.weather);
    // chalk grain: erase speckles and dragged streaks so strokes look rubbed onto the board
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6000; i++) {
      c.globalAlpha = 0.3 + rand() * 0.7;
      c.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 1.5);
    }
    c.lineWidth = 1.2;
    for (let i = 0; i < 260; i++) {
      const x = rand() * w;
      const y = rand() * h;
      c.globalAlpha = 0.5;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 6 + rand() * 14, y - 3 - rand() * 6);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    g.drawImage(chalk, 0, 0);
    this.texture.needsUpdate = true;
  }

  /** Width of the board in meters, placement in world space, and fade 0..1. */
  update({ width = 0.4, position, quaternion, opacity = 0 }) {
    this.group.visible = opacity > 0.01;
    if (!this.group.visible) return;
    this.draw(new Date());
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    this.group.scale.setScalar(width);
    for (const m of this.materials) m.opacity = opacity;
  }
}
