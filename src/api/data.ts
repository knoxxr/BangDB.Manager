/** Helpers for exporting and importing documents (pure, unit-tested). */

export function toCsv(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

/**
 * Parse pasted text as a JSON array, a single JSON object, or JSON Lines.
 * Returns the documents or throws with a line-aware message.
 */
export function parseDocuments(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error('JSON 배열이 아닙니다');
    return arr.map(asDoc);
  }
  if (t.startsWith('{')) {
    try {
      return [asDoc(JSON.parse(t))];
    } catch {
      /* fall through to JSONL */
    }
  }
  return t.split(/\r?\n/).map((line, i) => {
    const l = line.trim();
    if (!l) return null;
    try {
      return asDoc(JSON.parse(l));
    } catch (e) {
      throw new Error(`${i + 1}번째 줄: ${(e as Error).message}`);
    }
  }).filter((d): d is Record<string, unknown> => d !== null);
}

function asDoc(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('객체가 아닌 항목이 있습니다');
  return v as Record<string, unknown>;
}

/** Parse CSV (RFC 4180: quoted fields, doubled quotes, CRLF) into rows of fields. */
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') {
        if (t[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += ch;
    } else if (ch === '"' && f === '') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** CSV with a header row → documents; empty fields become null when `emptyAsNull`. */
export function csvToDocs(text: string, opts: { sep?: string; emptyAsNull?: boolean } = {}): Record<string, unknown>[] {
  const sep = opts.sep ?? (/\t/.test(text.split(/\r?\n/, 1)[0] ?? '') ? '\t' : ',');
  const [head, ...rows] = parseCsv(text, sep);
  if (!head) return [];
  const cols = head.map((h) => h.trim());
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      if (!c) return;
      const v = r[i] ?? '';
      o[c] = v === '' && opts.emptyAsNull !== false ? null : v;
    });
    return o;
  });
}

/** Primary key of a document as BangDB returns it. */
export function docKey(doc: Record<string, unknown>): string | undefined {
  const v = doc._pk ?? doc.pk ?? doc.key ?? doc._id;
  return v === undefined || v === null ? undefined : String(v);
}

export function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
