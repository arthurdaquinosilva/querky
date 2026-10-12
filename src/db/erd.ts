import type { DbClient, Driver } from './client.js';

export interface ErdColumn {
  name: string;
  type: string;
  isPk: boolean;
  nullable: boolean;
  isUnique: boolean;
  fkTable?: string;
}

export interface ErdTable {
  name: string;
  columns: ErdColumn[];
}

export interface ErdRelation {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** Child rows may exist without a parent (any FK column nullable) → parent side is "zero or one". */
  optional: boolean;
  /** FK columns are unique → child side is "zero or one" instead of "zero or many". */
  unique: boolean;
}

export interface ErdData {
  tables: ErdTable[];
  relations: ErdRelation[];
}

interface ErdQueries {
  columns: string;
  foreignKeys: string;
  uniques?: string;
}

function erdQueries(driver: Driver): ErdQueries {
  if (driver === 'postgresql') {
    return {
      columns: `
        SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS data_type,
          NOT a.attnotnull AS nullable,
          EXISTS (
            SELECT 1 FROM pg_constraint p
            WHERE p.conrelid = c.oid AND p.contype = 'p' AND a.attnum = ANY (p.conkey)
          ) AS is_pk,
          EXISTS (
            SELECT 1 FROM pg_constraint u
            WHERE u.conrelid = c.oid AND u.contype IN ('p', 'u') AND u.conkey = ARRAY[a.attnum]
          ) AS is_unique
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname, a.attnum
      `,
      foreignKeys: `
        SELECT con.conname AS constraint_name, cl.relname AS table_name, a.attname AS column_name,
          ref.relname AS ref_table, ra.attname AS ref_column
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_class ref ON ref.oid = con.confrelid
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
        WHERE con.contype = 'f' AND n.nspname = 'public'
          AND NOT cl.relispartition AND con.conparentid = 0
        ORDER BY cl.relname, con.conname, k.ord
      `,
    };
  }

  if (driver === 'mysql') {
    return {
      columns: `
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
          (c.IS_NULLABLE = 'YES') AS nullable,
          (c.COLUMN_KEY = 'PRI') AS is_pk,
          (c.COLUMN_KEY = 'UNI') AS is_unique
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
      `,
      foreignKeys: `
        SELECT CONSTRAINT_NAME AS constraint_name, TABLE_NAME AS table_name,
          COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS ref_table,
          REFERENCED_COLUMN_NAME AS ref_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
      `,
    };
  }

  return {
    columns: `
      SELECT m.name AS table_name, p.name AS column_name, p.type AS data_type,
        (p."notnull" = 0 AND p.pk = 0) AS nullable,
        (p.pk > 0) AS is_pk,
        0 AS is_unique
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      ORDER BY m.name, p.cid
    `,
    foreignKeys: `
      SELECT m.name || '#' || f.id AS constraint_name, m.name AS table_name,
        f."from" AS column_name, f."table" AS ref_table, f."to" AS ref_column
      FROM sqlite_master m
      JOIN pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      ORDER BY m.name, f.id, f.seq
    `,
    uniques: `
      SELECT m.name AS table_name, MIN(ii.name) AS column_name
      FROM sqlite_master m
      JOIN pragma_index_list(m.name) il
      JOIN pragma_index_info(il.name) ii
      WHERE m.type = 'table' AND il."unique" = 1
      GROUP BY m.name, il.name
      HAVING COUNT(*) = 1
    `,
  };
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';

export async function fetchErd(client: DbClient, driver: Driver): Promise<ErdData> {
  const queries = erdQueries(driver);
  const [colResult, fkResult, uqResult] = await Promise.all([
    client.query(queries.columns),
    client.query(queries.foreignKeys),
    queries.uniques ? client.query(queries.uniques) : Promise.resolve(null),
  ]);

  const uniqueCols = new Set(
    (uqResult?.rows ?? []).map((r) => `${String(r['table_name'])}.${String(r['column_name'])}`),
  );

  const tableMap = new Map<string, ErdColumn[]>();
  for (const row of colResult.rows) {
    const tableName = String(row['table_name'] ?? '');
    const colName = String(row['column_name'] ?? '');
    let cols = tableMap.get(tableName);
    if (!cols) tableMap.set(tableName, (cols = []));
    if (cols.some((c) => c.name === colName)) continue;
    cols.push({
      name: colName,
      type: String(row['data_type'] ?? '').toLowerCase(),
      isPk: truthy(row['is_pk']),
      nullable: truthy(row['nullable']),
      isUnique: truthy(row['is_unique']) || uniqueCols.has(`${tableName}.${colName}`),
    });
  }

  // A column that is the table's only PK column is unique on its own; composite PK members are not.
  for (const cols of tableMap.values()) {
    const pks = cols.filter((c) => c.isPk);
    if (pks.length === 1) pks[0].isUnique = true;
  }

  const relMap = new Map<string, ErdRelation>();
  for (const row of fkResult.rows) {
    const table = String(row['table_name'] ?? '');
    const key = `${table}\0${String(row['constraint_name'] ?? '')}`;
    let rel = relMap.get(key);
    if (!rel) {
      rel = {
        name: String(row['constraint_name'] ?? ''),
        table,
        columns: [],
        refTable: String(row['ref_table'] ?? ''),
        refColumns: [],
        optional: false,
        unique: false,
      };
      relMap.set(key, rel);
    }
    rel.columns.push(String(row['column_name'] ?? ''));
    rel.refColumns.push(String(row['ref_column'] ?? ''));
  }

  const relations: ErdRelation[] = [];
  for (const rel of relMap.values()) {
    const cols = tableMap.get(rel.table);
    if (!cols) continue;
    const fkCols = rel.columns.map((name) => cols.find((c) => c.name === name));
    rel.optional = fkCols.some((c) => c?.nullable ?? true);
    rel.unique = fkCols.length === 1 && (fkCols[0]?.isUnique ?? false);
    for (const c of fkCols) if (c && !c.fkTable) c.fkTable = rel.refTable;
    relations.push(rel);
  }

  return {
    tables: Array.from(tableMap.entries()).map(([name, columns]) => ({ name, columns })),
    relations,
  };
}

/** Keep only `table` and the tables directly related to it. */
export function focusErd(data: ErdData, table: string): ErdData | null {
  const target = data.tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
  if (!target) return null;
  const relations = data.relations.filter((r) => r.table === target.name || r.refTable === target.name);
  const keep = new Set([target.name, ...relations.flatMap((r) => [r.table, r.refTable])]);
  return { tables: data.tables.filter((t) => keep.has(t.name)), relations };
}
