import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { Effects } from './effects.js';
import { Cat } from './cat.js';
import { Board } from './board.js';
import { loadMixamoClip } from './motions.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import MOTIONS from '../motions.json';

const WALK_SPEED = 0.55;
const STRIDE = 1.25;
const TURN_SPEED = 5;
const GRAVITY = 18;
const MAX_LOOK_YAW = THREE.MathUtils.degToRad(80);
const MAX_LOOK_DOWN = THREE.MathUtils.degToRad(25);
const MAX_LOOK_UP = THREE.MathUtils.degToRad(10);
const PITCH_SCALE = 0.45;
const KISS_TIME = 2.2;
const SPIN_TIME = 1.1;
const PET_TIME = 7.5;
const CLOCK_TIME = 7;
const CLOCK_GRIP = [0.6, 0.7, 0.4];
// Hand wrapping a board edge from behind, so only short fingertips show.
const CLOCK_GRIP_FAR = [1.05, 1.2, 0.8];
// Overhead: fingers come over the side edge and rest on the board face, short.
const CLOCK_GRIP_OVERHEAD = [1.0, 1.15, 0.7];
const CLOCK_STYLES = ['chest', 'overhead', 'side', 'crouch'];
const BOARD_MESSAGES = ['お仕事\nがんばって♥', '大好き♥', 'こっち見て♥', '無理\nしないでね♥', 'ちょっと\n休憩しよ？', 'いつも\nえらいね♥'];
const BOARD_MESSAGE_CHANCE = 0.25;
const POSE_TIME = 6;
const POSE_BLEND = 0.7;
const POSE_LOOK_CATEGORIES = new Set(['かわいい', '立ち']);
const POSE_LYING_CATEGORY = '寝そべり';
const POSE_SITTING_CATEGORY = '座り';
const STANCE_HALF_WIDTH = 0.045;
const IDLE_ACTION_CHANCE = 0.25;
const WATCHED_ACTION_DELAY = 3;
const WATCHED_ACTION_COOLDOWN = 20;
const LOOK_SHARE = { spine: 0.1, chest: 0.2, neck: 0.3, head: 0.4 };

const rand = (a, b) => a + Math.random() * (b - a);
const smoothstep = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const lerp = THREE.MathUtils.lerp;
const damp = (current, target, lambda, dt) => THREE.MathUtils.damp(current, target, lambda, dt);

function dampAngle(current, target, lambda, dt) {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return current + diff * (1 - Math.exp(-lambda * dt));
}

// [finger, [proximal, intermediate, distal] curl, spread toward the index] in radians
const HEART_CURLS = [
  ['Index', [0.9, 1.0, 0.5], 0],
  ['Middle', [1.0, 1.1, 0.6], 0.03],
  ['Ring', [1.1, 1.1, 0.6], 0.08],
  ['Little', [1.2, 1.1, 0.6], 0.14]
];
const HEART_FINGER_BONES = [
  ...HEART_CURLS.flatMap(([f]) => ['Proximal', 'Intermediate', 'Distal'].map((seg) => f + seg)),
  'ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'
];

