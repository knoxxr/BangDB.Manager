// Desktop shell (Windows / Linux / macOS). It serves the built app from an
// in-process copy of the proxy + database gateway, so "프록시 경유" works for
// REST servers and PostgreSQL/MySQL/SQL Server/SQLite/MongoDB/Redis work
// without any extra install, and it can open the same server on the LAN so
// phones use the app without installing anything.
import { app, BrowserWindow, Menu, dialog, shell, clipboard, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createProxyServer, listen } from '../proxy/lib.mjs';
import { check as checkUpdates, initUpdater, statusLabel } from './updater.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const LAN_PORT = Number(process.env.BANGDB_MANAGER_LAN_PORT || 8080);

// The gateway reads GATEWAY_TOKEN when it loads: fix a token first so that
// phones on the LAN can use it, and inject it into this window's own requests.
const TOKEN = process.env.GATEWAY_TOKEN || randomBytes(16).toString('hex');
process.env.GATEWAY_TOKEN = TOKEN;
if (!process.env.SQLITE_ROOT) process.env.SQLITE_ROOT = join(app.getPath('documents'), 'BangDB Manager');

let gateway = null;   // handleGateway, when the drivers are bundled
let gatewayError = '';
let local = null;     // { server, port } bound to 127.0.0.1 for the window
let lan = null;       // { server, port } bound to 0.0.0.0 for phones
let win = null;

async function loadGateway() {
  try {
    ({ handleGateway: gateway } = await import('../proxy/gateway/index.mjs'));
  } catch (e) {
    gatewayError = e.message;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

async function startLocal() {
  const server = createProxyServer({ dist, gateway });
  const port = await listen(server, 0, '127.0.0.1');
  local = { server, port };
  // this window's pages get the gateway token automatically
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/gw/*`] }, (details, cb) => {
    details.requestHeaders['x-gateway-token'] = TOKEN;
    cb({ requestHeaders: details.requestHeaders });
  });
}

async function toggleLan(item) {
  if (lan) {
    lan.server.close();
    lan = null;
    if (item) item.checked = false;
    return;
  }
  const server = createProxyServer({ dist, gateway });
  try {
    const port = await listen(server, LAN_PORT, '0.0.0.0');
    lan = { server, port };
    if (item) item.checked = true;
    showLanAddresses();
  } catch (e) {
    if (item) item.checked = false;
    dialog.showErrorBox('휴대폰 접속 허용 실패', `포트 ${LAN_PORT} 을(를) 열 수 없습니다: ${e.message}`);
  }
}

function showLanAddresses() {
  if (!lan) {
    dialog.showMessageBox(win, { type: 'info', message: '휴대폰 접속이 꺼져 있습니다', detail: '서버 메뉴에서 "휴대폰 접속 허용"을 켜세요.' });
    return;
  }
  const urls = lanAddresses().map((a) => `http://${a}:${lan.port}`);
  const detail = [
    urls.length ? urls.join('\n') : `http://<이 PC 의 IP>:${lan.port}`,
    '',
    '열린 뒤 "홈 화면에 추가"하면 앱처럼 쓸 수 있습니다. 방화벽이 ' + lan.port + ' 포트를 허용해야 합니다.',
    gateway ? `PostgreSQL 등 게이트웨이 DB 를 휴대폰에서 쓰려면 연결 편집의 게이트웨이 토큰에 다음 값을 넣으세요:\n${TOKEN}` : ''
  ].join('\n');
  dialog.showMessageBox(win, {
    type: 'info', message: '같은 네트워크의 휴대폰 브라우저에서 여세요', detail,
    buttons: ['주소 복사', '토큰 복사', '닫기'], defaultId: 0, cancelId: 2
  }).then((r) => {
    if (r.response === 0 && urls.length) clipboard.writeText(urls[0]);
    if (r.response === 1) clipboard.writeText(TOKEN);
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '파일', submenu: [{ role: 'quit', label: '종료' }] },
    {
      label: '서버',
      submenu: [
        { id: 'lan', label: `휴대폰 접속 허용 (포트 ${LAN_PORT})`, type: 'checkbox', checked: !!lan, click: (item) => toggleLan(item) },
        { label: '휴대폰 접속 주소·토큰 보기', click: showLanAddresses },
        { type: 'separator' },
        { label: gateway ? `DB 게이트웨이: 내장됨 (SQLite 폴더: ${process.env.SQLITE_ROOT})` : `DB 게이트웨이 없음: ${gatewayError}`, enabled: false }
      ]
    },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'toggleDevTools', label: '개발자 도구' }, { type: 'separator' }, { role: 'resetZoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }] },
    { label: '도움말', submenu: [
      { label: '업데이트 확인', click: () => checkUpdates(true) },
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: 'GitHub 저장소', click: () => shell.openExternal('https://github.com/knoxxr/BangDB.Manager') },
      { label: '릴리즈 노트', click: () => shell.openExternal('https://github.com/knoxxr/BangDB.Manager/releases') },
      { label: `버전 ${app.getVersion()}`, enabled: false }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 780, minWidth: 360, minHeight: 480,
    title: 'BangDB Manager', backgroundColor: '#0f172a',
    icon: join(here, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.loadURL(`http://127.0.0.1:${local.port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  await loadGateway();
  try {
    await startLocal();
  } catch (e) {
    dialog.showErrorBox('시작 실패', `내부 서버를 열 수 없습니다: ${e.message}`);
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
  initUpdater({ getWindow: () => win, onState: () => buildMenu() });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { local?.server.close(); lan?.server.close(); });
