// Authors the bundled VRMA motions as Text-To-VRMA motion specs and converts them with its builder.
// usage: node tools/vrma/build-motions.mjs
import { writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { SKELETON, buildVRMA } from './vrmaBuilder.js';

const OUT = new URL('../../assets/motions/', import.meta.url);

// Rest skeleton for solving arm angles (VRM1: +Z forward, +X = model's left).
const root = new THREE.Object3D();
const nodes = {};
for (const [name, [parent, t]] of Object.entries(SKELETON)) {
  nodes[name] = new THREE.Object3D();
  nodes[name].position.fromArray(t);
  (parent ? nodes[parent] : root).add(nodes[name]);
}
const D = THREE.MathUtils.degToRad;
function setPose(rot) {
  for (const n of Object.values(nodes)) n.quaternion.identity();
  for (const [b, r] of Object.entries(rot)) nodes[b].quaternion.setFromEuler(new THREE.Euler(D(r[0]), D(r[1]), D(r[2]), 'XYZ'));
  root.updateMatrixWorld(true);
}
const wpos = (b, local = [0, 0, 0]) => nodes[b].localToWorld(new THREE.Vector3(...local));
const wdir = (b, d) => new THREE.Vector3(...d).applyQuaternion(nodes[b].getWorldQuaternion(new THREE.Quaternion()));
const mirror = (r) => [r[0], -r[1], -r[2]];
const range = (a, b, s) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);

// Clap: palms meet in front of the chest.
let clap = null;
for (const az of range(-70, -20, 2)) for (const ay of range(-80, 0, 2)) for (const by of range(-140, -30, 2)) {
  setPose({ leftUpperArm: [0, ay, az], leftLowerArm: [0, by, 0] });
  const p = wpos('leftHand', [0.08, 0, 0]);
  const cost = (p.x - 0.02) ** 2 + 0.5 * (p.y - 1.18) ** 2 + 0.5 * (p.z - 0.3) ** 2;
  if (!clap || cost < clap.cost) clap = { cost, az, ay, by };
}
let best = -2;
for (const hx of range(-180, 180, 5)) {
  setPose({ leftUpperArm: [0, clap.ay, clap.az], leftLowerArm: [0, clap.by, 0], leftHand: [hx, 0, 0] });
  const d = wdir('leftHand', [0, -1, 0]).dot(new THREE.Vector3(-1, 0, 0));
  if (d > best) { best = d; clap.hx = hx; }
}
console.log('clap', clap, 'palm dot', best.toFixed(2));

// Wave: right forearm upright, palm toward the viewer.
const waveUpper = [0, 20, 30];
let wave = null;
for (const bz of range(-160, -40, 1)) {
  setPose({ rightUpperArm: waveUpper, rightLowerArm: [0, 0, bz] });
  const d = wdir('rightLowerArm', [-1, 0, 0]).y;
  if (!wave || d > wave.d) wave = { d, bz };
}
best = -2;
for (const hx of range(-180, 180, 5)) {
  setPose({ rightUpperArm: waveUpper, rightLowerArm: [0, 0, wave.bz], rightHand: [hx, 0, 0] });
  const d = wdir('rightHand', [0, -1, 0]).z;
  if (d > best) { best = d; wave.hx = hx; }
}
console.log('wave', wave, 'palm dot', best.toFixed(2));

const ARMS_DOWN = { leftUpperArm: [0, -5, -72], leftLowerArm: [0, -10, 0], rightUpperArm: [0, 5, 72], rightLowerArm: [0, 10, 0] };
const HANDS_FRONT = { leftUpperArm: [0, -22, -70], leftLowerArm: [0, -38, 0], rightUpperArm: [0, 22, 70], rightLowerArm: [0, 38, 0] };
const OPEN_HAND = (side) => Object.fromEntries(['Index', 'Middle', 'Ring', 'Little'].flatMap((f) => ['Proximal', 'Intermediate', 'Distal'].map((s) => [`${side}${f}${s}`, [0, 0, 0]])));
const smooth = (x) => x * x * (3 - 2 * x);

// keyframes: [[t, { bone: [x,y,z] }], ...]; bones missing from a frame hold the rest pose.
function spec(name, duration, frames, { hips = [], expressions = {} } = {}) {
  const bones = new Set(frames.flatMap(([, f]) => Object.keys(f)));
  const tracks = {};
  for (const b of bones) tracks[b] = frames.map(([t, f]) => ({ t, r: f[b] ?? [0, 0, 0] }));
  return { name, duration, loop: false, tracks, hips, expressions };
}
const hold = (pose, extra = {}) => ({ ...pose, ...extra });

const motions = {};