export class Character {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.lookTarget = new THREE.Object3D();
    scene.add(this.lookTarget);
    this.vrm = null;
    this.height = 1.6;
    this.width = 0.55;
    this.state = 'idle';
    this.stateTime = 0;
    this.idleDuration = rand(2, 5);
    this.walkTargetX = 0;
    this.phase = 0;
    this.walkBlend = 0;
    this.velocityY = 0;
    this.look = { yaw: 0, pitch: 0, roll: 0 };
    this.blinkTimer = rand(2, 5);
    this.blinkTime = -1;
    this.expr = { happy: 0, surprised: 0 };
    this.time = 0;
    this.holdOffset = new THREE.Vector2();
    this.actionRolled = false;
    this.watchedTime = 0;
    this.lastActionTime = -Infinity;
    this.spinBase = 0;
    this.effects = new Effects(scene);
    this.cat = new Cat(scene);
    this.board = new Board(scene);
    this.petSide = -1;
    this.petFx = false;
    this.kissFx = { star: false, heart: false };
  }

  async load(arrayBuffer) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(arrayBuffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMとして読み込めませんでした');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => {
      o.frustumCulled = false;
    });

    this.dispose();
    this.vrm = vrm;
    this.poseClips = new Map();
    this.sign = vrm.meta?.metaVersion === '0' ? -1 : 1;
    this.root.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    vrm.update(0);
    this.root.updateMatrixWorld(true);
    const headPos = this.bone('head').getWorldPosition(new THREE.Vector3());
    const rootPos = this.root.getWorldPosition(new THREE.Vector3());
    this.height = headPos.y - rootPos.y + 0.18;
    this.tipOffsets = this.measureFingerTips();
    this.width = this.height * 0.34;
    this.hipsBaseY = this.bone('hips').position.y;
    this.headRestQ = this.rootRelativeQuaternion(this.bone('head'));
    this.lipLocal = this.measureLips();
    this.footRest = {};
    for (const prefix of ['left', 'right']) {
      const foot = this.bone(`${prefix}Foot`);
      if (foot) this.footRest[prefix] = this.root.worldToLocal(foot.getWorldPosition(new THREE.Vector3()));
      const upperLeg = this.bone(`${prefix}UpperLeg`);
      const toes = this.bone(`${prefix}Toes`);
      if (toes) this.toesRest = { ...this.toesRest, [prefix]: this.root.worldToLocal(toes.getWorldPosition(new THREE.Vector3())) };
      if (upperLeg) this.hipRest = { ...this.hipRest, [prefix]: this.root.worldToLocal(upperLeg.getWorldPosition(new THREE.Vector3())) };
    }
    return vrm;
  }

  dispose() {
    if (!this.vrm) return;
    this.poseTracks = null;
    if (this.state === 'pose') this.setState('idle');
    this.root.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }

  // Fingertip offsets in the normalized distal bones' frames, taken from the skin vertices each distal bone
  // drives most, so contact poses use the model's real nail tips instead of a guess from joint spacing.
  measureFingerTips() {
    const names = ['leftIndexDistal', 'rightIndexDistal', 'leftThumbDistal', 'rightThumbDistal'];
    const tips = {};
    const best = {};
    const raw = new Map();
    for (const n of names) {
      const r = this.vrm.humanoid.getRawBoneNode(n);
      if (r && this.bone(n)) raw.set(r, n);
    }
    const v = new THREE.Vector3();
    this.vrm.scene.traverse((mesh) => {
      if (!mesh.isSkinnedMesh || !mesh.geometry?.attributes?.skinIndex) return;
      const { skinIndex, skinWeight } = mesh.geometry.attributes;
      const slot = new Map();
      mesh.skeleton.bones.forEach((b, j) => raw.has(b) && slot.set(j, raw.get(b)));
      if (!slot.size) return;
      for (let i = 0; i < skinIndex.count; i++) {
        for (let k = 0; k < 4; k++) {
          const n = slot.get(skinIndex.getComponent(i, k));
          if (!n || skinWeight.getComponent(i, k) < 0.5) continue;
          mesh.getVertexPosition(i, v);
          const local = this.bone(n).worldToLocal(mesh.localToWorld(v.clone()));
          const d = local.length();
          if (!(d <= (best[n] ?? 0))) {
            best[n] = d;
            tips[n] = local;
          }
        }
      }
    });
    return tips;
  }

  bone(name) {
    return this.vrm?.humanoid?.getNormalizedBoneNode(name) ?? null;
  }

  setBone(name, x = 0, y = 0, z = 0) {
    const b = this.bone(name);
    if (b) b.rotation.set(this.sign * x, y, this.sign * z);
  }

  addBone(name, x = 0, y = 0, z = 0) {
    const b = this.bone(name);
    if (!b) return;
    b.rotation.x += this.sign * x;
    b.rotation.y += y;
    b.rotation.z += this.sign * z;
  }

  get position() {
    return this.root.position;
  }

  get isBusy() {
    return this.state === 'held' || this.state === 'fall' || this.state === 'land';
  }

  get isActing() {
    return this.state === 'kiss' || this.state === 'spin' || this.state === 'pet' || this.state === 'pose' || this.state === 'clock';
  }

  setState(state) {
    this.state = state;
    this.stateTime = 0;
    this.actionRolled = false;
  }

  perform(action) {
    if (!this.vrm || this.isBusy || this.isActing) return;
    if (typeof action === 'string' && action.startsWith('pose')) {
      this.performPose(action.split(':')[1]);
      return;
    }
    if (typeof action === 'string' && action.startsWith('clock')) {
      const opts = action.split(':').slice(1);
      const want = opts.find((x) => CLOCK_STYLES.includes(x));
      const others = CLOCK_STYLES.filter((x) => x !== this.clockStyle);
      this.clockStyle = want ?? others[Math.floor(Math.random() * others.length)];
      const showMessage = opts.includes('message') || (!opts.includes('time') && Math.random() < BOARD_MESSAGE_CHANCE);
      const messages = BOARD_MESSAGES.filter((m) => m !== this.board.message);
      this.board.setMessage(showMessage ? messages[Math.floor(Math.random() * messages.length)] : null);
      this.clockSide = Math.random() < 0.5 ? 1 : -1;
      action = 'clock';
    }
    if (!['kiss', 'spin', 'pet', 'clock'].includes(action)) return;
    this.spinBase = this.root.rotation.y;
    this.lastActionTime = this.time;
    this.kissFx = { star: false, heart: false };
    this.petFx = false;
    this.petLean = 0;
    this.petCatDist = 1;
    if (action === 'pet') {
      const shoulder = this.bone('rightUpperArm')?.getWorldPosition(new THREE.Vector3());
      this.petSide = shoulder ? Math.sign(shoulder.x - this.root.position.x) || -1 : -1;
      if (this.root.position.x + this.petSide * 1.2 * (this.height / 1.6) < 0) this.petSide = 1;
    }
    this.setState(action);
  }

  async performPose(id) {
    if (this.posePending || !this.loadMotion) return;
    const motion = MOTIONS.find((m) => m.id === id) ?? MOTIONS[Math.floor(Math.random() * MOTIONS.length)];
    const vrm = this.vrm;
    this.posePending = true;
    try {
      let clip = this.poseClips.get(motion.id);
      if (!clip) {
        const buf = await this.loadMotion(motion.id);
        if (vrm !== this.vrm) return;
        if (motion.source === 'vrma') {
          const gltf = await new GLTFLoader().register((parser) => new VRMAnimationLoaderPlugin(parser)).parseAsync(buf, '');
          clip = createVRMAnimationClip(gltf.userData.vrmAnimations[0], vrm);
        } else {
          clip = loadMixamoClip(vrm, buf, this.hipsBaseY);
        }
        this.poseClips.set(motion.id, clip);
      }
      if (vrm !== this.vrm || this.isBusy || this.isActing) return;
      this.poseDuration = clip.duration;
      const animated = motion.source === 'vrma';
      this.poseHold = animated ? clip.duration : POSE_TIME;
      this.poseBlend = animated ? 0.3 : POSE_BLEND;
      this.poseLoop = !animated;
      this.poseExprTracks = clip.tracks
        .filter((track) => track instanceof THREE.NumberKeyframeTrack && track.name.endsWith('.weight'))
        .map((track) => ({ name: vrm.scene.getObjectByName(track.name.slice(0, -'.weight'.length))?.expressionName, interpolant: track.createInterpolant() }))
        .filter((t) => t.name);
      this.poseTracks = clip.tracks.filter((track) => track instanceof THREE.QuaternionKeyframeTrack || track instanceof THREE.VectorKeyframeTrack).map((track) => ({
        node: vrm.scene.getObjectByName(track.name.split('.')[0]),
        isRotation: track instanceof THREE.QuaternionKeyframeTrack,
        interpolant: track.createInterpolant(),
      })).filter((t) => t.node);
      Object.assign(this, motion.category === POSE_LYING_CATEGORY
        ? { poseTurn: Math.PI / 2, ...this.measureLyingPose() }
        : { poseTurn: motion.category === POSE_SITTING_CATEGORY ? Math.PI / 4 : 0, poseHeadDir: 0, poseFaceX: 0 });
      this.poseMotion = motion;
      this.poseContactSide = null;
      this.lastActionTime = this.time;
      this.setState('pose');
    } catch (err) {
      console.warn('pose failed', motion.id, err);
    } finally {
      this.posePending = false;
    }
  }

  // From the clip's first frame: which way (local z) the head lies from the hips, and how much the face points along local x.
  measureLyingPose() {
    const saved = this.poseTracks.map(({ node }) => [node.quaternion.clone(), node.position.clone()]);
    for (const { node, isRotation, interpolant } of this.poseTracks) {
      const value = interpolant.evaluate(0);
      if (isRotation) node.quaternion.fromArray(value);
      else node.position.fromArray(value);
    }
    this.root.updateMatrixWorld(true);
    const local = (name) => this.root.worldToLocal(this.bone(name).getWorldPosition(new THREE.Vector3()));
    const head = local('head');
    const poseHeadDir = Math.sign(head.z - local('hips').z) || 1;
    const leftEye = this.bone('leftEye');
    const rightEye = this.bone('rightEye');
    const face = leftEye && rightEye ? local('leftEye').add(local('rightEye')).multiplyScalar(0.5).sub(head) : new THREE.Vector3();
    const poseFaceX = face.lengthSq() > 0 ? face.x / face.length() : 0;
    this.poseTracks.forEach(({ node }, i) => {
      node.quaternion.copy(saved[i][0]);
      node.position.copy(saved[i][1]);
    });
    return { poseHeadDir, poseFaceX };
  }

  rootRelativeQuaternion(bone) {
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    return rootQ.multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
  }

  // Lip centre in head space, from the vertices the 'aa' (mouth open) expression moves most.
  measureLips() {
    const head = this.bone('head');
    const binds = this.vrm.expressionManager?.getExpression('aa')?.binds ?? [];
    this.root.updateMatrixWorld(true);
    const points = [];
    for (const bind of binds) {
      for (const mesh of bind.primitives ?? []) {
        const morph = mesh.geometry?.morphAttributes?.position?.[bind.index];
        if (!morph || !mesh.getVertexPosition) continue;
        const moves = [];
        for (let i = 0; i < morph.count; i++) {
          const d = Math.hypot(morph.getX(i), morph.getY(i), morph.getZ(i));
          if (d > 0) moves.push([d, i]);
        }
        const max = Math.max(0, ...moves.map((m) => m[0]));
        for (const [d, i] of moves) {
          if (d < 0.5 * max) continue;
          const v = mesh.getVertexPosition(i, new THREE.Vector3());
          points.push(this.root.worldToLocal(mesh.localToWorld(v)));
        }
      }
    }
    if (!head || points.length < 3) return null;
    const lips = points.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
    lips.z = Math.max(...points.map((p) => p.z)) + 0.005 * (this.height / 1.6);
    return head.worldToLocal(this.root.localToWorld(lips));
  }

  // Lips in root space, following the head's current rotation.
  mouthPoint(lift = 0) {
    const toRoot = (o) => this.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const scale = this.height / 1.6;
    const head = this.bone('head');
    if (this.lipLocal) {
      const lips = this.lipLocal.clone();
      lips.y += lift;
      return this.root.worldToLocal(head.localToWorld(lips));
    }
    const le = this.bone('leftEye');
    const re = this.bone('rightEye');
    const turn = this.rootRelativeQuaternion(head).multiply(this.headRestQ.clone().invert());
    return le && re
      ? toRoot(le).add(toRoot(re)).multiplyScalar(0.5).add(new THREE.Vector3(0, lift - 0.05 * scale, 0.04 * scale).applyQuaternion(turn))
      : toRoot(head).add(new THREE.Vector3(0, 0.02 * scale, 0.1 * scale).applyQuaternion(turn));
  }

  // Two-hand heart built procedurally in the chest frame: each hand is a "C" with the palm turned in toward the
  // other hand, fingers curled over into the top lobes (index tips meeting in the dip) and the thumb pointing down
  // to the bottom point. The hand is rolled in the frontal plane so its index and thumb tips line up vertically,
  // then the wrist is placed so both tips sit on the midline, and the arm is solved with the elbow tucked in.
  applyHandHeart(w, toRoot, fingertip) {
    const chest = this.bone('upperChest') ?? this.bone('chest') ?? this.bone('spine');
    const rf = {
      left: this.bone('leftMiddleProximal')?.position.clone().normalize(),
      right: this.bone('rightMiddleProximal')?.position.clone().normalize()
    };
    if (!chest || !rf.left || !rf.right) return;
    const thumbTip = (prefix) => {
      const distal = this.bone(`${prefix}ThumbDistal`);
      const prox = this.bone(`${prefix}ThumbProximal`);
      if (!distal || !prox) return null;
      const tip = this.tipOffsets?.[`${prefix}ThumbDistal`];
      if (tip) return distal.localToWorld(tip.clone());
      const d = distal.getWorldPosition(new THREE.Vector3());
      return d.clone().addScaledVector(d.clone().sub(prox.getWorldPosition(new THREE.Vector3())), 0.9);
    };
    const tipWorld = (prefix) => {
      const t = fingertip(prefix);
      return t && this.root.localToWorld(t);
    };
    const I0 = { left: tipWorld('left'), right: tipWorld('right') };
    if (!I0.left || !I0.right) return;

    const chestQ = chest.getWorldQuaternion(new THREE.Quaternion());
    const L = rf.left;
    const U = new THREE.Vector3(0, 1, 0);
    const Fw = L.clone().cross(U).normalize();
    const half = 0.002 * (this.height / 1.6);
    const center = I0.left.clone().add(I0.right).multiplyScalar(0.5)
      .addScaledVector(Fw.clone().applyQuaternion(chestQ), 0.03 * (this.height / 1.6));
    const neck = this.bone('neck');
    if (neck) {
      const upW = U.clone().applyQuaternion(chestQ);
      const anchor = chest.getWorldPosition(new THREE.Vector3()).lerp(neck.getWorldPosition(new THREE.Vector3()), 0.5);
      center.addScaledVector(upW, anchor.sub(center).dot(upW));
    }
    const basis = (x, y) => new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y))
    );

    for (const [prefix, s] of [['left', 1], ['right', -1]]) {
      const upper = this.bone(`${prefix}UpperArm`);
      const lower = this.bone(`${prefix}LowerArm`);
      const hand = this.bone(`${prefix}Hand`);
      if (!upper || !lower || !hand) continue;
      const out = L.clone().multiplyScalar(s);
      // hand tilted ~35° inward, back of the hand to the viewer, palm facing the heart's hole
      const F = U.clone().addScaledVector(out, -0.7).normalize();
      const N = out.clone().negate().addScaledVector(U, -0.7).addScaledVector(Fw, -0.35);
      N.addScaledVector(F, -N.dot(F)).normalize();
      const B = N.clone().negate();
      const local = basis(F, B).multiply(basis(rf[prefix], U).invert());
      const goalQ = chestQ.clone().multiply(local);
      const handQ = hand.getWorldQuaternion(new THREE.Quaternion()).slerp(goalQ, w);

      const curlAxis = rf[prefix].clone().cross(U.clone().negate()).normalize();
      HEART_CURLS.forEach(([finger, angles, spread]) => {
        ['Proximal', 'Intermediate', 'Distal'].forEach((seg, i) => {
          const b = this.bone(`${prefix}${finger}${seg}`);
          const q = new THREE.Quaternion().setFromAxisAngle(curlAxis, angles[i]);
          if (i === 0) q.premultiply(new THREE.Quaternion().setFromAxisAngle(U, -s * spread));
          if (b) b.quaternion.slerp(q, w);
        });
      });
      const setHandWorld = (q) => {
        hand.quaternion.copy(hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));
        hand.updateMatrixWorld(true);
      };
      setHandWorld(handQ);
      const wrist = hand.getWorldPosition(new THREE.Vector3());
      const index = tipWorld(prefix);
      if (!index) continue;
      const outW = out.clone().applyQuaternion(chestQ);
      const fwdW = Fw.clone().applyQuaternion(chestQ);
      const downW = U.clone().negate().applyQuaternion(chestQ);
      const wristGoal = center.clone().addScaledVector(outW, half).sub(index.sub(wrist)).lerp(wrist, 1 - w);
      const wristRoot = this.root.worldToLocal(wristGoal.clone());
      const shoulder = toRoot(upper);
      const pole = toRoot(lower).sub(shoulder.add(toRoot(hand)).multiplyScalar(0.5)).normalize();
      pole.lerp(new THREE.Vector3(s * 0.2, -1, -0.35).normalize(), w);
      this.solveLimb(`${prefix}UpperArm`, `${prefix}LowerArm`, `${prefix}Hand`, wristRoot, pole, 1);
      setHandWorld(handQ);

      // swing the thumb (split over its two base joints) so its tip just reaches the midline
      const meta = this.bone(`${prefix}ThumbMetacarpal`);
      const prox = this.bone(`${prefix}ThumbProximal`);
      if (!meta || !prox) continue;
      const flex = prox.position.clone().normalize().cross(U.clone().negate()).normalize();
      prox.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(flex, 0.15), w);
      this.bone(`${prefix}ThumbDistal`)?.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(flex, 0.2), w);
      prox.updateMatrixWorld(true);
      const tip0 = thumbTip(prefix);
      if (!tip0) continue;
      const base = meta.getWorldPosition(new THREE.Vector3());
      const len = tip0.distanceTo(base);
      const lat = Math.max(0, base.clone().sub(center).dot(outW) - half);
      const fwd = center.clone().sub(base).dot(fwdW);
      const drop = Math.sqrt(Math.max(0, len * len - lat * lat - fwd * fwd));
      // keep the thumb nearly horizontal; spend extra length toward the viewer instead of downward
      const down = Math.min(drop, 0.6 * lat);
      const ahead = Math.sqrt(fwd * fwd + drop * drop - down * down);
      const goal = base.clone().addScaledVector(outW, -lat).addScaledVector(fwdW, ahead).addScaledVector(downW, down);
      for (const [b, k] of [[meta, 0.5], [prox, 1]]) {
        const p = b.getWorldPosition(new THREE.Vector3());
        const q = new THREE.Quaternion().setFromUnitVectors(
          thumbTip(prefix).sub(p).normalize(), goal.clone().sub(p).normalize()
        ).slerp(new THREE.Quaternion(), 1 - k * w);
        b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
          .multiply(q).multiply(b.getWorldQuaternion(new THREE.Quaternion())));
        b.updateMatrixWorld(true);
      }
    }
  }

  // Retargeted clips miss contacts on other body proportions: pull the nearer index fingertip onto the lips,
  // or (hand hearts) meet both index and thumb tips at the midline with elbows tucked, with arm IK.
  applyPoseContact() {
    const w = this.poseWeight ?? 0;
    const contact = this.poseMotion?.contact;
    if ((contact !== 'mouth' && contact !== 'hands') || w <= 0) return;
    // Remember the pre-IK arm pose so next frame starts from it even for bones the clip does not key.
    this.contactSaved = [];
    for (const side of ['left', 'right']) {
      for (const part of ['UpperArm', 'LowerArm', 'Hand', ...HEART_FINGER_BONES]) {
        const b = this.bone(`${side}${part}`);
        if (b) this.contactSaved.push([b, b.quaternion.clone()]);
      }
    }
    const toRoot = (o) => this.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const fingertip = (prefix) => {
      const distal = this.bone(`${prefix}IndexDistal`);
      const tip = this.tipOffsets?.[`${prefix}IndexDistal`];
      if (distal && tip) return toRoot({ getWorldPosition: (out) => out.copy(distal.localToWorld(tip.clone())) });
      const mid = this.bone(`${prefix}IndexIntermediate`);
      if (!distal || !mid) return null;
      const d = toRoot(distal);
      return d.clone().addScaledVector(d.clone().sub(toRoot(mid)), 0.9);
    };
    const reach = (prefix, goal, tuck) => {
      const upper = this.bone(`${prefix}UpperArm`);
      const lower = this.bone(`${prefix}LowerArm`);
      const hand = this.bone(`${prefix}Hand`);
      if (!upper || !lower || !hand) return;
      const shoulder = toRoot(upper);
      const pole = toRoot(lower).sub(shoulder.add(toRoot(hand)).multiplyScalar(0.5)).normalize();
      if (tuck) pole.lerp(tuck.clone().normalize(), w);
      for (let i = 0; i < 3; i++) {
        const offset = goal.clone().sub(fingertip(prefix));
        this.solveLimb(`${prefix}UpperArm`, `${prefix}LowerArm`, `${prefix}Hand`, toRoot(hand).add(offset), pole, 1);
        this.root.updateMatrixWorld(true);
      }
    };
    this.root.updateMatrixWorld(true);
    if (contact === 'hands') {
      this.applyHandHeart(w, toRoot, fingertip);
      return;
    }
    const mouth = this.mouthPoint(0.008 * (this.height / 1.6));
    if (!this.poseContactSide) {
      const dist = (p) => fingertip(p)?.distanceTo(mouth) ?? Infinity;
      this.poseContactSide = dist('left') < dist('right') ? 'left' : 'right';
    }
    const tip = fingertip(this.poseContactSide);
    if (tip) reach(this.poseContactSide, tip.lerp(mouth, w));
  }

  // Blend the procedural pose toward the clip, then shift the hips so the lowest body part rests on the ground.
  applyPoseClip() {
    const u = this.stateTime;
    const w = smoothstep(0, this.poseBlend, u) * (1 - smoothstep(this.poseHold - this.poseBlend, this.poseHold, u));
    this.poseWeight = w;
    const time = this.poseLoop ? u % this.poseDuration : Math.min(u, this.poseDuration);
    this.poseTime = time;
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    for (const { node, isRotation, interpolant } of this.poseTracks) {
      const value = interpolant.evaluate(time);
      if (isRotation) node.quaternion.slerp(q.fromArray(value), w);
      else node.position.lerp(v.fromArray(value), w);
    }
    if (!this.poseLoop) return;
    const hips = this.bone('hips');

    const scale = this.height / 1.6;
    this.root.updateMatrixWorld(true);
    const contacts = [
      ['leftFoot', this.footRest?.left?.y], ['rightFoot', this.footRest?.right?.y],
      ['leftToes', this.toesRest?.left?.y], ['rightToes', this.toesRest?.right?.y],
      ['leftLowerLeg', 0.05 * scale], ['rightLowerLeg', 0.05 * scale],
      ['hips', 0.1 * scale], ['chest', 0.1 * scale], ['head', 0.1 * scale],
      ['leftHand', 0.03 * scale], ['rightHand', 0.03 * scale],
    ];
    let lowest = Infinity;
    for (const [name, clearance] of contacts) {
      const b = this.bone(name);
      if (!b || clearance == null) continue;
      lowest = Math.min(lowest, this.root.worldToLocal(b.getWorldPosition(new THREE.Vector3())).y - clearance);
    }
    if (Number.isFinite(lowest)) hips.position.y -= lowest * w;
  }

  finishAction() {
    this.poseTracks = null;
    this.root.position.y = 0;
    this.setState('idle');
    this.idleDuration = rand(1.5, 4);
  }

  grab(worldPoint) {
    this.holdOffset.set(this.root.position.x - worldPoint.x, this.root.position.y - worldPoint.y);
    this.setState('held');
  }

  drag(worldPoint) {
    if (this.state !== 'held') return;
    this.root.position.x = worldPoint.x + this.holdOffset.x;
    this.root.position.y = Math.max(0, worldPoint.y + this.holdOffset.y);
  }

  release() {
    if (this.state !== 'held') return;
    this.velocityY = 0;
    this.setState(this.root.position.y > 0.001 ? 'fall' : 'land');
  }

  poke() {
    if (this.isBusy) return;
    this.expr.surprised = 1;
    this.setState('idle');
    this.idleDuration = rand(2, 4);
  }

  /**
   * ctx: { worldWidth, wander, watched, target: Vector3|null, headRoll: number|null }
   */
  update(dt, ctx) {
    if (!this.vrm) return;
    this.time += dt;
    this.stateTime += dt;
    const margin = this.width;
    const minX = margin;
    const maxX = Math.max(minX, ctx.worldWidth - margin);

    if (!this.isBusy && !this.isActing && ctx.watched && this.state !== 'watched') {
      this.setState('watched');
      this.watchedTime = 0;
    }

    let desiredFacing = 0;
    let moving = false;

    switch (this.state) {
      case 'idle':
        if (this.stateTime > this.idleDuration && !this.actionRolled) {
          this.actionRolled = true;
          if (Math.random() < IDLE_ACTION_CHANCE) {
            const actions = ['kiss', 'spin', 'pet', 'pose', 'pose'];
            this.perform(actions[Math.floor(Math.random() * actions.length)]);
            break;
          }
        }
        if (ctx.wander && this.stateTime > this.idleDuration) {
          const span = maxX - minX;
          let x = rand(minX, maxX);
          if (Math.abs(x - this.root.position.x) < span * 0.15) x = minX + ((x - minX + span / 2) % span);
          this.walkTargetX = x;
          this.setState('walk');
        }
        break;
      case 'walk': {
        const dx = this.walkTargetX - this.root.position.x;
        desiredFacing = Math.sign(dx) * (Math.PI / 2);
        if (!ctx.wander || Math.abs(dx) < 0.02) {
          this.setState('idle');
          this.idleDuration = rand(3, 9);
          break;
        }
        const facingErr = Math.abs(Math.atan2(Math.sin(desiredFacing - this.root.rotation.y), Math.cos(desiredFacing - this.root.rotation.y)));
        if (facingErr < 0.35) {
          const step = Math.min(Math.abs(dx), WALK_SPEED * dt);
          this.root.position.x += Math.sign(dx) * step;
          moving = true;
        }
        break;
      }
      case 'watched':
        if (!ctx.watched && this.stateTime > 1.5) {
          this.setState('idle');
          this.idleDuration = rand(1.5, 4);
        } else if (ctx.watched) {
          this.stateTime = 0;
          this.watchedTime += dt;
          if (this.watchedTime > WATCHED_ACTION_DELAY && this.time - this.lastActionTime > WATCHED_ACTION_COOLDOWN) {
            this.lastActionTime = this.time;
            if (Math.random() < 0.6) this.perform(Math.random() < 0.7 ? 'kiss' : 'spin');
          }
        }
        break;
      case 'kiss':
        if (this.stateTime > KISS_TIME) this.finishAction();
        break;
      case 'clock':
        if (this.stateTime > CLOCK_TIME) this.finishAction();
        break;
      case 'pose':
        if (this.poseTurn) {
          const reach = 0.6 * this.height;
          const center = (minX + maxX) / 2;
          const toCenter = Math.sign(center - this.root.position.x) || 1;
          // Lying in profile, sitting at a slant. Side-lying: face the viewer; other lying: head toward the screen center; sitting: face the screen center.
          const side = Math.abs(this.poseFaceX) > 0.4 ? -Math.sign(this.poseFaceX) : (this.poseHeadDir || 1) * toCenter;
          desiredFacing = this.poseTurn * side;
          const fitted = THREE.MathUtils.clamp(this.root.position.x, Math.min(center, minX + reach), Math.max(center, maxX - reach));
          this.root.position.x = damp(this.root.position.x, fitted, 3, dt);
        }
        if (this.stateTime > this.poseHold) this.finishAction();
        break;
      case 'pet':
        if (this.stateTime > 0.6 && this.stateTime < 5.9) desiredFacing = this.petSide * Math.PI / 4;
        if (this.stateTime > PET_TIME) this.finishAction();
        break;
      case 'spin': {
        const u = Math.min(1, this.stateTime / SPIN_TIME);
        this.root.position.y = 0.08 * Math.sin(Math.PI * u);
        if (u >= 1) this.finishAction();
        break;
      }
      case 'held':
        break;
      case 'fall':
        this.velocityY -= GRAVITY * dt;
        this.root.position.y += this.velocityY * dt;
        if (this.root.position.y <= 0) {
          this.root.position.y = 0;
          this.setState('land');
        }
        break;
      case 'land':
        if (this.stateTime > 0.45) {
          this.setState('idle');
          this.idleDuration = rand(1, 3);
        }
        break;
    }

    if (this.state !== 'held' && this.state !== 'fall') {
      this.root.position.x = THREE.MathUtils.clamp(this.root.position.x, minX, maxX);
    }
    if (this.state === 'spin') {
      const u = Math.min(1, this.stateTime / SPIN_TIME);
      this.root.rotation.y = this.spinBase + 2 * Math.PI * smoothstep(0, 1, u);
    } else {
      this.root.rotation.y = dampAngle(this.root.rotation.y, desiredFacing, TURN_SPEED, dt);
    }
    this.walkBlend = damp(this.walkBlend, moving ? 1 : 0, 8, dt);
    if (moving) this.phase += ((2 * Math.PI * WALK_SPEED) / STRIDE) * dt;

    if (this.contactSaved) {
      for (const [b, q] of this.contactSaved) b.quaternion.copy(q);
      this.contactSaved = null;
    }
    this.applyPose(dt);
    this.closeLegs();
    if (this.state === 'pose') {
      this.applyPoseClip();
      if (!POSE_LOOK_CATEGORIES.has(this.poseMotion?.category)) ctx = { ...ctx, target: null, headRoll: null };
    }
    this.updateCat(dt);
    if (this.state === 'pet') {
      const u = this.stateTime;
      const watchingCat = u > 0.3 && u < 5.8;
      ctx = { ...ctx, target: watchingCat ? this.cat.headWorld : ctx.target, headRoll: watchingCat ? null : ctx.headRoll };
    }
    this.applyLook(dt, ctx);
    if (this.state === 'pose') this.applyPoseContact();
    if (this.state === 'pet') this.applyPetLimbs();
    this.applyClockBoard();
    if (this.state === 'kiss') {
      this.applyKissArm();
      this.spawnKissEffects();
    }
    this.effects.update(dt);
    this.applyExpressions(dt, ctx);
    this.vrm.update(dt);
  }

  applyPose(dt) {
    const t = this.time;
    const w = this.walkBlend;
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const breathe = Math.sin(t * 1.8) * 0.02;

    for (const name of ['spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftHand', 'rightHand', 'leftShoulder', 'rightShoulder']) {
      this.setBone(name);
    }

    const armDown = 1.22;
    const armSwing = 0.45 * w;
    this.setBone('leftUpperArm', s * armSwing, 0, -armDown + breathe * 0.5);
    this.setBone('rightUpperArm', -s * armSwing, 0, armDown - breathe * 0.5);
    this.setBone('leftLowerArm', 0, -0.25 - 0.2 * w, 0);
    this.setBone('rightLowerArm', 0, 0.25 + 0.2 * w, 0);

    const legSwing = 0.42 * w;
    this.setBone('leftUpperLeg', -s * legSwing);
    this.setBone('rightUpperLeg', s * legSwing);
    this.setBone('leftLowerLeg', (0.08 + Math.max(0, c) * 0.75) * w);
    this.setBone('rightLowerLeg', (0.08 + Math.max(0, -c) * 0.75) * w);
    this.setBone('leftFoot', Math.max(0, -s) * 0.25 * w);
    this.setBone('rightFoot', Math.max(0, s) * 0.25 * w);

    const hips = this.bone('hips');
    hips.rotation.set(0, 0.12 * s * w, 0);
    hips.position.y = this.hipsBaseY + 0.018 * Math.cos(2 * this.phase) * w;
    this.addBone('spine', breathe + 0.04 * w, -0.08 * s * w, 0);
    this.addBone('chest', breathe * 0.5);

    if (this.state === 'held') {
      const sway = Math.sin(t * 5);
      this.setBone('leftUpperLeg', 0.15 * sway);
      this.setBone('rightUpperLeg', -0.15 * sway);
      this.setBone('leftLowerLeg', 0.35 + 0.15 * sway);
      this.setBone('rightLowerLeg', 0.35 - 0.15 * sway);
      this.setBone('leftUpperArm', 0, 0, -0.5 + 0.1 * sway);
      this.setBone('rightUpperArm', 0, 0, 0.5 + 0.1 * sway);
    } else if (this.state === 'kiss') {
      const { raise, throw: thr } = this.kissWeights();
      this.addBone('head', 0, 0, -0.15 * raise);
      this.addBone('spine', 0.08 * thr * raise);
    } else if (this.state === 'pet') {
      const c = this.crouchWeight();
      hips.position.y = this.hipsBaseY - this.crouchDepth() * c;
      this.addBone('spine', (0.35 + this.petLean) * c);
      this.addBone('chest', 0.15 * c);
    } else if (this.state === 'clock') {
      const k = this.clockWeight();
      if (this.clockStyle === 'crouch') {
        hips.position.y = this.hipsBaseY - 0.9 * this.crouchDepth() * k;
        this.addBone('spine', 0.25 * k);
        this.addBone('chest', 0.1 * k);
      } else if (this.clockStyle === 'side') {
        this.addBone('spine', 0, 0, -0.08 * this.clockSide * k);
      } else {
        this.addBone('spine', -0.03 * k);
      }
      this.addBone('head', 0, 0, (this.clockStyle === 'side' ? 0.18 * this.clockSide : 0.12) * k);
    } else if (this.state === 'spin') {
      const k = Math.sin(Math.PI * Math.min(1, this.stateTime / SPIN_TIME));
      this.setBone('leftUpperArm', 0, 0, -armDown + 0.7 * k);
      this.setBone('rightUpperArm', 0, 0, armDown - 0.7 * k);
      this.addBone('head', 0, 0, 0.12 * k);
    } else if (this.state === 'land') {
      const k = Math.sin(Math.min(1, this.stateTime / 0.45) * Math.PI);
      hips.position.y = this.hipsBaseY - 0.12 * k;
      this.setBone('leftUpperLeg', -0.7 * k);
      this.setBone('rightUpperLeg', -0.7 * k);
      this.setBone('leftLowerLeg', 1.3 * k);
      this.setBone('rightLowerLeg', 1.3 * k);
      this.setBone('leftFoot', -0.6 * k);
      this.setBone('rightFoot', -0.6 * k);
      this.addBone('spine', 0.25 * k);
    }
  }

  clockWeight() {
    const u = this.stateTime;
    return this.state === 'clock' ? smoothstep(0, 0.8, u) * (1 - smoothstep(CLOCK_TIME - 0.8, CLOCK_TIME, u)) : 0;
  }

  // Hold the time board up (in front of the chest, overhead, beside the body or crouching), gripping its side edges with both hands.
  applyClockBoard() {
    const k = this.clockWeight();
    const chest = this.bone('upperChest') ?? this.bone('chest') ?? this.bone('spine');
    if (k <= 0 || !chest) {
      this.board.update({ opacity: 0 });
      return;
    }
    const scale = this.height / 1.6;
    const width = 0.4 * scale;
    this.root.updateMatrixWorld(true);
    const chestRoot = this.root.worldToLocal(chest.getWorldPosition(new THREE.Vector3()));
    const style = this.clockStyle ?? 'chest';
    const side = this.clockSide ?? 1;
    const lowered = new THREE.Vector3(0, chestRoot.y - 0.3 * scale, chestRoot.z + 0.18 * scale);
    const raised = new THREE.Vector3(0, chestRoot.y - 0.02 * scale, chestRoot.z + 0.24 * scale);
    let roll = 0;
    let pole = (s) => new THREE.Vector3(s * 0.7, -1, -0.3);
    if (style === 'overhead') {
      raised.set(0, this.height + 0.09 * scale, chestRoot.z + 0.06 * scale);
      pole = (s) => new THREE.Vector3(s, -0.2, 0.1);
    } else if (style === 'side') {
      raised.set(side * 0.26 * scale, chestRoot.y + 0.02 * scale, chestRoot.z + 0.2 * scale);
      roll = side * 0.14;
    } else if (style === 'crouch') {
      raised.set(0, chestRoot.y - 0.08 * scale, chestRoot.z + 0.26 * scale);
    }
    const center = lowered.lerp(raised, smoothstep(0, 1, k));
    center.y += 0.006 * scale * Math.sin(this.time * 1.8);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(style === 'overhead' ? 0.1 : -0.08, 0, roll * k));
    this.board.update({
      width,
      position: this.root.localToWorld(center.clone()),
      quaternion: this.root.getWorldQuaternion(new THREE.Quaternion()).multiply(tilt),
      opacity: smoothstep(0, 0.35, k),
    });
    if (style === 'crouch') this.plantClosedFeet();
    // Latch the hands onto the board early so they stay on its edges while it rises.
    const hold = smoothstep(0, 0.3, k);
    this.contactSaved = [];
    for (const [prefix, s] of [['left', 1], ['right', -1]]) {
      // Hands that wrap an edge from behind: the outer hand at the side, and both hands overhead.
      const far = style === 'overhead' || (style === 'side' && s === side);
      // Overhead, grip the lower part of the side edges so the forearms rise straight up to them.
      // Overhead the hand sits just behind the board, palm turned forward, so only the curled fingertips come round onto its face.
      const [gripY, gripZ] = style === 'overhead' ? [-0.08, -0.02] : [-0.03, -0.05];
      const grip = center.clone().add(new THREE.Vector3(s * (width / 2 + (style === 'overhead' ? 0.045 : far ? 0.055 : 0.035) * scale), gripY * scale, gripZ * scale).applyQuaternion(tilt));
      const curl = style === 'overhead' ? CLOCK_GRIP_OVERHEAD : far ? CLOCK_GRIP_FAR : CLOCK_GRIP;
      this.solveLimb(`${prefix}UpperArm`, `${prefix}LowerArm`, `${prefix}Hand`, grip, pole(s), hold);
      const hand = this.bone(`${prefix}Hand`);
      const middle = this.bone(`${prefix}MiddleProximal`);
      if (!hand || !middle) continue;
      // Overhead, the hand carries straight on from the raised forearm instead of bending forward at the wrist.
      const [fingers, palm] =
        style === 'overhead'
          ? [new THREE.Vector3(-s * 0.15, 1, 0.1), new THREE.Vector3(-s, 0, 0.6)]
          : [new THREE.Vector3(-s * 0.05, 0.1, 1), new THREE.Vector3(-s, 0, 0)];
      this.orientBone(hand, middle.position, fingers.applyQuaternion(tilt), palm.applyQuaternion(tilt), hold);
      const rf = middle.position.clone().normalize();
      const curlAxis = rf.clone().cross(new THREE.Vector3(0, -1, 0)).normalize();
      for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
        ['Proximal', 'Intermediate', 'Distal'].forEach((seg, i) => {
          const b = this.bone(`${prefix}${finger}${seg}`);
          if (!b) return;
          this.contactSaved.push([b, b.quaternion.clone()]);
          b.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(curlAxis, curl[i]), hold);
        });
      }
      // The outer hand's thumb goes behind the board, out of sight.
      const meta = far && this.bone(`${prefix}ThumbMetacarpal`);
      const prox = far && this.bone(`${prefix}ThumbProximal`);
      if (meta && prox) {
        this.contactSaved.push([meta, meta.quaternion.clone()]);
        meta.updateMatrixWorld(true);
        const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
        const cur = prox.getWorldPosition(new THREE.Vector3()).sub(meta.getWorldPosition(new THREE.Vector3())).normalize();
        const want = new THREE.Vector3(-s * 0.6, -0.1, -1).applyQuaternion(tilt).applyQuaternion(rootQ).normalize();
        const worldQ = new THREE.Quaternion().setFromUnitVectors(cur, want).multiply(meta.getWorldQuaternion(new THREE.Quaternion()));
        meta.quaternion.slerp(meta.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ), hold);
      }
    }
  }

  kissWeights() {
    const u = this.stateTime;
    return {
      raise: smoothstep(0, 0.45, u) * (1 - smoothstep(1.6, KISS_TIME, u)),
      throw: smoothstep(0.85, 1.1, u),
    };
  }

  applyKissArm() {
    const { raise, throw: thr } = this.kissWeights();
    if (raise <= 0) return;
    const upper = this.bone('rightUpperArm');
    const lower = this.bone('rightLowerArm');
    const hand = this.bone('rightHand');
    const head = this.bone('head');
    if (!upper || !lower || !hand || !head) return;
    this.root.updateMatrixWorld(true);
    const toRoot = (o) => this.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const shoulder = toRoot(upper);
    const l1 = lower.position.length();
    const l2 = hand.position.length();
    const side = Math.sign(shoulder.x) || -1;
    const scale = this.height / 1.6;

    const le = this.bone('leftEye');
    const re = this.bone('rightEye');
    const mouth = le && re
      ? toRoot(le).add(toRoot(re)).multiplyScalar(0.5).add(new THREE.Vector3(0, -0.075 * scale, 0.07 * scale))
      : toRoot(head).add(new THREE.Vector3(0, 0.02 * scale, 0.1 * scale));
    const fingersAtMouth = new THREE.Vector3(-side * 0.25, 1, 0.1).normalize();
    mouth.addScaledVector(fingersAtMouth, -0.095 * scale);
    const blown = mouth.clone().add(new THREE.Vector3(side * 0.12, -0.14, 0.4).multiplyScalar(scale));
    const target = mouth.lerp(blown, thr);
    const pole = new THREE.Vector3(side * 0.7, -1, lerp(0.3, -0.3, thr)).normalize();

    const toTarget = target.clone().sub(shoulder);
    const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const dir = toTarget.normalize();
    const a = (l1 * l1 + d * d - l2 * l2) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const bend = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const elbow = shoulder.clone().addScaledVector(dir, a).addScaledVector(bend, h);
    const wrist = shoulder.clone().addScaledVector(dir, d);

    this.aimBone(upper, lower.position, elbow.clone().sub(shoulder), raise);
    upper.updateMatrixWorld(true);
    this.aimBone(lower, hand.position, wrist.sub(elbow), raise);
    lower.updateMatrixWorld(true);

    // Fingers up with the palm on the lips, then fingers forward with the palm up.
    const fingers = fingersAtMouth.clone().lerp(new THREE.Vector3(side * 0.15, 0.3, 1), thr).normalize();
    const palm = new THREE.Vector3(0, 0, -1).lerp(new THREE.Vector3(0, 1, 0), thr);
    const middle = this.bone('rightMiddleProximal');
    this.orientBone(hand, middle ? middle.position : hand.position, fingers, palm, raise);
  }

  // Orient `bone` so its finger axis and palm normal (rest: restFingers, -Y) match the root-space vectors.
  orientBone(bone, restFingers, fingersRoot, palmRoot, weight) {
    const f0 = restFingers.clone().normalize();
    const n0 = new THREE.Vector3(0, -1, 0);
    n0.sub(f0.clone().multiplyScalar(n0.dot(f0))).normalize();
    const f1 = fingersRoot.clone().normalize();
    const n1 = palmRoot.clone().sub(f1.clone().multiplyScalar(palmRoot.dot(f1))).normalize();
    const basis = (f, n) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f, n, f.clone().cross(n)));
    const restQ = basis(f0, n0);
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const worldQ = rootQ.multiply(basis(f1, n1)).multiply(restQ.invert());
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.slerp(parentQ.invert().multiply(worldQ), weight);
  }

  // Tilt each leg inward around the root's forward axis so the feet stand together instead of hip-width apart.
  closeLegs() {
    if (!this.footRest || !this.hipRest) return;
    const scale = this.height / 1.6;
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ);
    for (const prefix of ['left', 'right']) {
      const foot = this.footRest[prefix];
      const hip = this.hipRest?.[prefix];
      const upper = this.bone(`${prefix}UpperLeg`);
      const footBone = this.bone(`${prefix}Foot`);
      if (!foot || !hip || !upper || !footBone) continue;
      const excess = Math.abs(foot.x) - STANCE_HALF_WIDTH * scale;
      if (excess <= 0) continue;
      const angle = -Math.sign(foot.x) * Math.atan2(excess, hip.y - foot.y);
      this.rotateBoneWorld(upper, forward, angle);
      this.rotateBoneWorld(footBone, forward, -angle);
    }
  }

  rotateBoneWorld(bone, axisWorld, angle) {
    bone.parent.updateWorldMatrix(true, false);
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const delta = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
    const worldQ = parentQ.clone().multiply(bone.quaternion);
    bone.quaternion.copy(parentQ.invert().multiply(delta.multiply(worldQ)));
  }

  crouchDepth() {
    const { left: hip } = this.hipRest ?? {};
    const { left: foot } = this.footRest ?? {};
    return hip && foot ? 0.55 * (hip.y - foot.y) : 0.4 * (this.height / 1.6);
  }

  crouchWeight() {
    const u = this.stateTime;
    return smoothstep(0.9, 1.8, u) * (1 - smoothstep(5.4, 6.3, u));
  }

  petWeights() {
    const u = this.stateTime;
    return { reach: smoothstep(1.6, 2.2, u) * (1 - smoothstep(5.0, 5.5, u)), stroke: Math.sin((u - 2.2) * 7) };
  }

  updateCat(dt) {
    const scale = this.height / 1.6;
    if (this.state !== 'pet') {
      this.cat.update(dt, { x: 0, z: 0, facing: 0, size: scale, walking: 0, happy: 0, opacity: 0 });
      return;
    }
    const u = this.stateTime;
    const side = this.petSide;
    const near = this.root.position.x + side * 0.3 * scale * this.petCatDist;
    const far = this.root.position.x + side * 1.4 * scale;
    const arrive = smoothstep(0, 1.6, u);
    const leave = smoothstep(6.2, 7.5, u);
    const x = lerp(far, near, arrive) + (far - near) * leave;
    const walking = (u < 1.6 ? 1 : 0) + (u > 6.2 ? 1 : 0);
    const facing = u < 1.6 ? -side * Math.PI / 2 : u > 6.2 ? side * Math.PI / 2 : -side * Math.PI * 0.3;
    const { reach } = this.petWeights();
    const opacity = Math.min(smoothstep(0, 0.4, u), 1 - smoothstep(7.0, 7.5, u));
    this.cat.update(dt, { x, z: 0.3 * scale * this.petCatDist, facing, size: scale, walking, happy: reach, opacity });
    if (!this.petFx && u > 3.2) {
      this.petFx = true;
      this.effects.heart(this.cat.headWorld.add(new THREE.Vector3(0, 0.08 * scale, 0)), side, scale * 0.5);
    }
  }

  // While the cat's head is out of arm's reach, bend forward a little (applied next frame), then let the cat come closer.
  leanToReach(target, weight) {
    const upper = this.bone('rightUpperArm');
    const lower = this.bone('rightLowerArm');
    const hand = this.bone('rightHand');
    if (!upper || !lower || !hand || weight < 0.5) return;
    const shoulder = this.root.worldToLocal(upper.getWorldPosition(new THREE.Vector3()));
    const armLength = lower.position.length() + hand.position.length();
    const excess = shoulder.distanceTo(target) - 0.95 * armLength;
    const maxLean = 0.3;
    this.petLean = THREE.MathUtils.clamp(this.petLean + excess * 0.4, 0, maxLean);
    if (this.petLean >= maxLean || excess < 0) {
      this.petCatDist = THREE.MathUtils.clamp(this.petCatDist - excess * 0.3, 0.5, 1);
    }
  }

  // Two-bone IK for a limb in root space.
  solveLimb(upperName, lowerName, endName, target, pole, weight) {
    const upper = this.bone(upperName);
    const lower = this.bone(lowerName);
    const end = this.bone(endName);
    if (!upper || !lower || !end) return;
    this.root.updateMatrixWorld(true);
    const start = this.root.worldToLocal(upper.getWorldPosition(new THREE.Vector3()));
    const l1 = lower.position.length();
    const l2 = end.position.length();
    const toTarget = target.clone().sub(start);
    const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const dir = toTarget.normalize();
    const a = (l1 * l1 + d * d - l2 * l2) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const p = pole.clone().normalize();
    const bend = p.sub(dir.clone().multiplyScalar(p.dot(dir))).normalize();
    const mid = start.clone().addScaledVector(dir, a).addScaledVector(bend, h);
    const tip = start.clone().addScaledVector(dir, d);
    this.aimBone(upper, lower.position, mid.clone().sub(start), weight);
    upper.updateMatrixWorld(true);
    this.aimBone(lower, end.position, tip.sub(mid), weight);
    lower.updateMatrixWorld(true);
  }

  // Keep the feet planted at the closed stance while the hips are lowered.
  plantClosedFeet() {
    const scale = this.height / 1.6;
    if (!this.footRest) return;
    for (const [prefix, out] of [['left', 1], ['right', -1]]) {
      const foot = this.bone(`${prefix}Foot`);
      if (!foot) continue;
      const rest = this.footRest[prefix];
      if (!rest) continue;
      const sideSign = Math.sign(rest.x) || out;
      const closed = new THREE.Vector3(sideSign * Math.min(Math.abs(rest.x), STANCE_HALF_WIDTH * scale), rest.y, rest.z);
      // Full IK weight: the hips are already lowered by `c`, so a partially blended leg would push the toes underground.
      this.solveLimb(`${prefix}UpperLeg`, `${prefix}LowerLeg`, `${prefix}Foot`, closed, new THREE.Vector3(-sideSign * 0.08, 0, 1), 1);
      const rigQ = this.bone('hips').parent.getWorldQuaternion(new THREE.Quaternion());
      const parentQ = foot.parent.getWorldQuaternion(new THREE.Quaternion());
      foot.quaternion.copy(parentQ.invert().multiply(rigQ));
    }
  }

  applyPetLimbs() {
    const c = this.crouchWeight();
    const scale = this.height / 1.6;
    if (!this.footRest) {
      this.footRest = {};
    }
    if (c > 0) this.plantClosedFeet();
    const { reach, stroke } = this.petWeights();
    if (reach > 0) {
      const side = this.petSide;
      const head = this.root.worldToLocal(this.cat.headWorld);
      const target = head.add(new THREE.Vector3(-side * 0.01, (0.075 + 0.025 * stroke) * scale, (-0.02 - 0.03 * stroke) * scale));
      this.leanToReach(target, reach);
      this.solveLimb('rightUpperArm', 'rightLowerArm', 'rightHand', target, new THREE.Vector3(side * 0.8, -0.3, -0.4), reach);
      const hand = this.bone('rightHand');
      const middle = this.bone('rightMiddleProximal');
      this.orientBone(hand, middle ? middle.position : hand.position, new THREE.Vector3(side * 0.3, -0.35, 1), new THREE.Vector3(0, -1, 0), reach);
    }
  }

  spawnKissEffects() {
    const u = this.stateTime;
    const scale = this.height / 1.6;
    const world = (name) => this.bone(name)?.getWorldPosition(new THREE.Vector3());
    if (!this.kissFx.star && u > 0.95) {
      this.kissFx.star = true;
      const head = world('head');
      const eye = world('leftEye') ?? head.clone().add(new THREE.Vector3(0.03, 0.06, 0).multiplyScalar(scale));
      this.effects.sparkle(eye, Math.sign(eye.x - head.x) || 1, scale);
    }
    if (!this.kissFx.heart && u > 1.05) {
      this.kissFx.heart = true;
      const hand = world('rightMiddleProximal') ?? world('rightHand');
      if (hand) this.effects.heart(hand, Math.sign(hand.x - this.root.position.x) || -1, scale);
    }
  }

  // Rotate `bone` so its child offset points along `dirRoot` (root space), blended by `weight`.
  aimBone(bone, childOffset, dirRoot, weight) {
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const dirParent = dirRoot.normalize().applyQuaternion(rootQ).applyQuaternion(parentQ.invert());
    const aim = new THREE.Quaternion().setFromUnitVectors(childOffset.clone().normalize(), dirParent);
    bone.quaternion.slerp(aim, weight);
  }

  applyLook(dt, ctx) {
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    const head = this.bone('head');
    if (ctx.target && this.state !== 'spin') {
      const headLocal = this.root.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
      const local = this.root.worldToLocal(ctx.target.clone()).sub(headLocal);
      yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -MAX_LOOK_YAW, MAX_LOOK_YAW);
      // The camera sits above the screen, so the true angle to the face points far upward; soften it.
      const rawPitch = Math.atan2(-local.y, Math.hypot(local.x, local.z));
      pitch = THREE.MathUtils.clamp(rawPitch * PITCH_SCALE, -MAX_LOOK_UP, MAX_LOOK_DOWN);
      const eyeDir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      this.lookTarget.position.copy(this.root.localToWorld(headLocal.addScaledVector(eyeDir, local.length())));
    } else {
      const fwd = new THREE.Vector3(0, this.height * 0.9, 3).applyMatrix4(this.root.matrixWorld);
      this.lookTarget.position.copy(fwd);
    }
    if (ctx.headRoll != null) roll = THREE.MathUtils.clamp(ctx.headRoll, -0.5, 0.5);
    if (this.state === 'held') pitch += 0.2;

    this.look.yaw = dampAngle(this.look.yaw, yaw, 6, dt);
    this.look.pitch = damp(this.look.pitch, pitch, 6, dt);
    this.look.roll = damp(this.look.roll, roll, 5, dt);

    for (const [name, share] of Object.entries(LOOK_SHARE)) {
      this.addBone(name, this.look.pitch * share, this.look.yaw * share, (name === 'head' || name === 'neck' ? 0.5 : 0) * this.look.roll);
    }
  }

  applyExpressions(dt, ctx) {
    const em = this.vrm.expressionManager;
    if (!em) return;

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTime = 0;
      this.blinkTimer = rand(2, 6);
    }
    let blink = 0;
    if (this.blinkTime >= 0) {
      this.blinkTime += dt;
      blink = Math.sin(Math.min(1, this.blinkTime / 0.16) * Math.PI);
      if (this.blinkTime > 0.16) this.blinkTime = -1;
    }

    const happyTarget = this.state === 'watched' ? 0.35 : this.state === 'pet' ? 0.6 * this.petWeights().reach : this.state === 'kiss' ? 0.3 * this.kissWeights().throw : this.state === 'spin' ? 0.35 : this.state === 'clock' ? 0.45 * this.clockWeight() : this.state === 'pose' ? 0.25 : 0;
    const surprisedTarget = this.state === 'held' || this.state === 'fall' ? 0.8 : 0;
    this.expr.happy = damp(this.expr.happy, happyTarget, 4, dt);
    this.expr.surprised = damp(this.expr.surprised, surprisedTarget, 3, dt);

    em.setValue('happy', this.expr.happy);
    em.setValue('surprised', this.expr.surprised);
    let kissMouth = 0;
    let wink = 0;
    if (this.state === 'kiss') {
      const { raise, throw: thr } = this.kissWeights();
      kissMouth = 0.8 * raise * (1 - thr);
      wink = thr * raise;
      blink = 0;
    }
    em.setValue('ou', kissMouth);
    em.setValue('blinkLeft', wink);
    em.setValue('blink', this.expr.surprised > 0.3 ? 0 : blink * (1 - this.expr.happy * 0.5));
    if (this.state === 'land') em.setValue('aa', Math.sin(Math.min(1, this.stateTime / 0.45) * Math.PI) * 0.6);
    else em.setValue('aa', 0);
    if (this.state === 'pose' && this.poseExprTracks?.length) {
      const w = this.poseWeight ?? 0;
      for (const { name, interpolant } of this.poseExprTracks) {
        em.setValue(name, THREE.MathUtils.lerp(em.getValue(name) ?? 0, interpolant.evaluate(this.poseTime ?? 0)[0], w));
      }
    }
  }

  screenRect(ppm, viewHeightPx) {
    const p = this.root.position;
    const w = this.width * ppm;
    const h = this.height * ppm;
    const left = p.x * ppm - w / 2;
    const bottom = viewHeightPx - p.y * ppm;
    return { left, top: bottom - h, right: left + w, bottom, cx: p.x * ppm, cy: bottom - h * 0.85 };
  }
}
