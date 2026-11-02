'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  net,
  nativeImage,
  ipcMain,
  screen,
  dialog,
  session,
  systemPreferences,
} = require('electron');

const DEBUG = process.argv.includes('--mate-debug');
const FAKE_CAMERA = process.env.MATE_FAKE_CAMERA;
if (FAKE_CAMERA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  if (FAKE_CAMERA !== '1') app.commandLine.appendSwitch('use-file-for-fake-video-capture', FAKE_CAMERA);
}
const MOTIONS = require('./motions.json');
const POSES = MOTIONS.filter((m) => m.source !== 'vrma');
const MOTION_BASE_URL = 'https://uemegu.github.io/AnimeVRM.Motions/motions/';
const DEFAULT_VRM = path.join(__dirname, '..', 'assets', 'models', 'default.vrm');

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
  clickThrough: true,
  vrmList: [],
  vrmRotate: false,
  alertEnabled: true,
  alertMinScale: 4,
};

let settings = { ...DEFAULT_SETTINGS };
let win = null;
let tray = null;
let trayMenu = null;
let handle = null;
let cursorTimer = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  if ('clickThrough' in patch) setIgnore(!patch.clickThrough);
  saveSettings();
  win?.webContents.send('settings-changed', settings);
  rebuildTrayMenu();
}

// Outside weather for the board doodle: approximate location from the IP address, current conditions from Open-Meteo (no API keys).
const WEATHER_REFRESH_MS = 30 * 60 * 1000;
let weather = process.env.MATE_WEATHER || null;
let weatherPlace = null;

