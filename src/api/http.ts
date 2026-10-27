import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { ApiResult, Connection, HttpMethod } from './types';

export interface RawRequest {
  method: HttpMethod;
  /** Path relative to the connection base URL, may include a query string. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Base URL actually used for a connection: the real server, or the app-local /bangdb proxy. */
export function effectiveBase(conn: Connection): string {
  if (conn.db) {
    // gateway kinds: an explicit gateway URL, or the server that serves this app
    return conn.baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  }
  if (conn.useProxy) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/bangdb`;
  }
  return conn.baseUrl;
}

export function authHeaders(conn: Connection): Record<string, string> {
  const a = conn.auth;
  const h: Record<string, string> = {};
  if (conn.db) {
    if (conn.gatewayToken) h['x-gateway-token'] = conn.gatewayToken;
    return h;
  }
  if (conn.useProxy) h['x-bangdb-target'] = conn.baseUrl;
  switch (a.mode) {
    case 'apikey':
      if (a.apiKey) h[a.headerName || 'x-bang-api-key'] = a.apiKey;
      break;
    case 'login':
      if (a.token) h[a.headerName || 'x-bang-api-key'] = a.token;
      break;
    case 'basic':
      if (a.user !== undefined) h['Authorization'] = `Basic ${toBase64(`${a.user}:${a.pass ?? ''}`)}`;
      break;
  }
  return h;
}

function toBase64(s: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, 'utf8').toString('base64');
}

function parseBody(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

/** Fetch implementation; swapped in tests. */
export let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setFetchImpl(f: typeof fetch) {
  fetchImpl = f;
}

export async function rawRequest(conn: Connection, req: RawRequest): Promise<ApiResult> {
  const url = joinUrl(effectiveBase(conn), req.path);
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(conn), ...(req.headers ?? {}) };
  const hasBody = req.body !== undefined && req.body !== null && req.method !== 'GET';
  const bodyText = hasBody ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined;
  if (hasBody) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  const started = Date.now();

  // Native shells (Android/iOS) call through CapacitorHttp so CORS does not apply.
  if (Capacitor.isNativePlatform() && !conn.useProxy) {
    try {
      const res = await CapacitorHttp.request({
        url,
        method: req.method,
        headers,
        data: bodyText,
        responseType: 'text',
        connectTimeout: req.timeoutMs ?? 15000,
        readTimeout: req.timeoutMs ?? 15000
      });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        data: parseBody(text),
        text,
        url,
        method: req.method,
        durationMs: Date.now() - started
      };
    } catch (e) {
      return failure(url, req.method, started, e);
    }
  }

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15000) : undefined;
  try {
    const res = await fetchImpl(url, { method: req.method, headers, body: bodyText, signal: ctrl?.signal });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      data: parseBody(text),
      text,
      url,
      method: req.method,
      durationMs: Date.now() - started
    };
  } catch (e) {
    return failure(url, req.method, started, e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failure(url: string, method: HttpMethod, started: number, e: unknown): ApiResult {
  const msg = e instanceof Error ? (e.name === 'AbortError' ? '요청 시간 초과' : e.message) : String(e);
  return { ok: false, status: 0, data: null, text: '', url, method, durationMs: Date.now() - started, error: msg };
}
