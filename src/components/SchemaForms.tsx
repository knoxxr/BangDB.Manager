import { useState } from 'react';
import { addColumnSql, createIndexSql, createTableSql, createViewSql, qi } from '../api/goapi';
import type { ColumnInfo, CreateTableSpec, GoTableInfo, StorageSpec } from '../api/types';
import { Field, Modal, useToast } from './ui';

/** Declared types offered by the builders; the engine maps each to a storage class. */
export const COLUMN_TYPES: { decl: string; hint: string }[] = [
  { decl: 'INTEGER', hint: '정수 (int64)' },
  { decl: 'TEXT', hint: '문자열' },
  { decl: 'REAL', hint: '실수 (float64)' },
  { decl: 'BOOLEAN', hint: '참/거짓 (1/0)' },
  { decl: 'JSON', hint: 'JSON 문서 (TEXT)' },
  { decl: 'TIMESTAMP', hint: '날짜·시간 (TEXT)' },
  { decl: 'DATE', hint: '날짜 (TEXT)' },
  { decl: 'VARCHAR(255)', hint: '문자열' },
  { decl: 'NUMERIC', hint: '숫자 (REAL)' },
  { decl: 'UUID', hint: 'UUID (TEXT)' },
  { decl: 'BLOB', hint: '바이너리' },
  { decl: '', hint: 'ANY (변환 없음)' }
];

const BASE: CreateTableSpec = { table_name: '', table_type: 'NORMAL_TABLE', key_type: 'NORMAL_KEY', key_sz: 0, allow_duplicate: false, allow_rev_idx: false, version_type: 0 };

export function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = COLUMN_TYPES.some((t) => t.decl === value);
  const [custom, setCustom] = useState(!known);
  if (custom) {
    return (
      <div className="row" style={{ gap: 4 }}>
        <input className="inp mono grow" value={value} placeholder="예: VARCHAR(40)" onChange={(e) => onChange(e.target.value)} />
        <button className="btn sm ghost" onClick={() => { setCustom(false); onChange('TEXT'); }} title="목록에서 선택">▾</button>
      </div>
    );
  }
  return (
    <select className="inp" value={value} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}>
      {COLUMN_TYPES.map((t) => <option key={t.decl} value={t.decl}>{t.decl || 'ANY'} — {t.hint}</option>)}
      <option value="__custom">직접 입력…</option>
    </select>
  );
}

type ColDraft = ColumnInfo & { id: number; open?: boolean };
let seq = 10;

