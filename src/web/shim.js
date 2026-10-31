// Browser implementation of the Electron `window.mate` bridge.
// Settings live in localStorage; the menu is a DOM overlay instead of a tray menu.

const DEFAULT_SETTINGS = {
  vrmPath: null,
  characterHeight: 300,
  cameraEnabled: true,
  lookMode: 'user',
  mimicHeadTilt: true,
  eyeCensor: false,
  wander: true,
  showPreview: false,
  pixelPitchMm: 0.2,
  cameraFovDeg: 65,
  gazeOffset: { x: 0, y: 0 },
  clockMode: 'hour',
  weatherDoodle: true,
};

const asset = (rel) => new URL(rel, location.href).href;

let settings;
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('mate-settings') || '{}') };
} catch {
  settings = { ...DEFAULT_SETTINGS };
}

const listeners = {};
const on = (ch) => (cb) => {
  (listeners[ch] ??= []).push(cb);
  return () => {};
};
const emit = (ch, data) => (listeners[ch] ?? []).forEach((cb) => cb(data));

let vrmFile = null;
let weather = null;

// --- Weather (same sources as the Electron main process) ---
async function locate() {
  for (const url of ['https://ipwho.is/', 'https://get.geojs.io/v1/ip/geo.json']) {
    try {
      const d = await (await fetch(url)).json();
      const lat = Number(d.latitude);
      const lon = Number(d.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    } catch {}
  }
  throw new Error('location unavailable');
}
function weatherKind(code) {
  if (code <= 1) return 'sun';
  if (code <= 48) return 'cloud';
  if (code >= 71 && code <= 77 || code === 85 || code === 86) return 'snow';
  return 'rain';
}
let weatherPlace = null;
async function refreshWeather() {
  if (!settings.weatherDoodle) return;
  try {
    weatherPlace ??= await locate();
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${weatherPlace.lat}&longitude=${weatherPlace.lon}&current=weather_code`);
    const code = (await res.json()).current?.weather_code;
    if (!Number.isFinite(code)) throw new Error('no code');
    weather = weatherKind(code);
    emit('weather', weather);
  } catch (e) {
    console.warn('weather unavailable:', e.message);
  }
}
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);

window.addEventListener('pointermove', (e) => emit('cursor', { x: e.clientX, y: e.clientY }));
window.addEventListener('resize', () => emit('bounds-changed', { width: innerWidth, height: innerHeight }));

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  localStorage.setItem('mate-settings', JSON.stringify(settings));
  emit('settings-changed', settings);
  rebuildMenu();
}

// --- Menu (DOM overlay) ---
const menuEl = document.getElementById('mate-menu');
const menuBtn = document.getElementById('mate-menu-btn');
function toggleMenu() {
  menuEl.classList.toggle('open');
}
menuBtn.addEventListener('click', toggleMenu);

const check = (label, key) =>
  `<label><input type="checkbox" data-k="${key}"${settings[key] ? ' checked' : ''}> ${label}</label>`;
const radio = (label, key, val) =>
  `<label><input type="radio" name="r-${key}" data-k="${key}" data-v="${val}"${settings[key] === val ? ' checked' : ''}> ${label}</label>`;

function rebuildMenu() {
  menuEl.innerHTML = [
    check('カメラで顔・視線を追従', 'cameraEnabled'),
    '<fieldset><legend>見る先</legend>',
    radio('あなたの顔', 'lookMode', 'user'),
    radio('あなたが見ている場所', 'lookMode', 'follow'),
    '</fieldset>',
    check('首の傾きをまねる', 'mimicHeadTilt'),
    check('目に目線を入れる', 'eyeCensor'),
    check('歩き回る', 'wander'),
    '<fieldset><legend>大きさ</legend>',
    radio('小', 'characterHeight', 200),
    radio('中', 'characterHeight', 300),
    radio('大', 'characterHeight', 420),
    radio('特大', 'characterHeight', 560),
    radio('特特大', 'characterHeight', 720),
    '</fieldset>',
    `<button class="act" data-cal>視線キャリブレーション</button>`,
    `<button class="act" data-reset-cal>キャリブレーションをリセット</button>`,
    check('カメラプレビューを表示', 'showPreview'),
    '<hr>',
    '<button class="act" data-a="kiss">投げキッス</button>',
    '<button class="act" data-a="spin">くるっと回る</button>',
    '<button class="act" data-a="pet">猫を撫でる</button>',
    '<button class="act" data-a="clock:time">今の時刻</button>',
    '<button class="act" data-a="clock:message">黒板メッセージ</button>',
    '<fieldset><legend>時刻を自動で見せる</legend>',
    radio('毎分', 'clockMode', 'minute'),
    radio('10分ごと', 'clockMode', 'tenMinutes'),
    radio('毎時ちょうど', 'clockMode', 'hour'),
    radio('オフ', 'clockMode', 'off'),
    '</fieldset>',
    check('黒板に天気の落書きを描く', 'weatherDoodle'),
    '<hr>',
    '<button class="act" data-vrm-open>VRMを開く…</button>',
    settings.vrmPath ? '<button class="act" data-vrm-reset>デフォルトのVRMに戻す</button>' : '',
  ].join('');
}

menuEl.addEventListener('change', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.dataset.v;
  updateSettings({ [k]: e.target.type === 'radio' ? (isNaN(+v) ? v : +v) : v });
});
menuEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.a) emit('perform-action', b.dataset.a);
  if (b.dataset.cal !== undefined) emit('calibrate-gaze');
  if (b.dataset.resetCal !== undefined) updateSettings({ gazeOffset: { x: 0, y: 0 } });
  if (b.dataset.vrmOpen !== undefined) {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = '.vrm';
    i.onchange = () => i.files[0] && setVrmFile(i.files[0]);
    i.click();
  }
  if (b.dataset.vrmReset !== undefined) setVrmFile(null);
});

function setVrmFile(file) {
  vrmFile = file;
  updateSettings({ vrmPath: file ? file.name : null });
}
rebuildMenu();

window.mate = {
  getSettings: async () => settings,
  getBounds: async () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }),
  updateSettings: async (patch) => updateSettings(patch),
  readVrm: async () => {
    if (vrmFile) return { name: vrmFile.name, data: await vrmFile.arrayBuffer() };
    const res = await fetch(asset('../../assets/models/default.vrm'));
    return { name: 'default.vrm', data: await res.arrayBuffer() };
  },
  loadMotion: async (id) => {
    const res = await fetch(asset(`../../assets/motions/${id}.vrma`));
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    return res.arrayBuffer();
  },
  setIgnoreMouse: () => {},
  showMenu: () => toggleMenu(),
  dropVrm: (file) => setVrmFile(file),
  onSettingsChanged: on('settings-changed'),
  onBoundsChanged: on('bounds-changed'),
  onCursor: on('cursor'),
  onCalibrateGaze: on('calibrate-gaze'),
  onPerformAction: on('perform-action'),
  getWeather: async () => weather,
  onWeather: on('weather'),
};
