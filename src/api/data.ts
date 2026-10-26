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