/** CREATE TABLE builder: columns with every constraint the engine supports, storage options and raw SQL. */
export function CreateTableModal({ tables, onClose, onCreate }: { tables: GoTableInfo[]; onClose: () => void; onCreate: (sql: string, name: string) => Promise<boolean> }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [cols, setCols] = useState<ColDraft[]>([
    { id: 1, name: 'id', decl: 'INTEGER', pk: true },
    { id: 2, name: 'name', decl: 'TEXT', notNull: true },
    { id: 3, name: 'created_at', decl: 'TIMESTAMP', default: 'CURRENT_TIMESTAMP' }
  ]);
  const [storage, setStorage] = useState<StorageSpec>({ using: '' });
  const [ifNotExists, setIfNotExists] = useState(false);
  const [checks, setChecks] = useState('');
  const [uniques, setUniques] = useState('');
  const [rawSql, setRawSql] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const up = (id: number, p: Partial<ColDraft>) => setCols((l) => l.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const moveCol = (id: number, d: -1 | 1) => setCols((l) => {
    const i = l.findIndex((c) => c.id === id); const j = i + d;
    if (j < 0 || j >= l.length) return l;
    const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const ts = storage.using === 'timeseries';
  const intCols = cols.filter((c) => c.name.trim() && /INT/i.test(c.decl ?? ''));

  let preview = '';
  let err = '';
  try {
    preview = createTableSql({
      ...BASE, table_name: name, ifNotExists, storage, columns: cols,
      checks: checks.split('\n').map((s) => s.trim()).filter(Boolean),
      uniques: uniques.split('\n').map((l) => l.split(',').map((s) => s.trim()).filter(Boolean)).filter((u) => u.length)
    });
  } catch (e) { err = (e as Error).message; }

  const tableNames = tables.filter((t) => t.kind === 'table').map((t) => t.name);

  return (
    <Modal title="테이블 만들기" onClose={onClose} wide>
      <div className="grid2">
        <Field label="테이블 이름"><input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="예: users" /></Field>
        <Field label="저장 방식">
          <select value={storage.using} onChange={(e) => setStorage({ ...storage, using: e.target.value as StorageSpec['using'] })}>
            <option value="">기본 (B+트리, 디스크)</option>
            <option value="memory">인메모리 (USING memory)</option>
            <option value="timeseries">시계열 (USING timeseries)</option>
          </select>
        </Field>
      </div>
      {storage.using === 'memory' && (
        <div className="card" style={{ padding: 10 }}>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={!!storage.persist} onChange={(e) => setStorage({ ...storage, persist: e.target.checked })} /> 정상 종료 시 저장 후 다음 시작 때 복원 (persist = true)</label>
          <p className="muted small" style={{ margin: '6px 0 0' }}>인메모리 테이블의 데이터는 프로세스가 살아 있는 동안만 유지되며 백업·복제 대상이 아닙니다.</p>
        </div>
      )}
      {ts && (
        <div className="card" style={{ padding: 10 }}>
          <div className="grid2">
            <Field label="시간 컬럼 (INTEGER epoch, 필수)">
              <select value={storage.timeColumn ?? ''} onChange={(e) => setStorage({ ...storage, timeColumn: e.target.value })}>
                <option value="">선택…</option>
                {intCols.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="시간 단위">
              <select value={storage.timeUnit ?? 's'} onChange={(e) => setStorage({ ...storage, timeUnit: e.target.value as StorageSpec['timeUnit'] })}>
                <option value="s">초 (s)</option><option value="ms">밀리초 (ms)</option><option value="us">마이크로초 (us)</option>
              </select>
            </Field>
            <Field label="보존 기간 (선택)"><input value={storage.retention ?? ''} placeholder="예: 30 days" onChange={(e) => setStorage({ ...storage, retention: e.target.value })} /></Field>
            <Field label="블록 행 수 (선택, 기본 1024)"><input type="number" min={1} value={storage.blockRows ?? ''} onChange={(e) => setStorage({ ...storage, blockRows: Number(e.target.value) || undefined })} /></Field>
          </div>
          <p className="muted small" style={{ margin: 0 }}>시계열 테이블에는 PRIMARY KEY·UNIQUE·보조 인덱스를 둘 수 없습니다.</p>
        </div>
      )}

      {rawSql === null ? (
        <>
          <div className="row" style={{ margin: '4px 0 8px' }}><b className="grow">컬럼</b><span className="muted small">PK 를 여러 개 고르면 복합 기본 키가 됩니다</span></div>
          {cols.map((c, i) => (
            <div key={c.id} className="builder-col">
              <input className="inp mono" placeholder="컬럼 이름" value={c.name} onChange={(e) => up(c.id, { name: e.target.value })} />
              <TypeSelect value={c.decl ?? ''} onChange={(v) => up(c.id, { decl: v })} />
              <div className="row" style={{ gap: 2 }}>
                <button className="btn sm ghost" disabled={i === 0} onClick={() => moveCol(c.id, -1)} title="위로">↑</button>
                <button className="btn sm ghost" disabled={i === cols.length - 1} onClick={() => moveCol(c.id, 1)} title="아래로">↓</button>
              </div>
              <button className="btn sm ghost" onClick={() => setCols((l) => l.filter((x) => x.id !== c.id))} aria-label="컬럼 삭제" title="삭제">✕</button>
              <div className="flags">
                {!ts && <label><input type="checkbox" checked={!!c.pk} onChange={(e) => up(c.id, { pk: e.target.checked })} />PRIMARY KEY</label>}
                {!ts && c.pk && /^INT/i.test(c.decl ?? '') && <label title="삭제된 번호를 재사용하지 않음"><input type="checkbox" checked={!!c.autoinc} onChange={(e) => up(c.id, { autoinc: e.target.checked })} />AUTOINCREMENT</label>}
                <label><input type="checkbox" checked={!!c.notNull} onChange={(e) => up(c.id, { notNull: e.target.checked })} />NOT NULL</label>
                {!ts && <label><input type="checkbox" checked={!!c.unique} onChange={(e) => up(c.id, { unique: e.target.checked })} />UNIQUE</label>}
                <a href="#" onClick={(e) => { e.preventDefault(); up(c.id, { open: !c.open }); }}>{c.open ? '접기' : '기본값·CHECK·외래 키…'}</a>
                {!c.open && [c.default && `DEFAULT ${c.default}`, c.collate && `COLLATE ${c.collate}`, c.check && `CHECK`, c.refTable && `→ ${c.refTable}`].filter(Boolean).map((t) => <span key={String(t)} className="badge">{t}</span>)}
              </div>
              {c.open && (
                <div className="more">
                  <input className="inp mono" placeholder="DEFAULT (예: 0, 'a', CURRENT_TIMESTAMP)" value={c.default ?? ''} onChange={(e) => up(c.id, { default: e.target.value })} />
                  <select className="inp" value={c.collate ?? ''} onChange={(e) => up(c.id, { collate: e.target.value })}>
                    <option value="">정렬 규칙: BINARY</option><option value="NOCASE">NOCASE (대소문자 무시)</option><option value="RTRIM">RTRIM (끝 공백 무시)</option>
                  </select>
                  <input className="inp mono" placeholder="CHECK (예: age >= 0)" value={c.check ?? ''} onChange={(e) => up(c.id, { check: e.target.value })} />
                  <select className="inp" value={c.refTable ?? ''} onChange={(e) => up(c.id, { refTable: e.target.value, refColumn: '' })}>
                    <option value="">외래 키: 없음</option>
                    {tableNames.map((t) => <option key={t} value={t}>REFERENCES {t}</option>)}
                  </select>
                  {c.refTable && (
                    <>
                      <select className="inp" value={c.refColumn ?? ''} onChange={(e) => up(c.id, { refColumn: e.target.value })}>
                        <option value="">참조 컬럼: 기본 키</option>
                        {(tables.find((t) => t.name === c.refTable)?.columns ?? []).map((rc) => <option key={rc.name} value={rc.name}>{rc.name}</option>)}
                      </select>
                      <select className="inp" value={c.onDelete ?? ''} onChange={(e) => up(c.id, { onDelete: e.target.value })}>
                        <option value="">삭제 시: 막기 (NO ACTION)</option><option value="CASCADE">삭제 시: CASCADE</option><option value="SET NULL">삭제 시: SET NULL</option><option value="RESTRICT">삭제 시: RESTRICT</option>
                      </select>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="row wrap" style={{ margin: '8px 0' }}>
            <button className="btn sm" onClick={() => setCols((l) => [...l, { id: ++seq, name: '', decl: 'TEXT', open: false }])}>+ 컬럼</button>
            <button className="btn sm ghost" onClick={() => setRawSql(preview || `CREATE TABLE ${qi(name || 'new_table')} (\n  id INTEGER PRIMARY KEY\n)`)}>SQL 직접 편집</button>
          </div>
          <details className="adv">
            <summary>테이블 제약 (복합 UNIQUE, CHECK) · IF NOT EXISTS</summary>
            <Field label="UNIQUE (컬럼, 컬럼) — 한 줄에 하나"><textarea className="mono" rows={2} style={{ minHeight: 0 }} value={uniques} placeholder="dept_id, email" onChange={(e) => setUniques(e.target.value)} /></Field>
            <Field label="CHECK 식 — 한 줄에 하나"><textarea className="mono" rows={2} style={{ minHeight: 0 }} value={checks} placeholder="start_at < end_at" onChange={(e) => setChecks(e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={ifNotExists} onChange={(e) => setIfNotExists(e.target.checked)} /> IF NOT EXISTS</label>
          </details>
          <div className="muted small" style={{ marginBottom: 4 }}>미리보기</div>
          <pre className="out">{err ? `-- ${err}` : preview}</pre>
        </>
      ) : (
        <Field label="CREATE TABLE SQL"><textarea className="mono" rows={12} value={rawSql} spellCheck={false} onChange={(e) => setRawSql(e.target.value)} /></Field>
      )}
      <div className="actions">
        {rawSql !== null && <button className="btn ghost" onClick={() => setRawSql(null)}>빌더로 돌아가기</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || (rawSql === null ? !!err : !rawSql.trim())} onClick={async () => {
          const sql = rawSql ?? preview;
          const n = rawSql !== null ? (/TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)([^"\s(]+)\1/i.exec(rawSql)?.[2] ?? '') : name.trim();
          setBusy(true);
          try { if (await onCreate(sql, n)) onClose(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
        }}>만들기</button>
      </div>
    </Modal>
  );
}

/**
 * ALTER TABLE ADD COLUMN. The engine accepts NOT NULL (with a non-NULL
 * DEFAULT), DEFAULT and COLLATE here; UNIQUE is offered as a unique index
 * created right after.
 */
export function AddColumnModal({ table, onClose, onAdd }: { table: string; onClose: () => void; onAdd: (sqls: string[]) => Promise<boolean> }) {
  const [c, setC] = useState<ColumnInfo>({ name: '', decl: 'TEXT' });
  const [uniqueIdx, setUniqueIdx] = useState(false);
  const [busy, setBusy] = useState(false);
  const up = (p: Partial<ColumnInfo>) => setC((x) => ({ ...x, ...p }));
  const needDefault = c.notNull && !c.default?.trim();
  const sqls = c.name.trim() ? [addColumnSql(table, c), ...(uniqueIdx ? [createIndexSql(table, [c.name.trim()], { unique: true })] : [])] : [];
  return (
    <Modal title={`컬럼 추가 — ${table}`} onClose={onClose}>
      <div className="grid2">
        <Field label="컬럼 이름"><input className="mono" autoFocus value={c.name} onChange={(e) => up({ name: e.target.value })} /></Field>
        <Field label="타입"><TypeSelect value={c.decl ?? ''} onChange={(v) => up({ decl: v })} /></Field>
        <Field label="DEFAULT (선택)"><input className="mono" value={c.default ?? ''} placeholder="예: 0, 'none', CURRENT_TIMESTAMP" onChange={(e) => up({ default: e.target.value })} /></Field>
        <Field label="정렬 규칙">
          <select value={c.collate ?? ''} onChange={(e) => up({ collate: e.target.value })}>
            <option value="">BINARY</option><option value="NOCASE">NOCASE</option><option value="RTRIM">RTRIM</option>
          </select>
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={!!c.notNull} onChange={(e) => up({ notNull: e.target.checked })} /> NOT NULL {needDefault && <span className="warn small">— 기존 행을 채울 DEFAULT 가 필요합니다</span>}</label>
      <label className="check"><input type="checkbox" checked={uniqueIdx} onChange={(e) => setUniqueIdx(e.target.checked)} /> 값 중복 금지 (UNIQUE 인덱스 함께 생성)</label>
      <p className="muted small">기존 행에는 DEFAULT 값(없으면 NULL)이 채워집니다. PRIMARY KEY · CHECK · 외래 키가 있는 컬럼은 ALTER 로 추가할 수 없어, 필요하면 새 테이블을 만들어 옮겨야 합니다.</p>
      {sqls.length > 0 && <pre className="out">{sqls.join(';\n')};</pre>}
      <div className="actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !c.name.trim() || needDefault} onClick={async () => { setBusy(true); try { if (await onAdd(sqls)) onClose(); } finally { setBusy(false); } }}>추가</button>
      </div>
    </Modal>
  );
}

export function CreateViewModal({ initialName = '', initialSelect = '', replace, onClose, onCreate, onPreview }: {
  initialName?: string; initialSelect?: string; replace?: boolean;
  onClose: () => void; onCreate: (sql: string, name: string) => Promise<boolean>; onPreview: (select: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [select, setSelect] = useState(initialSelect || 'SELECT * FROM ');
  const [busy, setBusy] = useState(false);
  const sql = name.trim() && select.trim() ? createViewSql(name.trim(), select) : '';
  return (
    <Modal title={replace ? `뷰 수정 — ${initialName}` : '뷰 만들기'} onClose={onClose} wide>
      <Field label="뷰 이름"><input className="mono" value={name} disabled={replace} autoFocus={!replace} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="SELECT 문"><textarea className="mono" rows={8} value={select} spellCheck={false} onChange={(e) => setSelect(e.target.value)} /></Field>
      {replace && <p className="muted small">BangDB 는 뷰 변경 문장이 없어 DROP VIEW 후 CREATE VIEW 를 한 트랜잭션으로 실행합니다.</p>}
      <div className="actions">
        <button className="btn ghost" disabled={!select.trim()} onClick={() => onPreview(select)}>미리보기</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !sql} onClick={async () => { setBusy(true); try { if (await onCreate(sql, name.trim())) onClose(); } finally { setBusy(false); } }}>{replace ? '저장' : '만들기'}</button>
      </div>
    </Modal>
  );
}

/** Pick index columns in order, name it, choose UNIQUE. */
export function CreateIndexForm({ table, columns, onCreate }: { table: string; columns: ColumnInfo[]; onCreate: (sql: string) => Promise<boolean> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sql = picked.length ? createIndexSql(table, picked, { name, unique }) : '';
  return (
    <div className="card">
      <b>인덱스 만들기</b>
      <div className="muted small" style={{ margin: '8px 0 6px' }}>컬럼을 순서대로 누르세요 (복합 인덱스는 앞 컬럼부터 사용됩니다)</div>
      <div className="chips" style={{ marginBottom: 10 }}>
        {columns.map((c) => {
          const i = picked.indexOf(c.name);
          return (
            <span key={c.name} className={`chip ${i >= 0 ? 'on' : ''}`} onClick={() => setPicked((l) => (i >= 0 ? l.filter((x) => x !== c.name) : [...l, c.name]))}>
              {i >= 0 && <span className="n">{i + 1}</span>}{c.name}
            </span>
          );
        })}
      </div>
      <div className="row wrap">
        <input className="inp mono grow" placeholder={picked.length ? `이름 (기본: idx_${table}_${picked.join('_')})` : '인덱스 이름 (선택)'} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> UNIQUE</label>
        <button className="btn primary sm" disabled={busy || !sql} onClick={async () => {
          setBusy(true);
          try { if (await onCreate(sql)) { setPicked([]); setName(''); setUnique(false); } } finally { setBusy(false); }
        }}>CREATE INDEX</button>
      </div>
      {sql && <pre className="out" style={{ marginTop: 8 }}>{sql}</pre>}
    </div>
  );
}
