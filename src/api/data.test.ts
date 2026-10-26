import { describe, expect, it } from 'vitest';
import { docKey, parseDocuments, toCsv } from './data';

describe('toCsv', () => {
  it('unions columns and escapes', () => {
    const csv = toCsv([{ a: 1, b: 'x,y' }, { b: 'q"r', c: { n: 1 } }]);
    expect(csv.split('\r\n')).toEqual(['a,b,c', '1,"x,y",', ',"q""r","{""n"":1}"']);
  });
});

describe('parseDocuments', () => {
  it('parses an array', () => expect(parseDocuments('[{"_pk":"a"},{"_pk":"b"}]')).toHaveLength(2));
  it('parses a single object', () => expect(parseDocuments('{"_pk":"a"}')).toEqual([{ _pk: 'a' }]));
  it('parses JSON lines and skips blanks', () => {
    expect(parseDocuments('{"_pk":"a"}\n\n{"_pk":"b"}\n')).toEqual([{ _pk: 'a' }, { _pk: 'b' }]);
  });
  it('reports the failing line', () => expect(() => parseDocuments('{"_pk":"a"}\n{bad')).toThrow(/2번째 줄/));
  it('rejects non-objects', () => expect(() => parseDocuments('[1]')).toThrow());
  it('empty input', () => expect(parseDocuments('  ')).toEqual([]));
});

describe('docKey', () => {
  it('reads _pk variants', () => {
    expect(docKey({ _pk: 'k' })).toBe('k');
    expect(docKey({ _pk: 7 })).toBe('7');
    expect(docKey({ name: 'x' })).toBeUndefined();
  });
});
