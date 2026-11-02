// Desktop shell (Windows / Linux / macOS). It serves the built app from an
// in-process copy of the proxy + database gateway, so "via proxy" works for
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
    dialog.showErrorBox('Allow phone access failed', `Could not open port ${LAN_PORT}: ${e.message}`);
  }
}

function showLanAddresses() {
  if (!lan) {
    dialog.showMessageBox(win, { type: 'info', message: 'Phone access is off', detail: 'Turn on "Allow phone access" in the Server menu.' });
    return;
  }
  const urls = lanAddresses().map((a) => `http://${a}:${lan.port}`);
  const detail = [
    urls.length ? urls.join('\n') : `http://<this PC's IP>:${lan.port}`,
    '',
    'Once open, use "Add to Home Screen" to use it like an app. The firewall must allow port ' + lan.port + '.',
    gateway ? `To use gateway databases such as PostgreSQL from a phone, enter this value as the gateway token when editing the connection:\n${TOKEN}` : ''
  ].join('\n');
  dialog.showMessageBox(win, {
    type: 'info', message: 'Open in a phone browser on the same network', detail,
    buttons: ['Copy address', 'Copy token', 'Close'], defaultId: 0, cancelId: 2
  }).then((r) => {
    if (r.response === 0 && urls.length) clipboard.writeText(urls[0]);
    if (r.response === 1) clipboard.writeText(TOKEN);
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: 'quit', label: 'Quit' }] },
    {
      label: 'Server',
      submenu: [
        { id: 'lan', label: `Allow phone access (port ${LAN_PORT})`, type: 'checkbox', checked: !!lan, click: (item) => toggleLan(item) },
        { label: 'Show phone access address & token', click: showLanAddresses },
        { type: 'separator' },
        { label: gateway ? `DB gateway: built in (SQLite folder: ${process.env.SQLITE_ROOT})` : `DB gateway unavailable: ${gatewayError}`, enabled: false }
      ]
    },
    { label: 'View', submenu: [{ role: 'reload', label: 'Refresh' }, { role: 'toggleDevTools', label: 'Developer tools' }, { type: 'separator' }, { role: 'resetZoom', label: 'Actual size' }, { role: 'zoomIn', label: 'Zoom in' }, { role: 'zoomOut', label: 'Zoom out' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Full screen' }] },
    { label: 'Help', submenu: [
      { label: 'Check for updates', click: () => checkUpdates(true) },
      { label: statusLabel(), enabled: false },
      { type: 'separator' },
      { label: 'GitHub repository', click: () => shell.openExternal('https://github.com/knoxxr/BangDB.Manager') },
      { label: 'Release notes', click: () => shell.openExternal('https://github.com/knoxxr/BangDB.Manager/releases') },
      { label: `Version ${app.getVersion()}`, enabled: false }
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
    dialog.showErrorBox('Startup failed', `Could not start the internal server: ${e.message}`);
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
