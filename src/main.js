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
  wander: true,
  showPreview: false,
  pixelPitchMm: 0.2,
  cameraFovDeg: 65,
  gazeOffset: { x: 0, y: 0 },
  clockMode: 'hour',
  weatherDoodle: true,
};

let settings = { ...DEFAULT_SETTINGS };
let win = null;
let tray = null;
let trayMenu = null;
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

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
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
  if (!DEBUG) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: DEBUG ? { debug: '1' } : {},
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

function trayIcon() {
  // Template images are a macOS menu-bar concept; Windows needs a visibly-colored icon for dark taskbars.
  const file = process.platform === 'win32' ? 'tray.png' : 'trayTemplate.png';
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
  ];
  const menu = Menu.buildFromTemplate([
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
      label: '歩き回る',
      type: 'checkbox',
      checked: settings.wander,
      click: (item) => updateSettings({ wander: item.checked }),
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
    { type: 'separator' },
    {
      label: '視線キャリブレーション（キャラを見つめながらクリック）',
      click: () => win?.webContents.send('calibrate-gaze'),
    },
    {
      label: 'キャリブレーションをリセット',
      click: () => updateSettings({ gazeOffset: { x: 0, y: 0 } }),
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
      submenu: MOTIONS.filter((m) => m.source === 'vrma').map((m) => ({
        label: m.name,
        click: () => win?.webContents.send('perform-action', `pose:${m.id}`),
      })),
    },
    { type: 'separator' },
    { label: 'VRMを開く…', click: chooseVrm },
    {
      label: 'デフォルトのVRMに戻す',
      enabled: !!settings.vrmPath,
      click: () => updateSettings({ vrmPath: null }),
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
    const motion = MOTIONS.find((m) => m.id === id);
    if (!motion) throw new Error(`unknown motion ${id}`);
    if (motion.source === 'vrma') {
      const buf = await fs.promises.readFile(path.join(__dirname, '..', 'assets', 'motions', `${id}.vrma`));
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
    win.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.on('vrm-dropped', (_e, filePath) => {
    if (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.vrm') && fs.existsSync(filePath)) {
      updateSettings({ vrmPath: filePath });
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
});

app.on('window-all-closed', () => app.quit());
