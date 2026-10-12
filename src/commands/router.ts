import type { Driver } from '../db/client.js';
import { expandAlias } from '../config/aliases.js';
import { fuzzyScore } from '../ui/completions.js';

export type CommandCategory = 'AI' | 'Schema' | 'Session' | 'Data' | 'Aliases';

export interface HelpEntry {
  name: string;
  usage: string;
  description: string;
  psqlAlias?: string;
  detail?: string;
  example?: string;
  examples?: string[];
}

export interface HelpGroup {
  category: string;
  entries: HelpEntry[];
}

export interface HelpData {
  mode: 'list' | 'detail';
  groups?: HelpGroup[];
  entry?: HelpEntry;
}

export interface CommandResult {
  ok: boolean;
  message: string;
  cleared?: boolean;
  helpData?: HelpData;
}

export interface CommandContext {
  vimEnabled: boolean;
  setVimEnabled: (enabled: boolean) => void;
  lastSqlQuery: string;
  currentDatabase: string;
  args: string;
  driver: Driver;
  onExplain: (query: string) => void;
  onQuery: (sql: string) => void;
  onChangeDatabase: (database: string) => void;
  onExport: (format: 'csv' | 'json') => void;
  onClear: () => void;
  onErd: (table?: string) => void;
  aliases: Record<string, string>;
  onSaveAlias: (name: string, query: string) => void;
  onDeleteAlias: (name: string) => boolean;
}

interface Command {
  description: string;
  category: CommandCategory;
  usage: string;
  detail?: string;
  example?: string;
  examples?: string[];
  run: (ctx: CommandContext) => CommandResult;
}

const DB_QUERIES: Record<Driver, { databases: string; tables: string; users: string }> = {
  postgresql: {
    databases: `SELECT datname AS database FROM pg_database WHERE datistemplate = false ORDER BY datname`,
    tables: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    users: `SELECT usename AS user, usesuper AS superuser FROM pg_user ORDER BY usename`,
  },
  mysql: {
    databases: `SHOW DATABASES`,
    tables: `SHOW TABLES`,
    users: `SELECT user, host FROM mysql.user ORDER BY user`,
  },
  sqlite: {
    databases: `SELECT name FROM pragma_database_list`,
    tables: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    users: `SELECT 'SQLite has no users' AS message`,
  },
};

const PSQL_ALIASES: Record<string, string> = {
  l: 'databases',
  d: 'd',
  dt: 'tables',
  du: 'users',
  c: 'changeDatabase',
};

const PSQL_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(PSQL_ALIASES)
    .filter(([alias, name]) => alias !== name)
    .map(([alias, name]) => [name, `\\${alias}`])
);

