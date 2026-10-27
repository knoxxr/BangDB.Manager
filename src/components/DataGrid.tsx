import { useEffect, useRef, useState } from 'react';
import { affinity, editText, isBlob, isBoolColumn, parseInput } from '../api/goapi';
import type { ColumnInfo } from '../api/types';

/** A grid row: `key` is the rowid, or "new:<n>" for a row not yet inserted. */
export interface GridRow {
  key: string;
  values: Record<string, unknown>;
  isNew?: boolean;
}

export interface GridProps {
  columns: ColumnInfo[];
  rows: GridRow[];
  readOnly?: boolean;
  /** Pending edits: row key → column → value. */
  edits: Record<string, Record<string, unknown>>;
  deleted: Set<string>;
  selected: Set<string>;
  sort?: { col: string; desc: boolean };
  onSort?: (col: string) => void;
  onEdit: (rowKey: string, col: string, value: unknown) => void;
  onToggleSelect: (rowKey: string) => void;
  onToggleAll: () => void;
  onOpenRow: (row: GridRow) => void;
  onError: (msg: string) => void;
}

/** Display text of a stored value. */
export function cellText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'NULL';
  if (isBlob(v)) return `BLOB (${Math.floor((v.blob.length * 3) / 4)} B)`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function DataGrid(p: GridProps) {
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const allSel = p.rows.length > 0 && p.rows.every((r) => p.selected.has(r.key));

  function move(row: string, col: string, dir: 1 | -1 | 'down') {
    const cols = p.columns.filter((c) => editable(c));
    if (dir === 'down') {
      const i = p.rows.findIndex((r) => r.key === row);
      const next = p.rows[i + 1];
      setEditing(next ? { row: next.key, col } : null);
      return;
    }
    const i = cols.findIndex((c) => c.name === col);
    const next = cols[i + dir];
    setEditing(next ? { row, col: next.name } : null);
  }

  const editable = (c: ColumnInfo) => !p.readOnly && affinity(c) !== 'BLOB';

  return (
    <div className="gridwrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="lead">
              {!p.readOnly && <input type="checkbox" checked={allSel} onChange={p.onToggleAll} aria-label="전체 선택" />}
            </th>
            {p.columns.map((c) => (
              <th key={c.name} className={p.onSort ? 'sortable' : ''} onClick={() => p.onSort?.(c.name)} title={c.decl || c.type || ''}>
                {c.pk && <span className="pk-ico" title="기본 키">🔑</span>}
                {c.name}
                {p.sort?.col === c.name && <span>{p.sort.desc ? ' ▼' : ' ▲'}</span>}
                <span className="ctype">{[c.decl || c.type || 'ANY', c.notNull ? 'NOT NULL' : '', c.default ? `= ${c.default}` : ''].filter(Boolean).join(' · ')}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => {
            const del = p.deleted.has(r.key);
            const sel = p.selected.has(r.key);
            const e = p.edits[r.key] ?? {};
            return (
              <tr key={r.key} className={[r.isNew ? 'new' : '', del ? 'deleted' : '', sel ? 'sel' : ''].join(' ')}>
                <td className="lead">
                  {!p.readOnly && <input type="checkbox" checked={sel} onChange={() => p.onToggleSelect(r.key)} aria-label="행 선택" />}
                  <button className="rowbtn" title={p.readOnly ? '자세히' : '폼으로 편집'} onClick={() => p.onOpenRow(r)}>{p.readOnly ? '⤢' : '✎'}</button>
                </td>
                {p.columns.map((c) => {
                  const has = c.name in e;
                  const v = has ? e[c.name] : r.values[c.name];
                  const isEditing = editing?.row === r.key && editing.col === c.name;
                  const a = affinity(c);
                  const cls = ['cell', has ? 'edited' : '', a === 'INTEGER' || a === 'REAL' ? 'num' : '', editable(c) && !del ? '' : 'ro'].join(' ');
                  if (isEditing) {
                    return (
                      <td key={c.name} className="editing">
                        <CellEditor col={c} value={v}
                          onCommit={(val, next) => {
                            if (!sameValue(val, r.values[c.name]) || has) p.onEdit(r.key, c.name, val);
                            if (next) move(r.key, c.name, next); else setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                          onError={p.onError} />
                      </td>
                    );
                  }
                  const placeholder = r.isNew && !has ? (c.pk && a === 'INTEGER' ? '(자동)' : c.default ? `기본값 ${c.default}` : '') : '';
                  return (
                    <td key={c.name} className={cls} title={cellText(v)}
                      onClick={() => { if (editable(c) && !del) setEditing({ row: r.key, col: c.name }); }}>
                      {placeholder ? <span className="null">{placeholder}</span> : v === null || (r.isNew && v === undefined) ? <span className="null">{r.isNew ? '' : 'NULL'}</span> : cellText(v)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!p.rows.length && <div className="empty">행이 없습니다</div>}
    </div>
  );
}

const sameValue = (a: unknown, b: unknown) => a === b || (a !== null && b !== null && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Inline editor: Enter saves and moves down, Tab moves right, Esc cancels. */
function CellEditor({ col, value, onCommit, onCancel, onError }: {
  col: ColumnInfo; value: unknown;
  onCommit: (v: unknown, next?: 1 | -1 | 'down') => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const [text, setText] = useState(editText(value));
  const [isNull, setIsNull] = useState(value === null);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => { ref.current?.focus(); if (ref.current && 'select' in ref.current && ref.current.tagName === 'INPUT') ref.current.select(); }, []);

  function commit(next?: 1 | -1 | 'down') {
    if (isNull) { onCommit(null, next); return; }
    try { onCommit(parseInput(text, col), next); } catch (e) { onError((e as Error).message); }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit('down'); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };

  if (isBoolColumn(col)) {
    return (
      <select ref={ref} value={value === null ? '' : String(Number(value) ? 1 : 0)} onKeyDown={onKey} onBlur={() => onCancel()}
        onChange={(e) => onCommit(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">NULL</option><option value="1">true (1)</option><option value="0">false (0)</option>
      </select>
    );
  }
  const a = affinity(col);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <input ref={ref} value={isNull ? '' : text} placeholder={isNull ? 'NULL' : ''}
        inputMode={a === 'INTEGER' ? 'numeric' : a === 'REAL' ? 'decimal' : undefined}
        onChange={(e) => { setIsNull(false); setText(e.target.value); }}
        onKeyDown={onKey} onBlur={() => commit()} />
      {!col.notNull && !col.pk && (
        <button type="button" className="btn sm ghost" style={{ minHeight: 0, borderRadius: 0, border: 0 }} title="NULL 로 설정"
          onMouseDown={(e) => { e.preventDefault(); onCommit(null); }}>NULL</button>
      )}
    </div>
  );
}
