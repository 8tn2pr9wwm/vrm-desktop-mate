import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const IPD_M = 0.063;
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;
const MAX_EYE_ANGLE = (28 * Math.PI) / 180;

const asset = (rel) => new URL(rel, import.meta.url).href;

/**
 * Estimates the user's head position and gaze in "screen space":
 * origin = webcam, +x = right side of the screen as the user sees it,
 * +y = up, +z = from the screen toward the user. Units: meters.
 */
export class FaceTracker {
  constructor({ fovDeg = 65 } = {}) {
    this.fovDeg = fovDeg;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.state = { present: false };
    this.lastLandmarks = null;
    this.smoothed = null;
  }

  async init() {
    if (this.landmarker) return;
    const fileset = await FilesetResolver.forVisionTasks(asset('../../node_modules/@mediapipe/tasks-vision/wasm'));
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: asset('../../assets/mediapipe/face_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
  }

  async start() {
    if (this.running) return;
    await this.init();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.state = { present: false };
    this.smoothed = null;
  }

  loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      try {
        this.process(this.landmarker.detectForVideo(v, performance.now()));
      } catch (err) {
        console.error(err);
      }
    }
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => this.loop());
    else setTimeout(() => this.loop(), 33);
  }

  process(result) {
    const lm = result.faceLandmarks?.[0];
    const mat = result.facialTransformationMatrixes?.[0]?.data;
    if (!lm || !mat) {
      this.lastLandmarks = null;
      this.state = { present: false };
      this.smoothed = null;
      return;
    }
    this.lastLandmarks = lm;
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const tanH = Math.tan(((this.fovDeg / 2) * Math.PI) / 180);
    const tanV = (tanH * vh) / vw;
    const focalPx = vw / 2 / tanH;

    // Column-major 4x4: forward (+z of canonical face) and up (+y) in camera space.
    // Camera space -> screen space: x -> -x, y -> y, z -> -z.
    const forward = normalize([-mat[8], mat[9], -mat[10]]);
    const up = normalize([-mat[4], mat[5], -mat[6]]);
    const yaw = Math.atan2(forward[0], -forward[2]);

    const l = lm[LEFT_IRIS] ?? lm[33];
    const r = lm[RIGHT_IRIS] ?? lm[263];
    const ipdPx = Math.hypot((l.x - r.x) * vw, (l.y - r.y) * vh);
    const distance = clamp((IPD_M * focalPx) / Math.max(ipdPx, 1) / Math.max(Math.cos(yaw), 0.5), 0.2, 2.5);

    const mid = lm[168];
    const head = [
      -(mid.x - 0.5) * 2 * distance * tanH,
      -(mid.y - 0.5) * 2 * distance * tanV,
      distance,
    ];

    const bs = {};
    for (const c of result.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
    const eyeX = ((bs.eyeLookInLeft ?? 0) + (bs.eyeLookOutRight ?? 0) - (bs.eyeLookOutLeft ?? 0) - (bs.eyeLookInRight ?? 0)) / 2;
    const eyeY = ((bs.eyeLookUpLeft ?? 0) + (bs.eyeLookUpRight ?? 0) - (bs.eyeLookDownLeft ?? 0) - (bs.eyeLookDownRight ?? 0)) / 2;

    const gazeDir = rotateDir(forward, eyeX * MAX_EYE_ANGLE, eyeY * MAX_EYE_ANGLE);
    const t = gazeDir[2] < -0.05 ? head[2] / -gazeDir[2] : null;
    const gaze = t == null ? null : [head[0] + gazeDir[0] * t, head[1] + gazeDir[1] * t];

    const raw = {
      head,
      roll: Math.atan2(-up[0], up[1]),
      yaw,
      pitch: Math.asin(clamp(forward[1], -1, 1)),
      gaze,
      blink: ((bs.eyeBlinkLeft ?? 0) + (bs.eyeBlinkRight ?? 0)) / 2,
      smile: ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2,
    };

    const s = this.smoothed;
    if (!s) {
      this.smoothed = raw;
    } else {
      const a = 0.35;
      s.head = lerpArr(s.head, raw.head, a);
      s.roll = lerp(s.roll, raw.roll, a);
      s.yaw = lerp(s.yaw, raw.yaw, a);
      s.pitch = lerp(s.pitch, raw.pitch, a);
      s.gaze = raw.gaze && s.gaze ? lerpArr(s.gaze, raw.gaze, 0.25) : raw.gaze;
      s.blink = raw.blink;
      s.smile = lerp(s.smile, raw.smile, a);
    }
    this.state = { present: true, ...this.smoothed };
  }

  drawPreview(canvas, gazePx, screenSize) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    if (this.video.readyState >= 2) ctx.drawImage(this.video, 0, 0, w, h);
    if (this.lastLandmarks) {
      ctx.fillStyle = '#4ef';
      for (const i of [33, 133, 263, 362, 1, 168, 152, LEFT_IRIS, RIGHT_IRIS]) {
        const p = this.lastLandmarks[i];
        if (p) ctx.fillRect(p.x * w - 2, p.y * h - 2, 4, 4);
      }
    }
    ctx.restore();
    if (gazePx && screenSize) {
      ctx.fillStyle = '#f48';
      ctx.beginPath();
      ctx.arc((gazePx.x / screenSize.w) * w, (gazePx.y / screenSize.h) * h, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function rotateDir(d, yawAdd, pitchAdd) {
  const yaw = Math.atan2(d[0], -d[2]) + yawAdd;
  const pitch = Math.asin(clamp(d[1], -1, 1)) + pitchAdd;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

function normalize(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpArr = (a, b, t) => a.map((x, i) => lerp(x, b[i], t));