// 手を振る
{
  const up = { ...ARMS_DOWN, rightUpperArm: waveUpper, rightHand: [wave.hx, 0, 0], ...OPEN_HAND('right'), head: [0, 0, -6], neck: [0, 0, -3] };
  const frames = [[0, ARMS_DOWN], [0.5, hold(up, { rightLowerArm: [0, 0, wave.bz] })]];
  for (let i = 0; i < 6; i++) frames.push([0.8 + i * 0.3, hold(up, { rightLowerArm: [0, 0, wave.bz + (i % 2 ? -18 : 18)] })]);
  frames.push([2.6, hold(up, { rightLowerArm: [0, 0, wave.bz] })], [3.2, ARMS_DOWN]);
  motions.vrma_wave = spec('wave', 3.2, frames, { expressions: { happy: [{ t: 0, w: 0 }, { t: 0.5, w: 0.6 }, { t: 2.6, w: 0.6 }, { t: 3.2, w: 0 }] } });
}

// 喜んでジャンプ
{
  const crouch = { ...ARMS_DOWN, leftUpperLeg: [-25, 0, 0], rightUpperLeg: [-25, 0, 0], leftLowerLeg: [50, 0, 0], rightLowerLeg: [50, 0, 0], leftFoot: [-25, 0, 0], rightFoot: [-25, 0, 0], spine: [10, 0, 0] };
  const air = { leftUpperArm: [0, -20, 62], rightUpperArm: [0, 20, -62], leftLowerArm: [0, -15, 0], rightLowerArm: [0, 15, 0], leftUpperLeg: [-12, 0, 0], rightUpperLeg: [-12, 0, 0], leftLowerLeg: [28, 0, 0], rightLowerLeg: [28, 0, 0], leftFoot: [20, 0, 0], rightFoot: [20, 0, 0], spine: [-6, 0, 0], head: [-10, 0, 0], ...OPEN_HAND('left'), ...OPEN_HAND('right') };
  motions.vrma_joy_jump = spec('joyJump', 2, [[0, ARMS_DOWN], [0.45, crouch], [0.75, air], [0.95, air], [1.2, crouch], [1.6, ARMS_DOWN], [2, ARMS_DOWN]], {
    hips: [{ t: 0, p: [0, 0, 0] }, { t: 0.45, p: [0, -0.075, 0] }, { t: 0.75, p: [0, 0.16, 0] }, { t: 0.95, p: [0, 0.14, 0] }, { t: 1.2, p: [0, -0.075, 0] }, { t: 1.6, p: [0, 0, 0] }, { t: 2, p: [0, 0, 0] }],
    expressions: { happy: [{ t: 0, w: 0 }, { t: 0.6, w: 1 }, { t: 1.4, w: 1 }, { t: 2, w: 0 }], aa: [{ t: 0, w: 0 }, { t: 0.75, w: 0.5 }, { t: 1.2, w: 0 }, { t: 2, w: 0 }] },
  });
}

// お辞儀
{
  const bow = { ...HANDS_FRONT, spine: [16, 0, 0], chest: [12, 0, 0], upperChest: [6, 0, 0], neck: [6, 0, 0], head: [6, 0, 0] };
  motions.vrma_bow = spec('bow', 3, [[0, ARMS_DOWN], [0.5, HANDS_FRONT], [1.2, bow], [1.9, bow], [2.6, HANDS_FRONT], [3, ARMS_DOWN]], {
    hips: [{ t: 0, p: [0, 0, 0] }, { t: 1.2, p: [0, 0, -0.04] }, { t: 1.9, p: [0, 0, -0.04] }, { t: 2.6, p: [0, 0, 0] }, { t: 3, p: [0, 0, 0] }],
    expressions: { relaxed: [{ t: 0, w: 0 }, { t: 1.2, w: 0.5 }, { t: 2.4, w: 0.5 }, { t: 3, w: 0 }] },
  });
}

// 伸び
{
  const up = { leftUpperArm: [0, -8, 75], rightUpperArm: [0, 8, -75], leftLowerArm: [0, -10, 0], rightLowerArm: [0, 10, 0], spine: [-5, 0, 0], chest: [-5, 0, 0], head: [-14, 0, 0], leftFoot: [16, 0, 0], rightFoot: [16, 0, 0], ...OPEN_HAND('left'), ...OPEN_HAND('right') };
  const lean = (z) => hold(up, { spine: [-4, 0, z], chest: [-4, 0, z * 0.6] });
  motions.vrma_stretch = spec('stretch', 4.2, [[0, ARMS_DOWN], [1.1, up], [1.6, lean(8)], [2.3, lean(-8)], [2.8, up], [3.6, ARMS_DOWN], [4.2, ARMS_DOWN]], {
    hips: [{ t: 0, p: [0, 0, 0] }, { t: 1.1, p: [0, 0.035, 0] }, { t: 2.8, p: [0, 0.035, 0] }, { t: 3.6, p: [0, 0, 0] }, { t: 4.2, p: [0, 0, 0] }],
    expressions: { relaxed: [{ t: 0, w: 0 }, { t: 1.1, w: 0.8 }, { t: 3.2, w: 0.8 }, { t: 4.2, w: 0 }], blink: [{ t: 0, w: 0 }, { t: 1.1, w: 0.9 }, { t: 2.8, w: 0.9 }, { t: 3.4, w: 0 }, { t: 4.2, w: 0 }] },
  });
}

