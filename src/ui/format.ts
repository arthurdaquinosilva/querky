// ANSI string renderers for result content written directly to stdout.
// These mirror the Ink component output so the terminal look stays consistent.

import type { QueryState } from '../db/query.js';
import type { ErdData } from '../db/erd.js';
import type { HelpData } from '../commands/router.js';
import { theme } from './theme.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const R = '\x1B[0m';
const BOLD = '\x1B[1m';
const DIM = '\x1B[2m';

const ANSI_FG: Record<string, string> = {
  black: '\x1B[30m', red: '\x1B[31m', green: '\x1B[32m', yellow: '\x1B[33m',
  blue: '\x1B[34m', magenta: '\x1B[35m', cyan: '\x1B[36m', white: '\x1B[37m',
  grey: '\x1B[90m', gray: '\x1B[90m',
};

function fg(color: string): string {
  if (color in ANSI_FG) return ANSI_FG[color];
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}

function c(hex: string, s: string): string { return fg(hex) + s + R; }
function bold(s: string): string { return BOLD + s + R; }
function dim(s: string): string { return DIM + s + R; }
function cbold(hex: string, s: string): string { return fg(hex) + BOLD + s + R; }
function cdim(hex: string, s: string): string { return fg(hex) + DIM + s + R; }

const ACCENT     = theme.accent;
const HEADER_COL = theme.muted;
const NULL_COL   = theme.muted;
const INDIGO     = theme.accent;
const AI_COL     = theme.insertMode;
const ERROR_COL  = theme.error;
const WARN_COL   = theme.warning;
const SHELL_COL  = theme.shellMode;
const ERD_BORDER = '#585b70';

const ERD_PALETTE = [
  '#cba6f7',
  '#a6e3a1',
  '#89b4fa',
  '#f38ba8',
  '#fab387',
  '#94e2d5',
  '#f9e2af',
  '#f5c2e7',
];

const NULL_MARKER = '∅';
const COL_PAD = 1;
const SP = ' '.repeat(COL_PAD);

// ── Query header ──────────────────────────────────────────────────────────────

export function fmtHeader(label: string, query: string): string {
  const dot = cbold(ACCENT, '● ');
  if (query.includes('\n')) {
    const lines = query.split('\n').map((l) => cbold(HEADER_COL, '  ' + l));
    return dot + cbold(HEADER_COL, label + ':') + '\n' + lines.join('\n');
  }
  return dot + cbold(HEADER_COL, `${label}(${query})`);
}

// ── Error / success ───────────────────────────────────────────────────────────

export function fmtError(message: string): string {
  return message.split('\n').map((line, i) =>
    cbold(ERROR_COL, (i === 0 ? '✗  ' : '   ') + line)
  ).join('\n');
}

export function fmtOk(text: string): string {
  return c(ACCENT, '✓ ') + text;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function isNull(v: unknown): boolean { return v === null || v === undefined; }

function cellStr(v: unknown): string {
  if (isNull(v)) return NULL_MARKER;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function colWidths(columns: string[], rows: Record<string, unknown>[]): number[] {
  return columns.map((col) => {
    const dataMax = rows.reduce((mx, row) => Math.max(mx, cellStr(row[col]).length), 0);
    return Math.max(col.length, dataMax);
  });
}

function hline(widths: number[], l: string, m: string, r: string): string {
  return l + widths.map((w) => '─'.repeat(w + COL_PAD * 2)).join(m) + r;
}

function fmtTable(columns: string[], rows: Record<string, unknown>[]): string {
  const widths = colWidths(columns, rows);
  const top = hline(widths, '╭', '┬', '╮');
  const mid = hline(widths, '├', '┼', '┤');
  const bot = hline(widths, '╰', '┴', '╯');

  function headerRow(): string {
    const cells = columns.map((col, i) =>
      cbold(INDIGO, SP + col.slice(0, widths[i]).padEnd(widths[i]) + SP)
    );
    return '│' + cells.join('│') + '│';
  }

  function dataRow(row: Record<string, unknown>): string {
    const cells = columns.map((col, i) => {
      const v = cellStr(row[col]);
      const cell = SP + v.slice(0, widths[i]).padEnd(widths[i]) + SP;
      return isNull(row[col]) ? cdim(NULL_COL, cell) : cell;
    });
    return '│' + cells.join('│') + '│';
  }

  const out: string[] = [top, headerRow(), mid];
  rows.forEach((row, i) => {
    out.push(dataRow(row));
    if (i < rows.length - 1) out.push(mid);
  });
  out.push(bot);
  return out.join('\n');
}

function fmtExpanded(columns: string[], rows: Record<string, unknown>[]): string {
  const kw = columns.reduce((mx, c) => Math.max(mx, c.length), 0);
  const separator = (i: number) => '─[ Record ' + (i + 1) + ' ]' + '─'.repeat(Math.max(0, kw + 14 - String(i + 1).length));
  const out: string[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(dim(separator(i)));
    for (const col of columns) {
      const val = isNull(row[col])
        ? cdim(NULL_COL, NULL_MARKER)
        : cellStr(row[col]);
      out.push(cbold(INDIGO, col.padEnd(kw)) + dim(' │ ') + val);
    }
  });
  return out.join('\n');
}

// ── Duration ──────────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ── Query result ──────────────────────────────────────────────────────────────

export function fmtQueryResult(
  state: QueryState,
  elapsed: number | null,
  page: number,
  pageSize: number,
): string {
  if (state.status === 'idle' || state.status === 'running') return '';

  const timing = elapsed !== null ? ` · ${fmtDuration(elapsed)}` : '';

  if (state.status === 'error') {
    const t = elapsed !== null ? '\n' + cdim(ACCENT, fmtDuration(elapsed)) : '';
    return fmtError(state.message) + t;
  }

  const { result } = state;
  const { fields, rows } = result;

  if (rows.length === 0) {
    return c(ACCENT, `No rows returned (${result.rowCount ?? 0} affected)${timing}`);
  }

  const totalRows = rows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const displayRows = rows.slice(start, start + pageSize);
  const isPaged = totalRows > pageSize;

  const termWidth = process.stdout.columns ?? 80;
  const widths = colWidths(fields, displayRows);
  const tableWidth = 1 + widths.reduce((sum, w) => sum + w + 3, 0);
  const expanded = tableWidth > termWidth;

  const table = expanded ? fmtExpanded(fields, displayRows) : fmtTable(fields, displayRows);

  const lines: string[] = [table];
  if (isPaged) {
    const nav = (currentPage > 0 ? '  /prev' : '') + (currentPage < totalPages - 1 ? '  /next' : '');
    lines.push(c(WARN_COL, `Page ${currentPage + 1} of ${totalPages} · rows ${start + 1}–${start + displayRows.length} of ${totalRows}${nav}`));
  }
  lines.push(c(ACCENT, `${displayRows.length} row${displayRows.length !== 1 ? 's' : ''}${timing}${expanded ? '  [expanded]' : ''}`));
  return lines.join('\n');
}

// ── Help ──────────────────────────────────────────────────────────────────────

const USAGE_WIDTH = 28;

export function fmtHelp(data: HelpData): string {
  if (data.mode === 'detail' && data.entry) {
    const { usage, description, psqlAlias, detail, example, examples } = data.entry;
    const lines: string[] = [];
    lines.push(bold(usage) + (psqlAlias ? '  ' + dim(psqlAlias) : ''));
    lines.push('');
    lines.push(description);
    if (detail) { lines.push(''); lines.push(dim(detail)); }
    if (examples && examples.length > 0) {
      lines.push('');
      lines.push(dim('Examples:'));
      for (const ex of examples) lines.push('  ' + c(ACCENT, ex));
    } else if (example) {
      lines.push('');
      lines.push(dim('Example: ') + c(ACCENT, example));
    }
    return lines.join('\n');
  }

  if (data.mode === 'list' && data.groups) {
    const lines: string[] = [];
    data.groups.forEach((group, gi) => {
      if (gi > 0) lines.push('');
      lines.push(cbold(ACCENT, group.category));
      for (const entry of group.entries) {
        const alias = entry.psqlAlias ? dim('  ' + entry.psqlAlias) : '';
        lines.push('  ' + entry.usage.padEnd(USAGE_WIDTH) + dim(entry.description) + alias);
      }
    });
    lines.push('');
    lines.push(dim('/help <command> for more details.'));
    return lines.join('\n');
  }

  return '';
}

// ── ERD ───────────────────────────────────────────────────────────────────────

export function fmtErd(data: ErdData): string {
  if (data.tables.length === 0) return dim('No tables found in the current schema.');

  const FK_PREFIX = 'FK → ';
  const PAD = 1;

  const colorMap = new Map(
    data.tables.map((t, i) => [t.name, ERD_PALETTE[i % ERD_PALETTE.length]])
  );

  interface Metrics { nameW: number; typeW: number; keyW: number; totalW: number }

  function metrics(t: typeof data.tables[0]): Metrics {
    const nameW = Math.max(2, ...t.columns.map((c) => c.name.length));
    const typeW = Math.max(4, ...t.columns.map((c) => c.type.length));
    const keyW = Math.max(2, ...t.columns.map((c) =>
      c.isPk ? 2 : c.fkTable ? FK_PREFIX.length + c.fkTable.length : 0
    ));
    const totalW = 4 + 3 * PAD * 2 + nameW + typeW + keyW;
    return { nameW, typeW, keyW, totalW };
  }

  const allMetrics = data.tables.map(metrics);

  function renderTable(t: typeof data.tables[0], m: Metrics, color: string): string[] {
    const { nameW, typeW, keyW, totalW } = m;
    const sp = ' '.repeat(PAD);
    const p = (s: string, w: number) => s.slice(0, w).padEnd(w);
    const bdr = (s: string) => c(ERD_BORDER, s);
    const tc = (s: string) => cbold(color, s);

    const top = bdr('╭' + '─'.repeat(totalW - 2) + '╮');
    const headerW = totalW - 4;
    const headerLine = bdr('│') + tc(sp + p(t.name, headerW) + sp) + bdr('│');
    const sep = bdr('├' + '─'.repeat(nameW + PAD * 2) + '┬' + '─'.repeat(typeW + PAD * 2) + '┬' + '─'.repeat(keyW + PAD * 2) + '┤');
    const bot = bdr('╰' + '─'.repeat(nameW + PAD * 2) + '┴' + '─'.repeat(typeW + PAD * 2) + '┴' + '─'.repeat(keyW + PAD * 2) + '╯');

    const out = [top, headerLine, sep];
    for (const col of t.columns) {
      let keyPart: string;
      if (col.isPk) {
        keyPart = sp + bold(p('PK', keyW)) + sp;
      } else if (col.fkTable) {
        const fkColor = colorMap.get(col.fkTable) ?? color;
        keyPart = sp + dim(FK_PREFIX) + c(fkColor, p(col.fkTable, keyW - FK_PREFIX.length)) + sp;
      } else {
        keyPart = sp + ' '.repeat(keyW) + sp;
      }
      out.push(
        bdr('│') + sp + p(col.name, nameW) + sp +
        bdr('│') + dim(sp + p(col.type, typeW) + sp) +
        bdr('│') + keyPart +
        bdr('│')
      );
    }
    out.push(bot);
    return out;
  }

  // Stack tables vertically, one per line, with a blank line between them
  const output: string[] = [];
  data.tables.forEach((t, ti) => {
    const block = renderTable(t, allMetrics[ti], colorMap.get(t.name) ?? ERD_PALETTE[0]);
    output.push(...block);
    output.push('');
  });

  return output.join('\n').trimEnd();
}

// ── AI explanation ────────────────────────────────────────────────────────────

export function fmtAi(text: string, error: string | null): string {
  const lines: string[] = [cbold(ACCENT, 'Explanation:'), ''];
  if (error) {
    lines.push(fmtError(error));
  } else {
    lines.push(c(AI_COL, text));
  }
  return lines.join('\n');
}

// ── Full entry ────────────────────────────────────────────────────────────────

export interface EntryData {
  query: string;
  commandMessage: { text: string; ok: boolean; helpData?: HelpData } | null;
  queryState: QueryState;
  elapsed: number | null;
  page: number;
  aiResponse: string;
  aiError: string | null;
  shellOutput: string | null;
  erdData: ErdData | null;
}

export function fmtEntry(entry: EntryData): string {
  const isShell = entry.query.startsWith('!');
  const isCommand = !isShell && (entry.query.startsWith('/') || entry.query.startsWith('\\'));
  const label = isShell ? 'Shell' : isCommand ? 'Command' : 'Query';

  const lines: string[] = [' ' + fmtHeader(label, entry.query), ''];

  if (isShell) {
    if (entry.shellOutput !== null) lines.push(' ' + entry.shellOutput.replace(/\n/g, '\n '));
  } else if (entry.commandMessage) {
    if (entry.commandMessage.helpData) {
      lines.push(fmtHelp(entry.commandMessage.helpData).replace(/\n/g, '\n '));
    } else if (entry.commandMessage.ok) {
      lines.push(' ' + fmtOk(entry.commandMessage.text));
    } else {
      lines.push(' ' + fmtError(entry.commandMessage.text));
    }
  } else if (entry.erdData) {
    lines.push(' ' + fmtErd(entry.erdData).replace(/\n/g, '\n '));
  } else if (entry.aiResponse || entry.aiError) {
    lines.push(' ' + fmtAi(entry.aiResponse, entry.aiError).replace(/\n/g, '\n '));
  } else {
    const result = fmtQueryResult(entry.queryState, entry.elapsed, entry.page, 50);
    if (result) lines.push(' ' + result.replace(/\n/g, '\n '));
  }

  lines.push('');
  return lines.join('\n');
}
