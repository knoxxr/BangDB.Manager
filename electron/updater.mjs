// Auto-update for the desktop app.
//  - Windows (NSIS) and Linux AppImage: electron-updater downloads the new
//    version from the GitHub release and installs it on restart.
//  - macOS (unsigned build) and Linux deb: electron-updater cannot replace
//    the app, so we only look up the latest GitHub release and offer the
//    download page.
// BANGDB_MANAGER_NO_UPDATE=1 turns everything off.
import { app, dialog, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import updater from 'electron-updater';

const { autoUpdater } = updater;
export const REPO = 'knoxxr/BangDB.Manager';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY = 4 * 60 * 60 * 1000;

export const state = { mode: 'off', status: 'idle', version: '', percent: 0, error: '' };
let onChange = () => {};
let timer = null;
let win = () => null;

export function updateMode() {
  if (process.env.BANGDB_MANAGER_NO_UPDATE) return 'off';
  if (!app.isPackaged) return 'off';
  if (process.platform === 'win32') return 'auto';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'auto' : 'notify';
  return 'notify';
}

function set(patch) { Object.assign(state, patch); onChange(state); }

const prefsPath = () => join(app.getPath('userData'), 'updater.json');
function prefs() { try { return JSON.parse(readFileSync(prefsPath(), 'utf8')); } catch { return {}; } }
function savePrefs(p) { try { writeFileSync(prefsPath(), JSON.stringify(p)); } catch { /* ignore */ } }

/** 1 when a is newer than b, -1 when older, 0 when equal. Tags may start with "v". */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function initUpdater({ getWindow, onState }) {
  win = getWindow;
  onChange = onState ?? onChange;
  set({ mode: updateMode() });
  if (state.mode === 'off') return;
  if (state.mode === 'auto') {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', (info) => set({ status: 'none', version: info?.version ?? '' }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('error', (e) => set({ status: 'error', error: e?.message ?? String(e) }));
    autoUpdater.on('update-downloaded', (info) => {
      set({ status: 'downloaded', version: info.version, percent: 100 });
      dialog.showMessageBox(win(), {
        type: 'info', message: `BangDB Manager ${info.version} 이(가) 준비되었습니다`,
        detail: '지금 재시작해 설치할까요? 나중에를 누르면 앱을 닫을 때 설치됩니다.',
        buttons: ['지금 재시작', '나중에'], defaultId: 0, cancelId: 1
      }).then((r) => { if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall()); });
    });
  }
  setTimeout(() => check(false), 8000);
  timer = setInterval(() => check(false), CHECK_EVERY);
  app.on('before-quit', () => clearInterval(timer));
}

/** Check now. With manual=true the result is always shown in a dialog. */
export async function check(manual) {
  if (state.mode === 'off') {
    if (manual) dialog.showMessageBox(win(), { type: 'info', message: '자동 업데이트가 꺼져 있습니다', detail: app.isPackaged ? 'BANGDB_MANAGER_NO_UPDATE 환경 변수가 설정되어 있습니다.' : '개발 모드에서는 동작하지 않습니다.' });
    return;
  }
  if (state.mode === 'auto') {
    try {
      const r = await autoUpdater.checkForUpdates();
      const v = r?.updateInfo?.version;
      if (manual && v && compareVersions(v, app.getVersion()) <= 0) {
        dialog.showMessageBox(win(), { type: 'info', message: '최신 버전입니다', detail: `현재 ${app.getVersion()}` });
      } else if (manual && v) {
        dialog.showMessageBox(win(), { type: 'info', message: `${v} 다운로드 중`, detail: '내려받기가 끝나면 설치 여부를 물어봅니다.' });
      }
    } catch (e) {
      set({ status: 'error', error: e?.message ?? String(e) });
      if (manual) dialog.showErrorBox('업데이트 확인 실패', state.error);
    }
    return;
  }
  // notify mode: look at the latest GitHub release
  set({ status: 'checking', error: '' });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bangdb-manager' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name ?? '').replace(/^v/, '');
    if (!latest) throw new Error('태그를 찾을 수 없습니다');
    if (compareVersions(latest, app.getVersion()) <= 0) {
      set({ status: 'none', version: latest });
      if (manual) dialog.showMessageBox(win(), { type: 'info', message: '최신 버전입니다', detail: `현재 ${app.getVersion()}` });
      return;
    }
    set({ status: 'available', version: latest });
    const p = prefs();
    if (!manual && p.skip === latest) return;
    const r = await dialog.showMessageBox(win(), {
      type: 'info', message: `새 버전 ${latest} 이(가) 있습니다 (현재 ${app.getVersion()})`,
      detail: `${process.platform === 'darwin' ? 'macOS' : 'deb'} 빌드는 자동 설치를 지원하지 않습니다. 다운로드 페이지에서 새 설치 파일을 받아 주세요.`,
      buttons: ['다운로드 페이지 열기', '이 버전 건너뛰기', '나중에'], defaultId: 0, cancelId: 2
    });
    if (r.response === 0) shell.openExternal(rel.html_url || RELEASES);
    if (r.response === 1) savePrefs({ ...p, skip: latest });
  } catch (e) {
    set({ status: 'error', error: e?.message ?? String(e) });
    if (manual) dialog.showErrorBox('업데이트 확인 실패', state.error);
  }
}

/** Short text for the menu. */
export function statusLabel() {
  switch (state.status) {
    case 'checking': return '업데이트 확인 중…';
    case 'downloading': return `업데이트 ${state.version} 내려받는 중 ${state.percent}%`;
    case 'downloaded': return `업데이트 ${state.version} 설치 준비됨 (재시작 시 적용)`;
    case 'available': return `새 버전 ${state.version} 있음`;
    case 'none': return `최신 버전 (${app.getVersion()})`;
    case 'error': return `업데이트 오류: ${state.error.slice(0, 60)}`;
    default: return state.mode === 'off' ? '자동 업데이트 꺼짐' : `버전 ${app.getVersion()}`;
  }
}
