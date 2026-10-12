import { describe, expect, it } from 'vitest';
import { buildErdDiagram, erdPlainText } from './erdDiagram.js';
import { focusErd, type ErdColumn, type ErdData, type ErdRelation } from '../db/erd.js';

const palette = { tables: ['#d75f87', '#5faf5f'], border: '#767676', pk: '#d7af87', muted: '#9e9e9e' };

const col = (name: string, o: Partial<ErdColumn> = {}): ErdColumn => ({
  name,
  type: 'int4',
  isPk: false,
  nullable: false,
  isUnique: false,
  ...o,
});
const id = () => col('id', { isPk: true, isUnique: true });

function rel(table: string, column: string, refTable: string, o: Partial<ErdRelation> = {}): ErdRelation {
  return { name: `${table}_${column}_fkey`, table, columns: [column], refTable, refColumns: ['id'], optional: false, unique: false, ...o };
}

const books: ErdData = {
  tables: [
    { name: 'author', columns: [id(), col('name', { type: 'text' })] },
    { name: 'publisher', columns: [id()] },
    { name: 'translator', columns: [id()] },
    {
      name: 'book',
      columns: [
        id(),
        col('author_id', { fkTable: 'author' }),
        col('publisher_id', { fkTable: 'publisher' }),
        col('translator_id', { fkTable: 'translator', nullable: true }),
      ],
    },
    { name: 'rating', columns: [id(), col('book_id', { fkTable: 'book' })] },
  ],
  relations: [
    rel('book', 'author_id', 'author'),
    rel('book', 'publisher_id', 'publisher'),
    rel('book', 'translator_id', 'translator', { optional: true }),
    rel('rating', 'book_id', 'book'),
  ],
};

const rows = (text: string) => text.split('\n');
const rowOf = (text: string, needle: string) => rows(text).findIndex((l) => l.includes(needle));

describe('buildErdDiagram', () => {
  it('routes every relationship and places parents above children', () => {
    const d = buildErdDiagram(books, 100, palette);
    const text = erdPlainText(d);
    expect(d.unrouted).toEqual([]);
    expect(rowOf(text, 'author')).toBeLessThan(rowOf(text, '│ book '));
    expect(rowOf(text, '│ book ')).toBeLessThan(rowOf(text, '│ rating'));
  });

  it("draws crow's-foot markers for each cardinality", () => {
    const text = erdPlainText(buildErdDiagram(books, 100, palette));
    // Every child end is "zero or many"; the optional translator FK gives one "zero or one" parent end.
    expect(text.match(/╱│╲/g)).toHaveLength(4);
    expect(text.match(/○/g)).toHaveLength(5);
    const lines = rows(text);
    const translatorBottom = rowOf(text, '╰') + 2;
    expect(lines[translatorBottom]).toContain('○');
  });

  it('labels edges with the foreign key column', () => {
    const text = erdPlainText(buildErdDiagram(books, 100, palette));
    for (const label of ['author_id', 'publisher_id', 'translator_id', 'book_id']) {
      expect(text.split(label).length).toBeGreaterThan(2); // box row + edge label
    }
  });

  it('marks one-to-one relationships with a bar instead of a foot', () => {
    const data: ErdData = {
      tables: [
        { name: 'users', columns: [id()] },
        { name: 'profiles', columns: [id(), col('user_id', { fkTable: 'users', isUnique: true })] },
      ],
      relations: [rel('profiles', 'user_id', 'users', { unique: true })],
    };
    const text = erdPlainText(buildErdDiagram(data, 80, palette));
    expect(text).not.toContain('╱│╲');
    expect(text.match(/┼/g)).toHaveLength(3);
  });

  it('never exceeds the requested width', () => {
    const tables = Array.from({ length: 14 }, (_, i) => ({
      name: `table_${i}`,
      columns: [id(), col('created_at', { type: 'timestamptz' }), ...(i > 0 ? [col('parent_id', { fkTable: 'table_0' })] : [])],
    }));
    const relations = tables.slice(1).map((t) => rel(t.name, 'parent_id', 'table_0'));
    for (const width of [60, 80, 120]) {
      const d = buildErdDiagram({ tables, relations }, width, palette);
      const longest = Math.max(...rows(erdPlainText(d)).map((l) => [...l].length));
      expect(longest).toBeLessThanOrEqual(width);
      expect(d.unrouted).toEqual([]);
    }
  });

  it('handles self references and cycles', () => {
    const data: ErdData = {
      tables: [
        { name: 'employees', columns: [id(), col('manager_id', { fkTable: 'employees', nullable: true })] },
        { name: 'a', columns: [id(), col('b_id', { fkTable: 'b' })] },
        { name: 'b', columns: [id(), col('a_id', { fkTable: 'a', nullable: true })] },
      ],
      relations: [
        rel('employees', 'manager_id', 'employees', { optional: true }),
        rel('a', 'b_id', 'b'),
        rel('b', 'a_id', 'a', { optional: true }),
      ],
    };
    const d = buildErdDiagram(data, 100, palette);
    expect(d.unrouted).toEqual([]);
    expect(erdPlainText(d)).toContain('employees');
  });

  it('lays out tables without relationships after the connected ones', () => {
    const data: ErdData = { ...books, tables: [...books.tables, { name: 'migrations', columns: [id()] }] };
    const text = erdPlainText(buildErdDiagram(data, 100, palette));
    expect(rowOf(text, 'migrations')).toBeGreaterThan(rowOf(text, '│ rating'));
  });
});

describe('focusErd', () => {
  it('keeps the table and its direct neighbours', () => {
    const focused = focusErd(books, 'BOOK');
    expect(focused?.tables.map((t) => t.name).sort()).toEqual(['author', 'book', 'publisher', 'rating', 'translator']);
    expect(focusErd(books, 'rating')?.tables.map((t) => t.name).sort()).toEqual(['book', 'rating']);
    expect(focusErd(books, 'nope')).toBeNull();
  });
});