function describeBasicSql(driver: Driver, table: string): string {
  const t = table.replace(/'/g, "''");
  if (driver === 'postgresql') {
    return `SELECT column_name, data_type, is_nullable AS nullable, COALESCE(column_default, '') AS "default" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' ORDER BY ordinal_position`;
  }
  if (driver === 'mysql') {
    return `SELECT column_name, column_type AS data_type, is_nullable AS nullable, COALESCE(column_default, '') AS \`default\` FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${t}' ORDER BY ordinal_position`;
  }
  return `SELECT name AS column_name, type AS data_type, CASE WHEN "notnull" = 0 THEN 'YES' ELSE 'NO' END AS nullable, COALESCE(dflt_value, '') AS "default" FROM pragma_table_info('${t}')`;
}

function describeFullSql(driver: Driver, table: string): string {
  const t = table.replace(/'/g, "''");
  if (driver === 'postgresql') {
    return `SELECT c.column_name, c.data_type, c.is_nullable AS nullable, COALESCE(c.column_default, '') AS "default", COALESCE(string_agg(DISTINCT CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 'PK' WHEN 'FOREIGN KEY' THEN 'FK' WHEN 'UNIQUE' THEN 'UQ' END, ', ') FILTER (WHERE tc.constraint_type IS NOT NULL), '') AS key FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage kcu ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE c.table_schema = 'public' AND c.table_name = '${t}' GROUP BY c.column_name, c.data_type, c.is_nullable, c.column_default, c.ordinal_position ORDER BY c.ordinal_position`;
  }
  if (driver === 'mysql') {
    return `SELECT c.column_name, c.column_type AS data_type, c.is_nullable AS nullable, COALESCE(c.column_default, '') AS \`default\`, COALESCE(GROUP_CONCAT(DISTINCT CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 'PK' WHEN 'FOREIGN KEY' THEN 'FK' WHEN 'UNIQUE' THEN 'UQ' END SEPARATOR ', '), '') AS \`key\` FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage kcu ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE c.table_schema = DATABASE() AND c.table_name = '${t}' GROUP BY c.column_name, c.column_type, c.is_nullable, c.column_default, c.ordinal_position ORDER BY c.ordinal_position`;
  }
  return `SELECT name AS column_name, type AS data_type, CASE WHEN "notnull" = 0 THEN 'YES' ELSE 'NO' END AS nullable, COALESCE(dflt_value, '') AS "default", CASE WHEN pk > 0 THEN 'PK' ELSE '' END AS key FROM pragma_table_info('${t}')`;
}

const COMMANDS: Record<string, Command> = {
  'clear': {
    description: 'Clear the terminal scrollback',
    category: 'Session',
    usage: '/clear',
    detail: 'Erases the visible screen and scrollback buffer. The next query starts fresh from the top.',
    run: (ctx) => {
      ctx.onClear();
      return { ok: true, message: '', cleared: true };
    },
  },
  'toggle-vim-mode': {
    description: 'Toggle vim keybindings on/off',
    category: 'Session',
    usage: '/toggle-vim-mode',
    detail: 'Switches the query input between standard editing and vim keybindings, matching Claude Code\'s vim mode: counts, motions (w e b 0 ^ $ gg G f t ; ,), operators with text objects (diw, ci", ya(), visual mode (v / V), undo (u) and repeat (.). Esc enters NORMAL mode; i a I A o O return to INSERT.',
    run: (ctx) => {
      const next = !ctx.vimEnabled;
      ctx.setVimEnabled(next);
      return { ok: true, message: `Vim mode ${next ? 'enabled' : 'disabled'}` };
    },
  },
  'd': {
    description: 'List tables, or describe a table',
    category: 'Schema',
    usage: '/d [table]',
    detail: 'Without an argument, lists all tables in the current database. With a table name, shows columns, types, nullability, and defaults.',
    example: '/d users',
    run: (ctx) => {
      if (!ctx.args.trim()) {
        ctx.onQuery(DB_QUERIES[ctx.driver].tables);
      } else {
        ctx.onQuery(describeBasicSql(ctx.driver, ctx.args.trim()));
      }
      return { ok: true, message: '' };
    },
  },
  'describe': {
    description: 'Describe a table with PK/FK/UQ constraints',
    category: 'Schema',
    usage: '/describe <table>',
    detail: 'Like /d but includes constraint information — PK (primary key), FK (foreign key), UQ (unique) — in an extra key column. SQLite shows PK only.',
    example: '/describe orders',
    run: (ctx) => {
      const table = ctx.args.trim();
      if (!table) return { ok: false, message: 'Usage: /describe <table>' };
      ctx.onQuery(describeFullSql(ctx.driver, table));
      return { ok: true, message: '' };
    },
  },
  'databases': {
    description: 'List available databases',
    category: 'Schema',
    usage: '/databases',
    detail: 'Runs a driver-appropriate query to list all databases on the server.',
    run: (ctx) => {
      ctx.onQuery(DB_QUERIES[ctx.driver].databases);
      return { ok: true, message: '' };
    },
  },
  'tables': {
    description: 'List tables in the current database',
    category: 'Schema',
    usage: '/tables',
    detail: "Lists tables in the current database's public schema.",
    run: (ctx) => {
      ctx.onQuery(DB_QUERIES[ctx.driver].tables);
      return { ok: true, message: '' };
    },
  },
  'users': {
    description: 'List database users',
    category: 'Schema',
    usage: '/users',
    detail: 'Lists users and their roles. On SQLite, shows a placeholder message since SQLite has no user system.',
    run: (ctx) => {
      ctx.onQuery(DB_QUERIES[ctx.driver].users);
      return { ok: true, message: '' };
    },
  },
  'changeDatabase': {
    description: 'Switch to a different database',
    category: 'Session',
    usage: '/changeDatabase <dbname>',
    detail: 'Switches the active connection to the specified database. Without an argument, shows the current database.',
    example: '/changeDatabase myapp_prod',
    run: (ctx) => {
      if (!ctx.args) return { ok: true, message: `Connected to database: ${ctx.currentDatabase}` };
      ctx.onChangeDatabase(ctx.args.trim());
      return { ok: true, message: '' };
    },
  },
  'export': {
    description: 'Export last result to a file',
    category: 'Data',
    usage: '/export csv|json',
    detail: 'Writes the last query result to a timestamped file in your home directory. CSV files include a header row; JSON files are an array of row objects.',
    example: '/export csv',
    run: (ctx) => {
      const fmt = ctx.args.trim().toLowerCase();
      if (fmt !== 'csv' && fmt !== 'json') {
        return { ok: false, message: 'Usage: /export csv  or  /export json' };
      }
      ctx.onExport(fmt as 'csv' | 'json');
      return { ok: true, message: '' };
    },
  },
  'explain': {
    description: 'Explain a SQL query using AI',
    category: 'AI',
    usage: '/explain <SQL>',
    detail: 'Sends the query to your configured AI endpoint (Ollama by default, or any OpenAI-compatible API) and streams a plain-language explanation.',
    example: "/explain SELECT * FROM orders WHERE status = 'pending'",
    run: (ctx) => {
      if (!ctx.args) return { ok: false, message: 'Usage: /explain <SQL query>' };
      ctx.onExplain(ctx.args);
      return { ok: true, message: '' };
    },
  },
  'explain-previous': {
    description: 'Explain the last executed query using AI',
    category: 'AI',
    usage: '/explain-previous',
    detail: 'Like /explain but uses the last SQL query you ran. Useful for quickly understanding a query after seeing its results.',
    run: (ctx) => {
      if (!ctx.lastSqlQuery) {
        return { ok: false, message: 'No query to explain — run a SQL query first.' };
      }
      ctx.onExplain(ctx.lastSqlQuery);
      return { ok: true, message: '' };
    },
  },
  'save': {
    description: 'Save last query as a named alias',
    category: 'Aliases',
    usage: '/save <name>',
    detail: 'Saves the last executed SQL query as a named alias scoped to the current database. Run it later with /<name>. If the query contains $1, $2 placeholders or :param placeholders, values are substituted at run time.',
    examples: [
      '/save active-orders                 (no params — run with /active-orders)',
      '/save user-by-id                    (query had WHERE id = $1 — run with /user-by-id 42)',
      '/save by-status                     (query had WHERE status = :status — run with /by-status :status=active)',
    ],
    run: (ctx) => {
      const name = ctx.args.trim();
      if (!name) return { ok: false, message: 'Usage: /save <name>' };
      if (!ctx.lastSqlQuery) return { ok: false, message: 'No query to save — run a SQL query first.' };
      if (/\s/.test(name)) return { ok: false, message: 'Alias name must not contain spaces.' };
      ctx.onSaveAlias(name, ctx.lastSqlQuery);
      return { ok: true, message: `Saved /${name}` };
    },
  },
  'alias': {
    description: 'Define an alias inline',
    category: 'Aliases',
    usage: '/alias <name> <SQL>',
    detail: 'Defines a named alias without running a query first. Use $1, $2 for positional args or :param for named args — values are substituted when the alias is invoked.',
    examples: [
      '/alias recent SELECT * FROM events ORDER BY created_at DESC LIMIT 20',
      '/alias user SELECT * FROM users WHERE id = $1',
      '/alias by-email SELECT * FROM users WHERE email = :email',
      '/user 42                             (positional)',
      '/by-email :email=alice@example.com   (named)',
    ],
    run: (ctx) => {
      const [name, ...rest] = ctx.args.trim().split(/\s+/);
      if (!name || rest.length === 0) return { ok: false, message: 'Usage: /alias <name> <SQL>' };
      if (/\s/.test(name)) return { ok: false, message: 'Alias name must not contain spaces.' };
      ctx.onSaveAlias(name, rest.join(' '));
      return { ok: true, message: `Saved /${name}` };
    },
  },
  'aliases': {
    description: 'List all saved aliases for this database',
    category: 'Aliases',
    usage: '/aliases',
    detail: 'Prints all saved aliases for the current database connection, with their SQL template.',
    run: (ctx) => {
      const entries = Object.entries(ctx.aliases);
      if (entries.length === 0) return { ok: true, message: 'No aliases saved. Use /save <name> or /alias <name> <SQL>.' };
      const maxLen = Math.max(...entries.map(([n]) => n.length));
      const lines = entries.map(([n, sql], i) =>
        `${i === 0 ? '·' : '  ·'} /${n.padEnd(maxLen)}  →  ${sql}`
      );
      return { ok: true, message: lines.join('\n') };
    },
  },
  'unalias': {
    description: 'Remove a saved alias',
    category: 'Aliases',
    usage: '/unalias <name>',
    detail: 'Removes a previously saved alias. Only affects aliases for the current database connection.',
    example: '/unalias active-orders',
    run: (ctx) => {
      const name = ctx.args.trim();
      if (!name) return { ok: false, message: 'Usage: /unalias <name>' };
      const removed = ctx.onDeleteAlias(name);
      return removed
        ? { ok: true, message: `Removed /${name}` }
        : { ok: false, message: `No alias named /${name}` };
    },
  },
  'erd': {
    description: 'Draw an entity-relationship diagram of the schema',
    category: 'Schema',
    usage: '/erd [table]',
    detail: 'Draws tables as boxes with relationship lines in crow\'s-foot notation: referenced tables sit above the tables that point at them. Line ends read ┼ one, ○ zero, ╱│╲ many — e.g. ┼┼ is "exactly one", ┼○ is "zero or one", ○╱│╲ is "zero or many". Lines are labelled with the foreign key column. Pass a table name to show only that table and its direct neighbours, which keeps large schemas readable.',
    examples: ['/erd', '/erd orders'],
    run: (ctx) => {
      ctx.onErd(ctx.args.trim() || undefined);
      return { ok: true, message: '' };
    },
  },
  'help': {
    description: 'Show help for all commands or a specific command',
    category: 'Session',
    usage: '/help [command]',
    detail: 'Without arguments, lists all commands grouped by category. With a command name, shows detailed usage and an example.',
    example: '/help explain',
    run: (ctx) => {
      const arg = ctx.args.trim();
      if (arg) {
        const name = PSQL_ALIASES[arg] ?? arg;
        const cmd = COMMANDS[name];
        if (!cmd) return { ok: false, message: `Unknown command: /${arg}` };
        const entry: HelpEntry = {
          name,
          usage: cmd.usage,
          description: cmd.description,
          psqlAlias: PSQL_REVERSE[name],
          detail: cmd.detail,
          example: cmd.example,
          examples: cmd.examples,
        };
        return { ok: true, message: '', helpData: { mode: 'detail', entry } };
      }

      const categoryOrder: CommandCategory[] = ['AI', 'Schema', 'Data', 'Aliases', 'Session'];
      const groups: HelpGroup[] = categoryOrder
        .map((cat) => ({
          category: cat,
          entries: Object.entries(COMMANDS)
            .filter(([, cmd]) => cmd.category === cat)
            .map(([name, cmd]) => ({
              name,
              usage: cmd.usage,
              description: cmd.description,
              psqlAlias: PSQL_REVERSE[name],
            })),
        }))
        .filter((g) => g.entries.length > 0);

      return { ok: true, message: '', helpData: { mode: 'list', groups } };
    },
  },
};

export const BUILTIN_COMMAND_LIST = Object.entries(COMMANDS).map(([name, cmd]) => ({
  name,
  description: cmd.description,
}));

export function getCompletions(partial: string, aliases: Record<string, string> = {}): string[] {
  if (partial.length === 0) return BUILTIN_COMMAND_LIST.map((c) => c.name);
  const tokenLower = partial.toLowerCase();
  const candidates = [
    ...BUILTIN_COMMAND_LIST.map((c) => c.name),
    ...Object.keys(aliases).filter((n) => !COMMANDS[n]),
  ];
  return candidates
    .map((n) => ({ n, score: fuzzyScore(tokenLower, n.toLowerCase()) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(({ n }) => n);
}

export function runCommand(input: string, ctx: Omit<CommandContext, 'args'>): CommandResult {
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const rawName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);

  const name = PSQL_ALIASES[rawName ?? ''] ?? rawName ?? '';
  const cmd = COMMANDS[name];
  const prefix = input.startsWith('\\') ? '\\' : '/';

  if (cmd) return cmd.run({ ...ctx, args });

  const template = ctx.aliases[rawName];
  if (template) {
    const expanded = expandAlias(template, args);
    ctx.onQuery(expanded);
    return { ok: true, message: '' };
  }

  return { ok: false, message: `Unknown command: ${prefix}${rawName}` };
}
