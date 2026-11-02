import { Capacitor } from '@capacitor/core';
import { DEFAULT_ENDPOINTS, GO_KEYS, REST_KEYS } from '../api/endpoints';
import { TopBar } from '../components/Layout';

export default function AboutPage() {
  const platform = Capacitor.getPlatform();
  const standalone = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  return (
    <>
      <TopBar title="About" />
      <div className="card">
        <p><b>BangDB Manager</b> v{__APP_VERSION__}</p>
        <p className="muted small">Platform: {platform}{standalone ? ' (installed PWA)' : ''}</p>
        <p className="small">A cross-platform management tool that creates, browses and drops tables, inserts and edits rows, and runs SQL queries through the JSON HTTP API of knoxxr/bangdb (<code>bangdb -http</code>, default port 18081) and the BangDB 2.0 REST API (port 18080). Connection details are kept only in this device's browser storage.</p>
      </div>
      <div className="card">
        <b>Install on a phone</b>
        <ul className="small">
          <li>Android Chrome: Menu → "Add to Home Screen" (PWA)</li>
          <li>iOS Safari: Share → "Add to Home Screen"</li>
          <li>Native app: build with <code>npm run cap:android</code> / <code>npm run cap:ios</code> as described in the repository README</li>
        </ul>
      </div>
      <div className="card">
        <b>Endpoints (defaults)</b>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table className="data">
            <thead><tr><th>Key</th><th>Method</th><th>Path</th><th>Verified</th></tr></thead>
            <tbody>
              {[...GO_KEYS, ...REST_KEYS].map((k) => {
                const e = DEFAULT_ENDPOINTS[k];
                return <tr key={k}><td className="mono">{k}</td><td>{e.method}</td><td className="mono">{e.path}</td><td>{GO_KEYS.includes(k) ? 'Go' : e.verified ? <span className="ok">✔</span> : <span className="warn">unverified</span>}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">"unverified" entries can be changed under Edit connection → Advanced.</p>
      </div>
    </>
  );
}
