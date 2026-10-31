import * as THREE from 'three';
import { Character } from './character.js';
import { FaceTracker } from './tracker.js';

const mate = window.mate;
const DEBUG = new URLSearchParams(location.search).has('debug');

const canvas = document.getElementById('scene');
const previewEl = document.getElementById('preview');
const previewCanvas = previewEl.querySelector('canvas');
const previewText = previewEl.querySelector('pre');
const gazeDot = document.getElementById('gaze-dot');
const toastEl = document.getElementById('toast');

let settings = await mate.getSettings();
let view = { w: window.innerWidth, h: window.innerHeight };
let ppm = 200;

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 1000);
camera.position.set(0, 0, 50);

const keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
keyLight.position.set(0.5, 1.5, 2);
scene.add(keyLight, new THREE.AmbientLight(0xffffff, Math.PI * 0.45));

const character = new Character(scene);
character.loadMotion = (id) => mate.loadMotion(id);
const tracker = new FaceTracker({ fovDeg: settings.cameraFovDeg });

function toast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toastEl.style.opacity = '0'), ms);
}

function resize() {
  view = { w: window.innerWidth, h: window.innerHeight };
  ppm = settings.characterHeight / character.height;
  renderer.setSize(view.w, view.h, false);
  camera.left = 0;
  camera.right = view.w / ppm;
  camera.top = view.h / ppm;
  camera.bottom = 0;
  camera.updateProjectionMatrix();
}

const pxToWorld = (x, y, zPx = 0) => new THREE.Vector3(x / ppm, (view.h - y) / ppm, zPx / ppm);

/** Screen-space meters (origin = webcam at top center of screen) -> window pixels. */
function physToPx([x, y, z = 0]) {
  const k = 1000 / settings.pixelPitchMm;
  return { x: view.w / 2 + x * k, y: -y * k, z: z * k };
}

async function loadVrm() {
  try {
    const { name, data } = await mate.readVrm();
    const firstLoad = !character.vrm;
    await character.load(data);
    resize();
    if (firstLoad) character.position.set(view.w / 2 / ppm, 0, 0);
    toast(`${name} を読み込みました`);
  } catch (err) {
    console.error(err);
    toast(`VRMの読み込みに失敗しました: ${err.message}`, 5000);
  }
}

async function applyCamera() {
  if (settings.cameraEnabled) {
    try {
      await tracker.start();
    } catch (err) {
      console.error(err);
      toast(`カメラを開始できませんでした: ${err.message}`, 5000);
    }
  } else {
    tracker.stop();
  }
  previewEl.style.display = settings.showPreview ? 'block' : 'none';
  gazeDot.style.display = settings.showPreview ? 'block' : 'none';
}

mate.onSettingsChanged(async (next) => {
  const prev = settings;
  settings = next;
  if (prev.vrmPath !== next.vrmPath) await loadVrm();
  if (prev.characterHeight !== next.characterHeight) resize();
  if (prev.cameraEnabled !== next.cameraEnabled || prev.showPreview !== next.showPreview) applyCamera();
  applyWeather();
});
mate.onBoundsChanged(() => resize());
window.addEventListener('resize', resize);

// --- Pointer interaction (window is click-through except over the character) ---
let cursor = { x: -1, y: -1 };
let cursorMovedAt = -Infinity;
let hovering = false;
let pointerDown = null;

function updateHover() {
  const r = character.screenRect(ppm, view.h);
  const inside = cursor.x >= r.left && cursor.x <= r.right && cursor.y >= r.top && cursor.y <= r.bottom;
  const next = inside || character.state === 'held';
  if (next !== hovering) {
    hovering = next;
    mate.setIgnoreMouse(!hovering);
    document.body.classList.toggle('hover', hovering);
  }
}

mate.onCursor((p) => {
  if (p.x !== cursor.x || p.y !== cursor.y) cursorMovedAt = performance.now();
  cursor = p;
  updateHover();
});

window.addEventListener('pointerdown', (e) => {
  if (!hovering || e.button !== 0) return;
  pointerDown = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  cursorMovedAt = performance.now();
  if (!pointerDown) return;
  if (!pointerDown.moved && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4) {
    pointerDown.moved = true;
    character.grab(pxToWorld(pointerDown.x, pointerDown.y));
    document.body.classList.add('grabbing');
  }
  if (pointerDown.moved) character.drag(pxToWorld(e.clientX, e.clientY));
});
window.addEventListener('pointerup', () => {
  if (!pointerDown) return;
  if (pointerDown.moved) character.release();
  else character.poke();
  pointerDown = null;
  document.body.classList.remove('grabbing');
  updateHover();
});
window.addEventListener('contextmenu', (e) => {
  if (!hovering) return;
  e.preventDefault();
  mate.showMenu();
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) mate.dropVrm(file);
});

