// ANSI string renderers for result content written directly to stdout.
// These mirror the Ink component output so the terminal look stays consistent.

import type { QueryState } from '../db/query.js';
import type { ErdData } from '../db/erd.js';
import type { HelpData } from '../commands/router.js';
import { theme } from './theme.js';
import { tokenizeSql } from './sqlHighlight.js';
import { buildErdDiagram, type ErdSpan } from './erdDiagram.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const R = '\x1B[0m';
const BOLD = '\x1B[1m';
const DIM = '\x1B[2m';

function fg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1B[38;2;${r};${g};${b}m`;
}

function c(hex: string, s: string): string { return fg(hex) + s + R; }
function bold(s: string): string { return BOLD + s + R; }
function dim(s: string): string { return DIM + s + R; }
function cbold(hex: string, s: string): string { return fg(hex) + BOLD + s + R; }
function cdim(hex: string, s: string): string { return fg(hex) + DIM + s + R; }
const ITALIC = '\x1B[3m';

const ACCENT     = theme.accent;
const NULL_COL   = theme.muted;
const INDIGO     = theme.accent;
const ERROR_COL  = theme.error;
const WARN_COL   = theme.warning;
const MUTED      = theme.muted;

const NULL_MARKER = '∅';
const COL_PAD = 1;
const SP = ' '.repeat(COL_PAD);

// ── Prompt echo ───────────────────────────────────────────────────────────────

const SQL_COLORS: Record<string, string | undefined> = theme.sql;

function highlightSql(line: string): string {
  return tokenizeSql(line)
    .map((t) => (SQL_COLORS[t.type] ? c(SQL_COLORS[t.type]!, t.text) : t.text))
    .join('');
}

/** The submitted input, echoed like Claude Code's transcript: `> text`. */
export function fmtPromptEcho(input: string): string {
  const isSql = !input.startsWith('/') && !input.startsWith('\\') && !input.startsWith('!');
  return input
    .split('\n')
    .map((line, i) => (i === 0 ? c(MUTED, '> ') : '  ') + (isSql ? highlightSql(line) : bold(line)))
    .join('\n');
}

// ── Error / success ───────────────────────────────────────────────────────────

export function fmtError(message: string): string {
  return message.split('\n').map((line) => c(ERROR_COL, line)).join('\n');
}

export function fmtOk(text: string): string {
  return text;
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
  const bdr = (x: string) => c(theme.border, x);
  const top = bdr(hline(widths, '╭', '┬', '╮'));
  const mid = bdr(hline(widths, '├', '┼', '┤'));
  const bot = bdr(hline(widths, '╰', '┴', '╯'));
  const sep = bdr('│');

  function headerRow(): string {
    const cells = columns.map((col, i) =>
      cbold(INDIGO, SP + col.slice(0, widths[i]).padEnd(widths[i]) + SP)
    );
    return sep + cells.join(sep) + sep;
  }

  function dataRow(row: Record<string, unknown>): string {
    const cells = columns.map((col, i) => {
      const v = cellStr(row[col]);
      const cell = SP + v.slice(0, widths[i]).padEnd(widths[i]) + SP;
      return isNull(row[col]) ? cdim(NULL_COL, cell) : cell;
    });
    return sep + cells.join(sep) + sep;
  }

  return [top, headerRow(), mid, ...rows.map(dataRow), bot].join('\n');
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
    const t = elapsed !== null ? '\n' + c(MUTED, fmtDuration(elapsed)) : '';
    return fmtError(state.message) + t;
  }

  const { result } = state;
  const { fields, rows } = result;

  if (rows.length === 0) {
    return c(MUTED, `No rows returned (${result.rowCount ?? 0} affected)${timing}`);
  }

  const totalRows = rows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const displayRows = rows.slice(start, start + pageSize);
  const isPaged = totalRows > pageSize;

  const termWidth = (process.stdout.columns ?? 80) - BODY_INDENT.length;
  const widths = colWidths(fields, displayRows);
  const tableWidth = 1 + widths.reduce((sum, w) => sum + w + 3, 0);
  const expanded = tableWidth > termWidth;

  const table = expanded ? fmtExpanded(fields, displayRows) : fmtTable(fields, displayRows);

  const lines: string[] = [table];
  if (isPaged) {
    const nav = (currentPage > 0 ? '  /prev' : '') + (currentPage < totalPages - 1 ? '  /next' : '');
    lines.push(c(WARN_COL, `Page ${currentPage + 1} of ${totalPages} · rows ${start + 1}–${start + displayRows.length} of ${totalRows}${nav}`));
  }
  lines.push(c(MUTED, `${displayRows.length} row${displayRows.length !== 1 ? 's' : ''}${timing}${expanded ? ' · expanded' : ''}`));
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

function spanToAnsi(span: ErdSpan): string {
  if (span.text.trim() === '') return span.text;
  const codes = (span.color ? fg(span.color) : '') + (span.bold ? BOLD : '') + (span.dim ? DIM : '') + (span.italic ? ITALIC : '');
  return codes ? codes + span.text + R : span.text;
}

export function fmtErd(data: ErdData, width: number): string {
  if (data.tables.length === 0) return dim('No tables found in the current schema.');

  const diagram = buildErdDiagram(data, width, {
    tables: theme.tables,
    border: theme.border,
    pk: theme.warning,
    muted: theme.muted,
  });

  const lines = diagram.lines.map((spans) => spans.map(spanToAnsi).join(''));
  lines.push('');
  if (diagram.unrouted.length > 0) {
    lines.push(c(WARN_COL, 'Not drawn (no room to route):'));
    for (const r of diagram.unrouted) {
      lines.push('  ' + `${r.table}.${r.columns.join(', ')}` + c(MUTED, ' → ') + `${r.refTable}`);
    }
    lines.push('');
  }
  const n = data.tables.length;
  const m = data.relations.length;
  lines.push(
    c(MUTED, `${n} table${n === 1 ? '' : 's'} · ${m} relationship${m === 1 ? '' : 's'}  `) +
      c(MUTED, '┼ one   ○ zero   ╱│╲ many'),
  );
  return lines.join('\n');
}

// ── AI explanation ────────────────────────────────────────────────────────────

export function fmtAi(text: string, error: string | null): string {
  return error ? fmtError(error) : text.trim();
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
  /** What to echo as the user's input when it differs from `query` (e.g. `/next`). */
  echo?: string;
}

const BODY_INDENT = '     ';

/** Claude Code-style result block: `  ⎿  ` on the first line, hanging indent after. */
export function fmtBody(body: string): string {
  return body
    .split('\n')
    .map((line, i) => (i === 0 ? c(MUTED, '  ⎿  ') : line ? BODY_INDENT : '') + line)
    .join('\n');
}

export function fmtEntry(entry: EntryData): string {
  const isShell = entry.query.startsWith('!');
  const termWidth = process.stdout.columns ?? 80;
  let body = '';

  if (isShell) {
    body = entry.shellOutput ?? '';
  } else if (entry.commandMessage) {
    if (entry.commandMessage.helpData) body = fmtHelp(entry.commandMessage.helpData);
    else if (entry.commandMessage.ok) body = fmtOk(entry.commandMessage.text);
    else body = fmtError(entry.commandMessage.text);
  } else if (entry.erdData) {
    body = fmtErd(entry.erdData, termWidth - BODY_INDENT.length - 1);
  } else if (entry.aiResponse || entry.aiError) {
    body = fmtAi(entry.aiResponse, entry.aiError);
  } else {
    body = fmtQueryResult(entry.queryState, entry.elapsed, entry.page, 50);
  }

  const echo = entry.echo ?? entry.query;
  const lines = [fmtPromptEcho(echo)];
  if (body) lines.push(fmtBody(body));
  lines.push('');
  return lines.join('\n');
}
