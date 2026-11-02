import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { isElectron } from '../platform';
import { Icons } from './kinds';

const REPO = 'knoxxr/BangDB.Manager';
const CHECK_KEY = 'bangdb-manager.update-check';
const SKIP_KEY = 'bangdb-manager.update-skip';
const DAY = 24 * 60 * 60 * 1000;

/** 1 when a is newer than b. Tags may start with "v". */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

interface Release { tag_name: string; html_url: string; assets?: { name: string; browser_download_url: string }[] }

/** Picks the download link for this platform from a release's assets. */
export function downloadFor(rel: Release, platform: string): string {
  const want = platform === 'android' ? /android.*\.apk$/i : platform === 'ios' ? /\.ipa$/i : /web.*\.zip$/i;
  return rel.assets?.find((a) => want.test(a.name))?.browser_download_url ?? rel.html_url;
}

/**
 * Shows a bar when a newer version is ready:
 *  - web / PWA: the service worker fetched a new build → "새로고침" applies it
 *  - Android / iOS app: the newest GitHub release is newer than this build → download link
 *  - desktop app: nothing here, electron-updater handles it in the main process
 */
export default function UpdateBanner() {
  const native = Capacitor.isNativePlatform();
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, r) {
      if (!r) return;
      // look for a new build every hour and whenever the app comes back to the foreground
      setInterval(() => r.update(), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update(); });
    }
  });
  const [release, setRelease] = useState<{ version: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native || isElectron) return;
    let last = 0;
    try { last = Number(localStorage.getItem(CHECK_KEY) || 0); } catch { /* ignore */ }
    if (Date.now() - last < DAY) return;
    (async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) return;
        const rel = (await res.json()) as Release;
        try { localStorage.setItem(CHECK_KEY, String(Date.now())); } catch { /* ignore */ }
        const latest = rel.tag_name.replace(/^v/, '');
        let skip = '';
        try { skip = localStorage.getItem(SKIP_KEY) || ''; } catch { /* ignore */ }
        if (compareVersions(latest, __APP_VERSION__) > 0 && skip !== latest) setRelease({ version: latest, url: downloadFor(rel, Capacitor.getPlatform()) });
      } catch { /* offline: try again tomorrow */ }
    })();
  }, [native]);

  if (needRefresh) {
    return (
      <div className="updatebar" role="status">
        {Icons.refresh}
        <span className="grow">새 버전이 준비되었습니다.</span>
        <button className="btn sm ghost" onClick={() => setNeedRefresh(false)}>나중에</button>
        <button className="btn sm primary" disabled={busy} onClick={() => { setBusy(true); updateServiceWorker(true); }}>{busy ? '적용 중…' : '새로고침'}</button>
      </div>
    );
  }
  if (release) {
    return (
      <div className="updatebar" role="status">
        {Icons.refresh}
        <span className="grow">새 버전 {release.version} 이(가) 있습니다 (현재 {__APP_VERSION__}).</span>
        <button className="btn sm ghost" onClick={() => { try { localStorage.setItem(SKIP_KEY, release.version); } catch { /* ignore */ } setRelease(null); }}>건너뛰기</button>
        <a className="btn sm primary" href={release.url} target="_blank" rel="noopener">다운로드</a>
      </div>
    );
  }
  return null;
}