// WMO weather codes: 0-1 clear, 2-3 cloudy, 45/48 fog, 71-77 and 85/86 snow; drizzle, rain, showers and thunder are rain.
function weatherKind(code) {
  if (code <= 1) return 'sun';
  if (code <= 48) return 'cloud';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

async function locate() {
  for (const url of ['https://ipwho.is/', 'https://get.geojs.io/v1/ip/geo.json']) {
    try {
      const data = await (await net.fetch(url)).json();
      const latitude = Number(data.latitude);
      const longitude = Number(data.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude };
    } catch {}
  }
  throw new Error('location unavailable');
}

async function refreshWeather() {
  if (process.env.MATE_WEATHER || !settings.weatherDoodle) return;
  try {
    weatherPlace ??= await locate();
    const { latitude, longitude } = weatherPlace;
    const res = await net.fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=weather_code`);
    const code = (await res.json()).current?.weather_code;
    if (!Number.isFinite(code)) throw new Error('no weather code');
    weather = weatherKind(code);
    win?.webContents.send('weather', weather);
  } catch (e) {
    console.warn('weather unavailable:', e.message);
  }
}

async function ensureCameraAccess() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  return systemPreferences.askForMediaAccess('camera');
}

function fitWindowToDisplay() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds(workArea);
  win.webContents.send('bounds-changed', win.getBounds());
}

// {forward:true} is only supported on macOS/Windows and makes the toggle unreliable on Linux.
// On Linux the overlay always stays click-through; a small follow-window ("handle") over the
// character receives pointer input instead and forwards it as IPC.
function setIgnore(ignore) {
  if (!win) return;
  if (process.platform === 'linux') {
    win.setIgnoreMouseEvents(true);
    // Re-apply after the window maps — the very first call can silently no-op on X11.
    for (const ms of [500, 2000]) {
      setTimeout(() => win && !win.isDestroyed() && win.setIgnoreMouseEvents(true), ms);
    }
  } else win.setIgnoreMouseEvents(ignore, { forward: true });
}

function createHandle() {
  handle = new BrowserWindow({
    width: 1,
    height: 1,
    x: -100,
    y: -100,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-handle.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  handle.setAlwaysOnTop(true, 'floating');
  handle.setSkipTaskbar(true);
  handle.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  handle.loadFile(path.join(__dirname, 'renderer', 'handle.html'));
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    ...workArea,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!DEBUG) setIgnore(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { ...(DEBUG ? { debug: '1' } : {}), ...(process.platform === 'linux' ? { linux: '1' } : {}) },
  });
  win.once('ready-to-show', () => win.showInactive());
  if (DEBUG) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
  }
  if (process.env.MATE_CAPTURE) {
    const [dir, intervalMs = '3000'] = process.env.MATE_CAPTURE.split(':');
    let n = 0;
    setInterval(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `capture-${String(n++).padStart(3, '0')}.png`), img.toPNG());
    }, Number(intervalMs));
  }

  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 33);

  win.on('closed', () => {
    clearInterval(cursorTimer);
    win = null;
  });
}

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAANUlEQVR42mNgGJbgy6cX/5ExTQylmuGjBtM+8miWtIjFowYPAoNJsYQqqQQXf9TgQWzwoAMAq5juKjB9fGUAAAAASUVORK5CYII=';

function trayDiag(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'tray-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

async function chooseVrmList() {
  win?.setAlwaysOnTop(false);
  app.focus({ steal: true });
  let result;
  try {
    result = await dialog.showOpenDialog({
      title: 'ローテーションするVRMを選択（複数可）',
      filters: [{ name: 'VRM', extensions: ['vrm'] }],
      properties: ['openFile', 'multiSelections'],
    });
  } finally {
    win?.setAlwaysOnTop(true, 'floating');
  }
  if (!result.canceled && result.filePaths.length) {
    updateSettings({ vrmList: result.filePaths });
    if (!settings.vrmPath && result.filePaths[0]) updateSettings({ vrmPath: result.filePaths[0] });
  }
}

/** Advance to the next VRM in the rotation list; force=true ignores the hourly-toggle setting. */
// --- Disaster alerts via P2PQuake public API (no key needed) ---
const ALERT_POLL_MS = 20000;
let alertCurrent = null;

const JMA_SCALE = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
const scaleText = (s) => JMA_SCALE[s] ?? `${s}`;

function pickAlert(list) {
  const now = Date.now();
  for (const e of list) {
    if (e.cancelled) continue;
    const t = Date.parse(e.time);
    if (e.code === 551 && now - t < 2 * 60 * 1000) {
      return {
        id: e.id,
        title: '緊急地震速報',
        detail: `${e.earthquake?.hypocenter?.name ?? ''} 推定震度${scaleText(e.earthquake?.maxScale)}`,
        until: t + 2 * 60 * 1000,
      };
    }
    if (e.code === 555 && now - t < 60 * 60 * 1000) {
      const grades = [...new Set((e.areas ?? []).map((a) => a.grade))].filter(Boolean);
      return {
        id: e.id,
        title: `津波${grades.find((g) => g.includes('警報')) ? '警報' : '情報'}`,
        detail: grades.join('・'),
        until: t + 60 * 60 * 1000,
      };
    }
    const scale = e.earthquake?.maxScale ?? 0;
    if (e.code === 552 && scale >= settings.alertMinScale * 10 && now - t < 30 * 60 * 1000) {
      return {
        id: e.id,
        title: `震度速報 震度${scaleText(scale)}`,
        detail: e.earthquake?.hypocenter?.name ?? '',
        until: t + 30 * 60 * 1000,
      };
    }
  }
  return null;
}

async function pollAlerts() {
  const clear = () => {
    if (alertCurrent) {
      alertCurrent = null;
      win?.webContents.send('alert', null);
    }
  };
  if (!settings.alertEnabled) return clear();
  try {
    const res = await net.fetch('https://api.p2pquake.net/v2/history?codes=551&codes=552&codes=555&limit=5');
    const next = pickAlert(await res.json());
    if (next?.id !== alertCurrent?.id || !!next !== !!alertCurrent) {
      alertCurrent = next;
      win?.webContents.send('alert', next);
    }
  } catch (e) {
    console.warn('alert poll failed:', e.message);
    if (alertCurrent && Date.now() > alertCurrent.until) clear();
  }
}

const USER_MOTION_DIR = () => path.join(app.getPath('userData'), 'motions-vrma');

/** .vrma files the user added — scanned fresh each time so files dropped into the folder just work. */
function userMotions() {
  try {
    return fs
      .readdirSync(USER_MOTION_DIR())
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .map((f) => ({ id: `user:${f}`, name: path.basename(f, path.extname(f)), category: 'ユーザー', source: 'user' }));
  } catch {
    return [];
  }
}

async function addUserVrma() {
  win?.setAlwaysOnTop(false);
  app.focus({ steal: true });
  let result;
  try {
    result = await dialog.showOpenDialog({
      title: 'VRMAモーションを追加（複数可）',
      filters: [{ name: 'VRMA', extensions: ['vrma'] }],
      properties: ['openFile', 'multiSelections'],
    });
  } finally {
    win?.setAlwaysOnTop(true, 'floating');
  }
  if (result.canceled || !result.filePaths.length) return;
  fs.mkdirSync(USER_MOTION_DIR(), { recursive: true });
  for (const src of result.filePaths) fs.copyFileSync(src, path.join(USER_MOTION_DIR(), path.basename(src)));
  rebuildTrayMenu();
}

function rotateVrm(force = false) {
  const list = settings.vrmList.filter((p) => fs.existsSync(p));
  if (list.length < 2 || (!settings.vrmRotate && !force)) return;
  const i = list.indexOf(settings.vrmPath);
  updateSettings({ vrmPath: list[(i + 1) % list.length] });
}

function trayIcon() {
  // Template images are a macOS menu-bar concept; other platforms need a visibly-colored icon for dark panels/taskbars.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const p = path.join(__dirname, '..', 'assets', file);
  let icon = nativeImage.createFromPath(p);
  if (icon.isEmpty()) {
    trayDiag(`tray icon unreadable: ${p} exists=${fs.existsSync(p)}; using embedded icon`);
    icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  }
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

async function chooseVrm() {
  // As a dock-less accessory app the dialog would open unfocused behind the full-screen overlay.
  win?.setAlwaysOnTop(false);
  app.focus({ steal: true });
  let result;
  try {
    result = await dialog.showOpenDialog({
      title: 'VRMファイルを選択',
      filters: [{ name: 'VRM', extensions: ['vrm'] }],
      properties: ['openFile'],
    });
  } finally {
    win?.setAlwaysOnTop(true, 'floating');
  }
  if (!result.canceled && result.filePaths[0]) updateSettings({ vrmPath: result.filePaths[0] });
}

function rebuildTrayMenu() {
  const sizes = [
    ['小', 200],
    ['中', 300],
    ['大', 420],
    ['特大', 560],
    ['特特大', 720],
  ];
  const menu = Menu.buildFromTemplate([
    {
      label: '設定',
      submenu: [
    {
      label: 'カメラで顔・視線を追従',
      type: 'checkbox',
      checked: settings.cameraEnabled,
      click: async (item) => {
        if (item.checked && !(await ensureCameraAccess())) {
          dialog.showMessageBox({
            type: 'warning',
            message: 'カメラへのアクセスが許可されていません',
            detail: 'システム設定 > プライバシーとセキュリティ > カメラ で許可してください。',
          });
          updateSettings({ cameraEnabled: false });
          return;
        }
        updateSettings({ cameraEnabled: item.checked });
      },
    },
    {
      label: '見る先',
      submenu: [
        {
          label: 'あなたの顔',
          type: 'radio',
          checked: settings.lookMode === 'user',
          click: () => updateSettings({ lookMode: 'user' }),
        },
        {
          label: 'あなたが見ている場所',
          type: 'radio',
          checked: settings.lookMode === 'follow',
          click: () => updateSettings({ lookMode: 'follow' }),
        },
      ],
    },
    {
      label: '首の傾きをまねる',
      type: 'checkbox',
      checked: settings.mimicHeadTilt,
      click: (item) => updateSettings({ mimicHeadTilt: item.checked }),
    },
    {
      label: '目に目線を入れる(プライバシー)',
      type: 'checkbox',
      checked: settings.eyeCensor,
      click: (item) => updateSettings({ eyeCensor: item.checked }),
    },
    {
      label: '歩き回る',
      type: 'checkbox',
      checked: settings.wander,
      click: (item) => updateSettings({ wander: item.checked }),
    },
    {
      label: 'キャラ以外をクリック透過',
      type: 'checkbox',
      checked: settings.clickThrough,
      click: (item) => updateSettings({ clickThrough: item.checked }),
    },
    {
      label: '大きさ',
      submenu: sizes.map(([label, h]) => ({
        label,
        type: 'radio',
        checked: settings.characterHeight === h,
        click: () => updateSettings({ characterHeight: h }),
      })),
    },
      ],
    },
    {
      label: 'アクション',
      submenu: [
    {
      label: '視線キャリブレーション（キャラを見つめながらクリック）',
      click: () => win?.webContents.send('calibrate-gaze'),
    },
    {
      label: 'キャリブレーションをリセット',
      click: () => updateSettings({ gazeOffset: { x: 0, y: 0 } }),
    },
    {
      label: '災害アラート(P2P地震情報)',
      type: 'checkbox',
      checked: settings.alertEnabled,
      click: (item) => updateSettings({ alertEnabled: item.checked }),
    },
    {
      label: 'アラート表示テスト',
      click: () =>
        win?.webContents.send('alert', {
          id: 'test',
          title: '緊急地震速報（テスト）',
          detail: 'これは表示テストです',
          until: Date.now() + 30000,
        }),
    },
    {
      label: 'カメラプレビューを表示',
      type: 'checkbox',
      checked: settings.showPreview,
      click: (item) => updateSettings({ showPreview: item.checked }),
    },
    { type: 'separator' },
    { label: '投げキッス', click: () => win?.webContents.send('perform-action', 'kiss') },
    { label: 'くるっと回る', click: () => win?.webContents.send('perform-action', 'spin') },
    { label: 'しゃがんで猫を撫でる', click: () => win?.webContents.send('perform-action', 'pet') },
    { label: '今の時刻を見せる', click: () => win?.webContents.send('perform-action', 'clock:time') },
    { label: '黒板でメッセージを見せる', click: () => win?.webContents.send('perform-action', 'clock:message') },
    {
      label: '時刻を自動で見せる',
      submenu: [
        ['毎分（美人時計）', 'minute'],
        ['10分ごと', 'tenMinutes'],
        ['毎時ちょうど', 'hour'],
        ['オフ', 'off'],
      ].map(([label, mode]) => ({
        label,
        type: 'radio',
        checked: settings.clockMode === mode,
        click: () => updateSettings({ clockMode: mode }),
      })),
    },
    {
      label: '黒板に天気の落書きを描く',
      type: 'checkbox',
      checked: settings.weatherDoodle,
      click: (item) => {
        updateSettings({ weatherDoodle: item.checked });
        refreshWeather();
      },
    },
    {
      label: 'ポーズ（AnimeVRM Motions）',
      submenu: [
        { label: 'おまかせ', click: () => win?.webContents.send('perform-action', 'pose') },
        { type: 'separator' },
        ...[...new Set(POSES.map((m) => m.category))].map((category) => ({
          label: category,
          submenu: POSES.filter((m) => m.category === category).map((m) => ({
            label: m.name,
            click: () => win?.webContents.send('perform-action', `pose:${m.id}`),
          })),
        })),
      ],
    },
    {
      label: 'モーション（Text-To-VRMA形式）',
      submenu: [
        ...MOTIONS.filter((m) => m.source === 'vrma').map((m) => ({
          label: m.name,
          click: () => win?.webContents.send('perform-action', `pose:${m.id}`),
        })),
        ...userMotions().map((m) => ({
          label: `${m.name}（追加）`,
          click: () => win?.webContents.send('perform-action', `pose:${m.id}`),
        })),
        { type: 'separator' },
        { label: 'VRMAを追加…', click: addUserVrma },
      ],
    },
      ],
    },
    {
      label: 'VRM',
      submenu: [
    { label: 'VRMを開く…', click: chooseVrm },
    {
      label: 'デフォルトのVRMに戻す',
      enabled: !!settings.vrmPath,
      click: () => updateSettings({ vrmPath: null }),
    },
    {
      label: `VRMローテーション（候補 ${settings.vrmList.length}体）`,
      submenu: [
        { label: '切り替え候補を選ぶ…', click: chooseVrmList },
        {
          label: '1時間ごとに切り替える',
          type: 'checkbox',
          checked: settings.vrmRotate,
          enabled: settings.vrmList.length > 1,
          click: (item) => updateSettings({ vrmRotate: item.checked }),
        },
        {
          label: '今すぐ次のVRMに切替',
          enabled: settings.vrmList.length > 1,
          click: () => rotateVrm(true),
        },
      ],
    },
      ],
    },
    { type: 'separator' },
    { label: '終了', role: 'quit' },
  ]);
  trayMenu = menu;
  tray?.setContextMenu(menu);
}

function registerIpc() {
  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('get-weather', () => weather);
  ipcMain.handle('get-bounds', () => win?.getBounds());
  ipcMain.handle('update-settings', (_e, patch) => updateSettings(patch));
  ipcMain.handle('read-vrm', async () => {
    const file = settings.vrmPath && fs.existsSync(settings.vrmPath) ? settings.vrmPath : DEFAULT_VRM;
    const buf = await fs.promises.readFile(file);
    return { name: path.basename(file), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  ipcMain.handle('load-motion', async (_e, id) => {
    const motion = [...MOTIONS, ...userMotions()].find((m) => m.id === id);
    if (!motion) throw new Error(`unknown motion ${id}`);
    if (motion.source === 'vrma') {
      const buf = await fs.promises.readFile(path.join(__dirname, '..', 'assets', 'motions', `${id}.vrma`));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (motion.source === 'user') {
      const buf = await fs.promises.readFile(path.join(USER_MOTION_DIR(), id.slice('user:'.length)));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    const dir = path.join(app.getPath('userData'), 'motions');
    const file = path.join(dir, `${id}.fbx`);
    if (!fs.existsSync(file)) {
      const res = await net.fetch(`${MOTION_BASE_URL}${id}.fbx`);
      if (!res.ok) throw new Error(`${id}.fbx: HTTP ${res.status}`);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
    const buf = await fs.promises.readFile(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.on('show-menu', () => trayMenu?.popup({ window: win }));
  ipcMain.on('set-ignore-mouse', (_e, ignore) => {
    if (!win || DEBUG) return;
    setIgnore(ignore);
  });
  ipcMain.on('char-rect', (_e, r) => {
    if (!handle || handle.isDestroyed() || !win) return;
    const b = win.getBounds();
    const pad = 12;
    // Sanitize: a bogus/huge rect would make the handle cover the whole screen and eat all input.
    const nums = [r?.left, r?.top, r?.right, r?.bottom];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return;
    const left = Math.max(0, r.left - pad);
    const top = Math.max(0, r.top - pad);
    const width = Math.min(Math.max(1, r.right - r.left + pad * 2), b.width - left);
    const height = Math.min(Math.max(1, r.bottom - r.top + pad * 2), b.height - top);
    handle.setBounds({ x: Math.round(b.x + left), y: Math.round(b.y + top), width: Math.round(width), height: Math.round(height) });
    if (!handle.isVisible()) handle.showInactive();
    // Keep the handle stacked above the click-through overlay, or pointer events stop reaching it.
    handle.moveTop();
  });
  let handleEvCount = 0;
  ipcMain.on('handle-pointer', (_e, ev) => {
    if (!win || !handle || handle.isDestroyed()) return;
    if (++handleEvCount <= 5 || handleEvCount % 300 === 0) trayDiag(`handle-pointer #${handleEvCount}: ${ev.type}`);
    if (ev.type === 'menu') {
      trayMenu?.popup({ window: handle });
      return;
    }
    const hb = handle.getBounds();
    const wb = win.getBounds();
    win.webContents.send('remote-pointer', {
      type: ev.type,
      x: hb.x + ev.x - wb.x,
      y: hb.y + ev.y - wb.y,
      button: ev.button,
    });
  });
  ipcMain.on('vrm-dropped', (_e, filePath) => {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) return;
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.vrm')) updateSettings({ vrmPath: filePath });
    else if (lower.endsWith('.vrma')) {
      fs.mkdirSync(USER_MOTION_DIR(), { recursive: true });
      fs.copyFileSync(filePath, path.join(USER_MOTION_DIR(), path.basename(filePath)));
      rebuildTrayMenu();
    }
  });
}

app.whenReady().then(async () => {
  if (process.env.MATE_TEST_ACTION) {
    setInterval(() => win?.webContents.send('perform-action', process.env.MATE_TEST_ACTION), Number(process.env.MATE_TEST_INTERVAL || 4000));
  }
  loadSettings();
  if (process.platform === 'darwin') app.dock?.hide();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  if (settings.cameraEnabled && !(await ensureCameraAccess())) {
    settings.cameraEnabled = false;
  }

  registerIpc();
  createWindow();
  if (process.platform === 'linux' && !DEBUG) createHandle();
  refreshWeather();
  setInterval(refreshWeather, WEATHER_REFRESH_MS);

  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('VRM Desktop Mate');
    if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
  } catch (e) {
    trayDiag(`tray creation failed: ${e.stack || e}`);
    console.error('tray creation failed:', e);
  }
  rebuildTrayMenu();

  screen.on('display-metrics-changed', fitWindowToDisplay);
  screen.on('display-added', fitWindowToDisplay);
  screen.on('display-removed', fitWindowToDisplay);

  setInterval(() => rotateVrm(false), 60 * 60 * 1000);

  pollAlerts();
  setInterval(pollAlerts, ALERT_POLL_MS);
});

app.on('window-all-closed', () => app.quit());
