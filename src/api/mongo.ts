/**
 * MongoDB through the gateway (proxy/gateway/mongo.mjs). Documents are
 * relaxed Extended JSON: ObjectId as {"$oid"}, dates as {"$date"}, etc.
 */
import { gw } from './gateway';
import type { Connection } from './types';

export type Doc = Record<string, unknown>;

export const mongo = <T = unknown>(c: Connection, op: string, body: Record<string, unknown> = {}) => gw<T>(c, `mongo/${op}`, body);

export interface CollectionInfo { name: string; type: string; count: number | null; options: Doc }
export interface IndexInfo { name: string; key: Doc; unique?: boolean; sparse?: boolean; expireAfterSeconds?: number; v?: number; [k: string]: unknown }

/** Parse a JSON filter / sort / pipeline typed by the user; empty → fallback. */
export function parseJson<T>(text: string, fallback: T): T {
  const t = text.trim();
  if (!t) return fallback;
  return JSON.parse(t) as T;
}

/** Short display of an Extended JSON value in a grid cell. */
export function ejsonText(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v !== 'object') return String(v);
  const o = v as Doc;
  if (typeof o.$oid === 'string') return o.$oid;
  if (o.$date !== undefined) return typeof o.$date === 'string' ? o.$date : JSON.stringify(o.$date);
  if (o.$numberDecimal !== undefined) return String(o.$numberDecimal);
  if (o.$numberLong !== undefined) return String(o.$numberLong);
  if (o.$binary !== undefined) return 'Binary';
  return JSON.stringify(v);
}

/** BSON-ish type name of an Extended JSON value, for the schema summary. */
export function ejsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v !== 'object') return typeof v;
  const o = v as Doc;
  if ('$oid' in o) return 'objectId';
  if ('$date' in o) return 'date';
  if ('$numberDecimal' in o) return 'decimal';
  if ('$numberLong' in o) return 'long';
  if ('$binary' in o) return 'binary';
  return 'object';
}

/** Field → type counts over sample documents (top level). */
export function schemaOf(docs: Doc[]): { field: string; types: Record<string, number>; present: number }[] {
  const m = new Map<string, { types: Record<string, number>; present: number }>();
  for (const d of docs) for (const [k, v] of Object.entries(d)) {
    const e = m.get(k) ?? { types: {}, present: 0 };
    const t = ejsonType(v);
    e.types[t] = (e.types[t] ?? 0) + 1;
    e.present++;
    m.set(k, e);
  }
  return [...m.entries()].map(([field, e]) => ({ field, ...e }));
}
