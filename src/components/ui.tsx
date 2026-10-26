import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../api/types';

// ---------- Toasts ----------
interface Toast { id: number; text: string; kind: 'info' | 'ok' | 'err' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l, { id, text, kind }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Human readable one-liner for an API result, for toasts. */
export function describeResult(r: ApiResult): string {
  if (r.error) return r.error;
  if (!r.ok) {
    const msg = typeof r.data === 'object' && r.data && 'msg' in (r.data as object)
      ? String((r.data as Record<string, unknown>).msg)
      : r.text.slice(0, 160);
    return `HTTP ${r.status} ${msg}`.trim();
  }
  return `성공 (${r.status}, ${r.durationMs}ms)`;
}

// ---------- Modal ----------
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ---------- Confirm ----------
export function useConfirm() {
  const [req, setReq] = useState<{ text: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((text: string) => new Promise<boolean>((resolve) => setReq({ text, resolve })), []);
  const el = req ? (
    <Modal title="확인" onClose={() => { req.resolve(false); setReq(null); }}>
      <p>{req.text}</p>
      <div className="actions">
        <button className="btn" onClick={() => { req.resolve(false); setReq(null); }}>취소</button>
        <button className="btn danger" onClick={() => { req.resolve(true); setReq(null); }}>삭제</button>
      </div>
    </Modal>
  ) : null;
  return { confirm, confirmEl: el };
}

// ---------- JSON output ----------
export function JsonOut({ value }: { value: unknown }) {
  const text = useMemo(() => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)), [value]);
  return <pre className="out">{text}</pre>;
}

export function ResultBadge({ r }: { r: ApiResult | null }) {
  if (!r) return null;
  const cls = r.error ? 'err' : r.ok ? 'ok' : 'warn';
  return <span className={`badge ${cls}`}>{r.error ? '오류' : `HTTP ${r.status}`} · {r.durationMs}ms</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Table rendering of an array of flat-ish objects. Nested values shown as JSON. */
export function DataTable({ rows, onRowClick }: { rows: Record<string, unknown>[]; onRowClick?: (row: Record<string, unknown>, index: number) => void }) {
  const cols = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => Object.keys(r).forEach((k) => s.add(k)));
    return Array.from(s);
  }, [rows]);
  if (!rows.length) return <div className="empty">결과 없음</div>;
  return (
    <div className="tablewrap">
      <table className="data">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(r, i) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>{cols.map((c) => <td key={c} title={fmt(r[c])}>{fmt(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const fmt = (v: unknown) => (v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