// --- Gaze ---
let watchTime = 0;
let lastRawGazePx = null;

function gazePx(face) {
  if (!face.present || !face.gaze) return null;
  const raw = physToPx(face.gaze);
  lastRawGazePx = raw;
  return { x: raw.x + settings.gazeOffset.x, y: raw.y + settings.gazeOffset.y };
}

mate.onPerformAction((action) => character.perform(action));

let weather = await mate.getWeather();
const applyWeather = () => character.board.setWeather(settings.weatherDoodle ? weather : null);
applyWeather();
mate.onWeather((w) => {
  weather = w;
  applyWeather();
});

// Bijin-tokei style: hold up the time board at the start of each scheduled minute (retry while busy).
const CLOCK_STEP = { minute: 1, tenMinutes: 10, hour: 60 };
let clockShown = '';
setInterval(() => {
  const step = CLOCK_STEP[settings.clockMode];
  const now = new Date();
  const key = now.toDateString() + now.getHours() + ':' + now.getMinutes();
  if (!step || !character.vrm || key === clockShown || now.getSeconds() > 40) return;
  if ((now.getHours() * 60 + now.getMinutes()) % step) return;
  if (character.state === 'clock') clockShown = key;
  else character.perform('clock');
}, 1000);

mate.onCalibrateGaze(() => {
  if (!lastRawGazePx || !tracker.state.present) {
    toast('顔が検出できていません。カメラを有効にしてください。');
    return;
  }
  const r = character.screenRect(ppm, view.h);
  mate.updateSettings({ gazeOffset: { x: r.cx - lastRawGazePx.x, y: r.cy - lastRawGazePx.y } });
  toast('視線をキャリブレーションしました');
});

function computeLook(dt, now) {
  const face = tracker.state;
  const rect = character.screenRect(ppm, view.h);
  const gaze = gazePx(face);

  const near = gaze && gaze.x > rect.left - 120 && gaze.x < rect.right + 120 && gaze.y > rect.top - 120 && gaze.y < rect.bottom + 60;
  watchTime = near ? Math.min(watchTime + dt, 2) : Math.max(watchTime - dt * 2, 0);
  const watched = watchTime > 0.6;

  let target = null;
  if (face.present) {
    const head = physToPx(face.head);
    const userWorld = pxToWorld(head.x, head.y, head.z);
    if (settings.lookMode === 'follow' && gaze && !watched) target = pxToWorld(gaze.x, gaze.y, 0.25 * ppm);
    else target = userWorld;
  } else if (now - cursorMovedAt < 4000 && cursor.x >= 0) {
    target = pxToWorld(cursor.x, cursor.y, 0.6 * ppm);
  }

  const headRoll = face.present && settings.mimicHeadTilt ? face.roll : null;

  if (settings.showPreview) {
    if (gaze) {
      gazeDot.style.left = `${gaze.x}px`;
      gazeDot.style.top = `${gaze.y}px`;
    }
    tracker.drawPreview(previewCanvas, gaze, view);
    const deg = (r) => ((r * 180) / Math.PI).toFixed(0);
    previewText.textContent = face.present
      ? `距離 ${(face.head[2] * 100).toFixed(0)}cm  yaw ${deg(face.yaw)}°  pitch ${deg(face.pitch)}°  roll ${deg(face.roll)}°\n` +
        `視線 ${gaze ? `${gaze.x.toFixed(0)}, ${gaze.y.toFixed(0)}` : '-'}  ${watched ? '見られてる!' : ''}  状態 ${character.state}`
      : settings.cameraEnabled
        ? '顔を検出していません'
        : 'カメラはオフです';
  }

  return { target, headRoll, watched: face.present && watched };
}

// --- Main loop ---
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  if (character.vrm) {
    const look = computeLook(dt, now);
    character.update(dt, { worldWidth: view.w / ppm, wander: settings.wander, ...look });
    if (character.state === 'held' || character.state === 'fall') updateHover();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
await loadVrm();
applyCamera();
frame();
if (DEBUG) {
  window.__mate = { character, tracker, settings: () => settings };
  setInterval(() => {
    const f = tracker.state;
    const r = (v) => (Array.isArray(v) ? v.map((x) => +x.toFixed(3)) : typeof v === 'number' ? +v.toFixed(3) : v);
    console.log(
      `debug ${JSON.stringify({ state: character.state, x: r(character.position.x), height: r(character.height), ppm: r(ppm), view, face: f.present ? { head: r(f.head), yaw: r(f.yaw), pitch: r(f.pitch), roll: r(f.roll), gaze: r(f.gaze) } : null, look: { yaw: r(character.look.yaw), pitch: r(character.look.pitch), roll: r(character.look.roll) } })}`,
    );
  }, 1000);
}
