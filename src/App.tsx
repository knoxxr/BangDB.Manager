import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './components/ui';
import AboutPage from './pages/AboutPage';
import ConnectionsPage from './pages/ConnectionsPage';
import ConsolePage from './pages/ConsolePage';
import DatabasesPage from './pages/DatabasesPage';
import QueryPage from './pages/QueryPage';
import TableDetailPage from './pages/TableDetailPage';
import TablesPage from './pages/TablesPage';
import GoServerPage from './pages/GoServerPage';
import GoTablePage from './pages/GoTablePage';
import GoTablesPage from './pages/GoTablesPage';
import { MongoCollectionPage, MongoDbPage, MongoServerPage } from './pages/MongoPages';
import RedisPage from './pages/RedisPage';
import SqlServerPage from './pages/SqlServerPage';
import type { ServerKind } from './api/types';
import { useConnection } from './store/store';

type Pages = Partial<Record<ServerKind | 'sql', React.ReactNode>>;

/**
 * Pick the page for the connection's kind: `sql` covers BangDB (Go) and the
 * gateway's SQL databases, which share the SQL pages.
 */
function ByKind(p: Pages) {
  const conn = useConnection(useParams().connId);
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다. <a href="#/connections">서버 목록</a></div>;
  const sql = ['go', 'postgres', 'mysql', 'mssql', 'sqlite'].includes(conn.kind);
  return <>{p[conn.kind] ?? (sql ? p.sql : undefined) ?? p.rest}</>;
}
function ServerPage() {
  const conn = useConnection(useParams().connId);
  if (!conn) return <DatabasesPage />;
  if (conn.kind === 'go') return <GoServerPage conn={conn} />;
  if (conn.kind === 'mongodb') return <MongoServerPage conn={conn} />;
  if (conn.kind === 'redis') return <RedisPage />;
  if (conn.db) return <SqlServerPage conn={conn} />;
  return <DatabasesPage />;
}

// HashRouter keeps deep links working when the built files are served from a
// plain static host, a file:// WebView (Capacitor) or the bundled proxy.
export default function App() {
  return (
    <ToastProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/connections" replace />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/c/:connId/dbs" element={<ServerPage />} />
            <Route path="/c/:connId/db/:db" element={<ByKind sql={<GoTablesPage />} mongodb={<MongoDbPage />} redis={<RedisPage />} rest={<TablesPage />} />} />
            <Route path="/c/:connId/db/:db/query" element={<ByKind mongodb={<MongoDbPage />} redis={<RedisPage />} rest={<QueryPage />} />} />
            <Route path="/c/:connId/db/:db/t/:table" element={<ByKind sql={<GoTablePage />} mongodb={<MongoCollectionPage />} rest={<TableDetailPage />} />} />
            <Route path="/c/:connId/console" element={<ConsolePage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/connections" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </ToastProvider>
  );
}
