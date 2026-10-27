import { useState } from 'react';
import { affinity, editText, isBlob, isBoolColumn, isJsonColumn, parseInput } from '../api/goapi';
import type { ColumnInfo } from '../api/types';
import { Modal, useConfirm, useToast } from './ui';

type Mode = 'default' | 'null' | 'value';
interface FieldState { mode: Mode; text: string; blob?: string }

/**
 * Form for one row. New rows start with every field on "default" (left out
 * of the INSERT, so DEFAULT / auto-increment apply); edits send only the
 * fields that changed.
 */
export function RowForm({ columns, values, isNew, readOnly, title, onClose, onSubmit, onDelete, onDuplicate }: {
  columns: ColumnInfo[];
  values: Record<string, unknown>;
  isNew: boolean;
  readOnly?: boolean;
  title: string;
  onClose: () => void;
  onSubmit?: (values: Record<string, unknown>) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onDuplicate?: (values: Record<string, unknown>) => void;
}) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, FieldState>>(() => {
    const o: Record<string, FieldState> = {};
    for (const c of columns) {
      const has = c.name in values;
      const v = values[c.name];
      o[c.name] = isNew && !has
        ? { mode: 'default', text: '' }
        : v === null || v === undefined ? { mode: 'null', text: '' }
        : isBlob(v) ? { mode: 'value', text: '', blob: v.blob }
        : { mode: 'value', text: pretty(c, editText(v)) };
    }
    return o;
  });
  const set = (name: string, p: Partial<FieldState>) => setF((x) => ({ ...x, [name]: { ...x[name], ...p } }));

  function collect(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const c of columns) {
      const s = f[c.name];
      if (s.mode === 'default') continue;
      let v: unknown;
      if (s.mode === 'null') v = null;
      else if (s.blob !== undefined) v = { blob: s.blob };
      else if (isJsonColumn(c) && s.text.trim()) {
        try { v = JSON.stringify(JSON.parse(s.text)); } catch (e) { toast(`${c.name}: JSON 형식 오류 — ${(e as Error).message}`, 'err'); return null; }
      } else {
        try { v = parseInput(s.text, c); } catch (e) { toast((e as Error).message, 'err'); return null; }
      }
      if (!isNew && same(v, values[c.name])) continue;
      out[c.name] = v;
    }
    return out;
  }

  async function submit() {
    const v = collect();
    if (!v || !onSubmit) return;
    if (!Object.keys(v).length) { toast(isNew ? '값을 하나 이상 입력하세요' : '변경된 값이 없습니다', 'err'); return; }
    setBusy(true);
    try { if (await onSubmit(v)) onClose(); } finally { setBusy(false); }
  }

  async function pickFile(name: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    set(name, { mode: 'value', blob: btoa(bin), text: '' });
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      {columns.map((c) => {
        const s = f[c.name];
        const a = affinity(c);
        const auto = c.pk && a === 'INTEGER';
        const long = isJsonColumn(c) || s.text.length > 60 || s.text.includes('\n');
        return (
          <div key={c.name} className="formrow">
            <div className="lbl">
              {c.pk && <span className="pk-ico">🔑</span>}{c.name}
              <span className="ctype">{[c.decl || c.type || 'ANY', c.notNull ? 'NOT NULL' : '', c.unique ? 'UNIQUE' : '', c.default ? `DEFAULT ${c.default}` : ''].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="ctl">
              {a === 'BLOB' || s.blob !== undefined ? (
                <div className="row wrap">
                  <span className="small muted">{s.blob !== undefined ? `${Math.floor((s.blob.length * 3) / 4)} 바이트` : s.mode === 'null' ? 'NULL' : '비어 있음'}</span>
                  {!readOnly && <label className="btn sm">파일 선택<input type="file" style={{ display: 'none' }} onChange={(e) => pickFile(c.name, e)} /></label>}
                  {s.blob !== undefined && <button className="btn sm ghost" onClick={() => download(c.name, s.blob!)}>다운로드</button>}
                </div>
              ) : isBoolColumn(c) ? (
                <select className="inp" disabled={readOnly} value={s.mode === 'value' ? (Number(s.text) ? '1' : '0') : s.mode}
                  onChange={(e) => { const v = e.target.value; set(c.name, v === 'null' || v === 'default' ? { mode: v } : { mode: 'value', text: v }); }}>
                  {isNew && <option value="default">기본값</option>}
                  {!c.notNull && !c.pk && <option value="null">NULL</option>}
                  <option value="1">true (1)</option><option value="0">false (0)</option>
                </select>
              ) : long ? (
                <textarea className="inp mono" rows={isJsonColumn(c) ? 6 : 3} readOnly={readOnly} value={s.text}
                  placeholder={s.mode === 'default' ? placeholder(c, auto) : s.mode === 'null' ? 'NULL' : ''}
                  onChange={(e) => set(c.name, { mode: 'value', text: e.target.value })} spellCheck={false} />
              ) : (
                <input className="inp mono" readOnly={readOnly} value={s.text}
                  inputMode={a === 'INTEGER' ? 'numeric' : a === 'REAL' ? 'decimal' : undefined}
                  placeholder={s.mode === 'default' ? placeholder(c, auto) : s.mode === 'null' ? 'NULL' : ''}
                  onChange={(e) => set(c.name, { mode: 'value', text: e.target.value })} />
              )}
              {!readOnly && (
                <div className="opts">
                  {isNew && <label><input type="checkbox" checked={s.mode === 'default'} onChange={(e) => set(c.name, { mode: e.target.checked ? 'default' : 'value' })} />{auto ? '자동 번호' : '기본값'}</label>}
                  {!c.notNull && !c.pk && <label><input type="checkbox" checked={s.mode === 'null'} onChange={(e) => set(c.name, { mode: e.target.checked ? 'null' : 'value', blob: undefined })} />NULL</label>}
                  {isJsonColumn(c) && s.mode === 'value' && <a href="#" onClick={(e) => { e.preventDefault(); try { set(c.name, { text: JSON.stringify(JSON.parse(s.text), null, 2) }); } catch (er) { toast(`JSON 오류: ${(er as Error).message}`, 'err'); } }}>정렬</a>}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="actions">
        {onDelete && (
          <button className="btn danger" disabled={busy} onClick={async () => {
            if (!(await confirm('이 행을 삭제할까요?'))) return;
            setBusy(true); try { if (await onDelete()) onClose(); } finally { setBusy(false); }
          }}>삭제</button>
        )}
        {onDuplicate && <button className="btn ghost" onClick={() => { const v = collectAll(columns, f); if (v) onDuplicate(v); }}>복제</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>{readOnly ? '닫기' : '취소'}</button>
        {!readOnly && onSubmit && <button className="btn primary" disabled={busy} onClick={submit}>{isNew ? '추가 (INSERT)' : '저장 (UPDATE)'}</button>}
      </div>
      {confirmEl}
    </Modal>
  );
}

const placeholder = (c: ColumnInfo, auto?: boolean) => (auto ? '(자동 번호)' : c.default ? `(기본값 ${c.default})` : '(기본값: NULL)');
const pretty = (c: ColumnInfo, t: string) => {
  if (!isJsonColumn(c) || !t) return t;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
};
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Values for "duplicate as new row": everything except auto-numbered keys. */
function collectAll(columns: ColumnInfo[], f: Record<string, FieldState>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const s = f[c.name];
    if (s.mode === 'default' || (c.pk && affinity(c) === 'INTEGER')) continue;
    out[c.name] = s.mode === 'null' ? null : s.blob !== undefined ? { blob: s.blob } : (() => { try { return parseInput(s.text, c); } catch { return s.text; } })();
  }
  return out;
}

function download(name: string, b64: string) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([buf]));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.bin`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
