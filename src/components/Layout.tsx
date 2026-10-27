import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useStore } from '../store/store';

const I = {
  server: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg>,
  db: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>,
  sql: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17l6-5-6-5M12 19h8"/></svg>,
  console: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15l3-3-3-3M12 15h5"/></svg>,
  chart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>,
  info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>
};

export default function Layout() {
  const { connId } = useParams();
  const { connections } = useStore();
  const active = connections.find((c) => c.id === connId) ?? connections[0];
  const base = active ? `/c/${active.id}` : undefined;
  const kind = active?.kind;
  const rest = kind === 'rest' || kind === undefined;
  const dbPath = base ? `${base}/db/${encodeURIComponent(active!.defaultDb)}` : '/connections';
  const links: { to: string; label: string; icon: JSX.Element; disabled?: boolean; end?: boolean }[] = [
    { to: '/connections', label: '서버', icon: I.server },
    { to: base ? `${base}/dbs` : '/connections', label: rest ? 'DB' : kind === 'redis' ? '키' : '개요', icon: rest ? I.db : kind === 'redis' ? I.db : I.chart, disabled: !base },
    ...(kind && kind !== 'rest' && kind !== 'redis' ? [{ to: dbPath, label: kind === 'mongodb' ? '컬렉션' : '테이블', icon: I.db, end: true }] : []),
    ...(kind !== 'mongodb' && kind !== 'redis' ? [{ to: `${dbPath}/query`, label: 'SQL', icon: I.sql, disabled: !base }] : []),
    ...(kind === 'go' || rest ? [{ to: base ? `${base}/console` : '/connections', label: 'REST', icon: I.console, disabled: !base }] : []),
    { to: '/about', label: '정보', icon: I.info }
  ];
  const nav = (cls: string) => (
    <nav className={cls}>
      {cls === 'sidenav' && <div className="brand">BangDB Manager</div>}
      {links.map((l) => (
        <NavLink key={l.label} to={l.to} end={!!l.end} className={({ isActive }) => (isActive && !l.disabled ? 'active' : '')} style={l.disabled ? { opacity: 0.4 } : undefined}>
          {l.icon}<span>{l.label}</span>
        </NavLink>
      ))}
      {cls === 'sidenav' && active && <div className="muted small" style={{ marginTop: 'auto', padding: 10 }}>현재 서버: {active.name}</div>}
    </nav>
  );
  return (
    <div className="app">
      {nav('sidenav')}
      <main className="main"><Outlet /></main>
      {nav('tabbar')}
    </div>
  );
}

export function TopBar({ title, crumbs, right }: { title: string; crumbs?: { to?: string; label: string }[]; right?: React.ReactNode }) {
  return (
    <div className="topbar">
      <div className="grow">
        {crumbs && (
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={i}>{i > 0 && ' / '}{c.to ? <NavLink to={c.to}>{c.label}</NavLink> : c.label}</span>
            ))}
          </div>
        )}
        <h1>{title}</h1>
      </div>
      {right}
    </div>
  );
}
