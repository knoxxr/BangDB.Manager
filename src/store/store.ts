import { useMemo, useSyncExternalStore } from 'react';
import { onRequest } from '../api/bangdb';
import type { Connection, DbParams, GatewayKind, RequestLogEntry, ServerKind } from '../api/types';

const KEY = 'bangdb-manager.connections.v1';
const MAX_LOG = 200;

interface State {
  connections: Connection[];
  log: RequestLogEntry[];
}

function load(): Connection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Connection[];
    return Array.isArray(list) ? list.map(normalize) : [];
  } catch {
    return [];
  }
}

function persist(list: Connection[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

const GATEWAY_KINDS: ServerKind[] = ['postgres', 'mysql', 'mssql', 'sqlite', 'mongodb', 'redis'];
export const isGatewayKind = (k: ServerKind | undefined): k is GatewayKind => !!k && GATEWAY_KINDS.includes(k);

/** Database a gateway connection opens first, when the user named none. */
const FALLBACK_DB: Record<GatewayKind, string> = { postgres: 'postgres', mysql: '', mssql: 'master', sqlite: 'main', mongodb: 'test', redis: '0' };

export function normalize(c: Partial<Connection>): Connection {
  const kind: ServerKind = c.kind === 'go' || isGatewayKind(c.kind) ? c.kind : 'rest';
  if (isGatewayKind(kind)) {
    const db: DbParams = { ...(c.db ?? {}) };
    if (db.port !== undefined && !Number(db.port)) delete db.port;
    const defaultDb = kind === 'sqlite' ? 'main' : (db.database?.trim() || FALLBACK_DB[kind] || 'main');
    return {
      id: c.id ?? newId(),
      name: c.name?.trim() || `${db.host || db.file || kind}${db.database ? `/${db.database}` : ''}`,
      kind,
      baseUrl: c.baseUrl?.trim() ? withScheme(c.baseUrl.trim().replace(/\/+$/, '')) : '',
      defaultDb,
      databases: [defaultDb],
      auth: { mode: 'none', headerName: '', tokenField: 'token' },
      useProxy: false,
      endpointOverrides: {},
      createdAt: c.createdAt ?? Date.now(),
      db,
      gatewayToken: c.gatewayToken?.trim() || undefined
    };
  }
  const defaultDb = c.defaultDb?.trim() || (kind === 'go' ? 'main' : 'mydb');
  const dbs = kind === 'go' ? [defaultDb] : Array.from(new Set([defaultDb, ...(c.databases ?? [])].filter(Boolean)));
  return {
    id: c.id ?? newId(),
    name: c.name?.trim() || c.baseUrl || 'BangDB',
    kind,
    baseUrl: withScheme((c.baseUrl ?? 'http://127.0.0.1:18080').trim().replace(/\/+$/, '')),
    defaultDb,
    databases: dbs,
    auth: {
      mode: c.auth?.mode ?? 'none',
      headerName: c.auth?.headerName?.trim() || 'x-bang-api-key',
      apiKey: c.auth?.apiKey,
      user: c.auth?.user,
      pass: c.auth?.pass,
      tokenField: c.auth?.tokenField?.trim() || 'token',
      token: c.auth?.token
    },
    useProxy: !!c.useProxy,
    endpointOverrides: c.endpointOverrides ?? {},
    createdAt: c.createdAt ?? Date.now()
  };
}

/** "host:port" → "http://host:port" (fetch rejects URLs without a scheme). */
export const withScheme = (url: string) => (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? `http://${url}` : url);

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

let state: State = { connections: typeof localStorage !== 'undefined' ? load() : [], log: [] };
const subs = new Set<() => void>();
function set(next: State) {
  state = next;
  subs.forEach((s) => s());
}
function subscribe(s: () => void) {
  subs.add(s);
  return () => subs.delete(s);
}

onRequest((entry) => set({ ...state, log: [entry, ...state.log].slice(0, MAX_LOG) }));

export const store = {
  getState: () => state,
  upsertConnection(c: Connection) {
    const n = normalize(c);
    const exists = state.connections.some((x) => x.id === n.id);
    const connections = exists ? state.connections.map((x) => (x.id === n.id ? n : x)) : [...state.connections, n];
    persist(connections);
    set({ ...state, connections });
    return n;
  },
  removeConnection(id: string) {
    const connections = state.connections.filter((x) => x.id !== id);
    persist(connections);
    set({ ...state, connections });
  },
  addDatabase(connId: string, db: string) {
    const c = state.connections.find((x) => x.id === connId);
    if (!c || !db.trim()) return;
    if (c.databases.includes(db)) return;
    store.upsertConnection({ ...c, databases: [...c.databases, db.trim()] });
  },
  removeDatabase(connId: string, db: string) {
    const c = state.connections.find((x) => x.id === connId);
    if (!c) return;
    store.upsertConnection({ ...c, databases: c.databases.filter((d) => d !== db) });
  },
  setToken(connId: string, token: string | undefined) {
    const c = state.connections.find((x) => x.id === connId);
    if (!c) return;
    store.upsertConnection({ ...c, auth: { ...c.auth, token } });
  },
  clearLog() {
    set({ ...state, log: [] });
  }
};

export function useStore(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function useConnection(id: string | undefined): Connection | undefined {
  const { connections } = useStore();
  return connections.find((c) => c.id === id);
}

/**
 * The connection with the database chosen in the URL (/c/:id/db/:db) applied:
 * gateway connections open that database instead of their default one.
 */
export function useDbConnection(id: string | undefined, db: string | undefined): Connection | undefined {
  const c = useConnection(id);
  return useMemo(() => (c && db && isGatewayKind(c.kind) && c.kind !== 'sqlite' && db !== c.db?.database ? { ...c, db: { ...c.db, database: db } } : c), [c, db]);
}