// 拍手
{
  const base = { leftUpperArm: [0, clap.ay, clap.az], rightUpperArm: mirror([0, clap.ay, clap.az]), leftHand: [clap.hx, 0, 0], rightHand: mirror([clap.hx, 0, 0]), ...OPEN_HAND('left'), ...OPEN_HAND('right'), head: [4, 0, 0] };
  const at = (bend) => hold(base, { leftLowerArm: [0, bend, 0], rightLowerArm: mirror([0, bend, 0]) });
  const frames = [[0, ARMS_DOWN], [0.45, at(clap.by + 30)]];
  for (let i = 0; i < 6; i++) frames.push([0.6 + i * 0.32, at(clap.by)], [0.76 + i * 0.32, at(clap.by + 28)]);
  frames.push([2.9, ARMS_DOWN], [3.2, ARMS_DOWN]);
  motions.vrma_clap = spec('clap', 3.2, frames, { expressions: { happy: [{ t: 0, w: 0 }, { t: 0.5, w: 0.8 }, { t: 2.6, w: 0.8 }, { t: 3.2, w: 0 }] } });
}

// ちょっと踊る
{
  const frames = [];
  const hips = [];
  const T = 4;
  for (let i = 0; i <= 32; i++) {
    const t = i * 0.125;
    const env = smooth(Math.min(1, t / 0.4, (T - t) / 0.4));
    const sway = Math.sin(2 * Math.PI * t / 1);
    const bounce = env * (1 - Math.cos(4 * Math.PI * t)) / 2;
    const dx = 0.03 * env * sway;
    const legZ = -THREE.MathUtils.radToDeg(Math.asin(dx / 0.8));
    const swing = 12 * env * Math.sin(2 * Math.PI * t / 1);
    frames.push([t, {
      leftUpperArm: [0, -15 * env - 5, -72 + 22 * env + swing], rightUpperArm: [0, 15 * env + 5, 72 - 22 * env + swing],
      leftLowerArm: [0, -10 - 75 * env, 0], rightLowerArm: [0, 10 + 75 * env, 0],
      spine: [0, 0, 6 * env * sway], chest: [0, 0, -3 * env * sway], head: [0, 0, -7 * env * sway],
      leftUpperLeg: [-9 * bounce, 0, legZ], rightUpperLeg: [-9 * bounce, 0, legZ],
      leftLowerLeg: [18 * bounce, 0, 0], rightLowerLeg: [18 * bounce, 0, 0],
      leftFoot: [-9 * bounce, 0, -legZ], rightFoot: [-9 * bounce, 0, -legZ],
    }]);
    hips.push({ t, p: [dx, -0.012 * bounce, 0] });
  }
  motions.vrma_dance = spec('dance', T, frames, { hips, expressions: { happy: [{ t: 0, w: 0 }, { t: 0.5, w: 0.7 }, { t: 3.5, w: 0.7 }, { t: 4, w: 0 }] } });
}

// 眠そうにあくび
{
  const yawn = { ...ARMS_DOWN, leftUpperArm: [0, -5, -60], rightUpperArm: [0, 5, 60], upperChest: [-6, 0, 0], neck: [-6, 0, 0], head: [-14, 0, 4] };
  const drowsy = { ...ARMS_DOWN, spine: [6, 0, 0], neck: [6, 0, 0], head: [12, 0, 6] };
  motions.vrma_yawn = spec('yawn', 4.4, [[0, ARMS_DOWN], [1, yawn], [1.8, yawn], [2.6, drowsy], [3.2, hold(drowsy, { head: [24, 0, 6] })], [3.5, ARMS_DOWN], [4.4, ARMS_DOWN]], {
    expressions: {
      aa: [{ t: 0, w: 0 }, { t: 0.9, w: 0.9 }, { t: 1.8, w: 0.9 }, { t: 2.3, w: 0 }, { t: 4.4, w: 0 }],
      blink: [{ t: 0, w: 0 }, { t: 1, w: 1 }, { t: 1.8, w: 1 }, { t: 2.4, w: 0.55 }, { t: 3.2, w: 0.85 }, { t: 3.45, w: 0 }, { t: 4.4, w: 0 }],
      relaxed: [{ t: 0, w: 0 }, { t: 2.4, w: 0.6 }, { t: 3.3, w: 0.6 }, { t: 4.4, w: 0 }],
    },
  });
}

// 首をかしげる
{
  const tilt = (z) => ({ ...HANDS_FRONT, neck: [0, 4, z * 0.4], head: [-4, 8, z], spine: [0, 0, z * 0.15] });
  motions.vrma_head_tilt = spec('headTilt', 3, [[0, ARMS_DOWN], [0.6, tilt(0)], [1.1, tilt(20)], [2.1, tilt(20)], [2.6, tilt(0)], [3, ARMS_DOWN]], {
    expressions: { surprised: [{ t: 0, w: 0 }, { t: 1.1, w: 0.25 }, { t: 2.1, w: 0.25 }, { t: 3, w: 0 }] },
  });
}

for (const [id, s] of Object.entries(motions)) {
  const glb = buildVRMA(s);
  writeFileSync(new URL(`${id}.vrma`, OUT), Buffer.from(glb));
  console.log(id, s.duration, glb.byteLength);
}
