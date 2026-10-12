import { Client } from 'pg';
import { createConnection } from 'mysql2/promise';
import type { RowDataPacket, FieldPacket, ResultSetHeader } from 'mysql2';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { savePassword } from '../config/keychain.js';

export interface DbResult {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DbClient {
  query(sql: string): Promise<DbResult>;
  end(): Promise<void>;
}

export type Driver = 'postgresql' | 'mysql' | 'sqlite';

export type ConnectionState =
  | { status: 'connected'; client: DbClient; database: string; host: string; user: string; driver: Driver; params: ConnectionParams }
  | { status: 'error'; message: string };

export interface ConnectionParams {
  driver: Driver;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

class PgDbClient implements DbClient {
  constructor(private pg: Client) {}

  async query(sql: string): Promise<DbResult> {
    const raw = await this.pg.query(sql);
    const result = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    return {
      fields: (result.fields ?? []).map((f: { name: string }) => f.name),
      rows: (result.rows ?? []) as Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async end() { await this.pg.end(); }
}

class MysqlDbClient implements DbClient {
  constructor(private conn: Awaited<ReturnType<typeof createConnection>>) {}

  async query(sql: string): Promise<DbResult> {
    const [result, fields] = await this.conn.query(sql);
    if (Array.isArray(result)) {
      return {
        fields: fields ? (fields as FieldPacket[]).map((f) => f.name ?? '') : [],
        rows: result as Record<string, unknown>[],
        rowCount: (result as RowDataPacket[]).length,
      };
    }
    const header = result as ResultSetHeader;
    return { fields: [], rows: [], rowCount: header.affectedRows ?? 0 };
  }

  async end() { await this.conn.end(); }
}

class SqliteDbClient implements DbClient {
  constructor(private db: InstanceType<typeof Database>) {}

  async query(sql: string): Promise<DbResult> {
    const stmt = this.db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all() as Record<string, unknown>[];
      const fields = stmt.columns().map((c) => c.name);
      return { fields, rows, rowCount: rows.length };
    }
    const info = stmt.run();
    return { fields: [], rows: [], rowCount: info.changes };
  }

  async end() { this.db.close(); }
}

export function resolveSqlitePath(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? homedir() + trimmed.slice(1) : trimmed;
  return resolve(expanded);
}

export async function connectParams(params: ConnectionParams): Promise<ConnectionState> {
  try {
    if (params.driver === 'sqlite') {
      if (!params.database.trim()) return { status: 'error', message: 'Enter the path to a SQLite database file.' };
      const filePath = resolveSqlitePath(params.database);
      // better-sqlite3 silently creates a new empty database for a missing path, which
      // looks like a connected-but-empty schema; a typo should be an error instead.
      if (!existsSync(filePath)) return { status: 'error', message: `SQLite file not found: ${filePath}` };
      const db = new Database(filePath, { fileMustExist: true });
      return {
        status: 'connected',
        client: new SqliteDbClient(db),
        database: filePath,
        host: 'local',
        user: '',
        driver: 'sqlite',
        params: { ...params, database: filePath },
      };
    }

    if (params.driver === 'mysql') {
      const conn = await createConnection({
        host: params.host,
        port: params.port,
        database: params.database,
        user: params.user,
        password: params.password,
      });
      const [rows] = await conn.query<RowDataPacket[]>('SELECT DATABASE() AS db');
      const database = (rows[0]?.db as string) ?? params.database;
      void savePassword(params.driver, params.user, params.host, params.port, params.password);
      return {
        status: 'connected',
        client: new MysqlDbClient(conn),
        database,
        host: params.host,
        user: params.user,
        driver: 'mysql',
        params,
      };
    }

    const pg = new Client({
      host: params.host,
      port: params.port,
      database: params.database,
      user: params.user,
      password: params.password,
    });
    await pg.connect();
    const res = await pg.query<{ current_database: string }>('SELECT current_database()');
    void savePassword(params.driver, params.user, params.host, params.port, params.password);
    return {
      status: 'connected',
      client: new PgDbClient(pg),
      database: res.rows[0].current_database,
      host: pg.host,
      user: pg.user ?? 'unknown',
      driver: 'postgresql',
      params,
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function connectDsn(dsn: string): Promise<ConnectionState> {
  try {
    // SQLite: sqlite:///abs/path, sqlite://./rel/path, sqlite://~/path or sqlite:path
    if (dsn.startsWith('sqlite:')) {
      const filePath = dsn.startsWith('sqlite://') ? dsn.slice('sqlite://'.length) : dsn.slice('sqlite:'.length);
      return connectParams({ driver: 'sqlite', host: 'local', port: 0, database: filePath, user: '', password: '' });
    }

    const url = new URL(dsn);
    const driver: Driver = url.protocol.startsWith('mysql') ? 'mysql' : 'postgresql';

    if (driver === 'postgresql') {
      const pg = new Client({ connectionString: dsn });
      await pg.connect();
      const res = await pg.query<{ current_database: string }>('SELECT current_database()');
      const params: ConnectionParams = {
        driver: 'postgresql',
        host: pg.host,
        port: (pg as unknown as { port: number }).port ?? 5432,
        database: res.rows[0].current_database,
        user: pg.user ?? '',
        password: decodeURIComponent(url.password),
      };
      return {
        status: 'connected',
        client: new PgDbClient(pg),
        database: res.rows[0].current_database,
        host: pg.host,
        user: pg.user ?? 'unknown',
        driver: 'postgresql',
        params,
      };
    }

    return connectParams({
      driver: 'mysql',
      host: url.hostname || 'localhost',
      port: url.port ? parseInt(url.port) : 3306,
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export const connect = connectDsn;
