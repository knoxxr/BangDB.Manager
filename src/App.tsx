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
import { useConnection } from './store/store';

/** knoxxr/bangdb (Go) connections get their own SQL-based pages; BangDB 2.0 REST keeps the REST ones. */
function ByKind({ go, rest }: { go: React.ReactNode; rest: React.ReactNode }) {
  const conn = useConnection(useParams().connId);
  return <>{conn?.kind === 'go' ? go : rest}</>;
}
function ServerPage() {
  const conn = useConnection(useParams().connId);
  return conn?.kind === 'go' ? <GoServerPage conn={conn} /> : <DatabasesPage />;
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
            <Route path="/c/:connId/db/:db" element={<ByKind go={<GoTablesPage />} rest={<TablesPage />} />} />
            <Route path="/c/:connId/db/:db/query" element={<QueryPage />} />
            <Route path="/c/:connId/db/:db/t/:table" element={<ByKind go={<GoTablePage />} rest={<TableDetailPage />} />} />
            <Route path="/c/:connId/console" element={<ConsolePage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/connections" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </ToastProvider>
  );
}
