import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const COL_PAD = 1;
const HEADER_COLOR = theme.accent;
const BORDER = '#9e9e9e';
const NULL_COLOR = theme.muted;

const NULL_MARKER = '∅';

function isNull(val: unknown): boolean {
  return val === null || val === undefined;
}

function cellValue(val: unknown): string {
  if (isNull(val)) return NULL_MARKER;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function colWidths(columns: string[], rows: Record<string, unknown>[]): number[] {
  return columns.map((col) => {
    const dataMax = rows.reduce(
      (max, row) => Math.max(max, cellValue(row[col]).length),
      0,
    );
    return Math.max(col.length, dataMax);
  });
}

function pad(str: string, width: number): string {
  return str.slice(0, width).padEnd(width);
}

function hline(
  widths: number[],
  left: string,
  mid: string,
  right: string,
): string {
  const segments = widths.map((w) => '─'.repeat(w + COL_PAD * 2));
  return left + segments.join(mid) + right;
}

export { cellValue, colWidths };

interface TableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  expanded?: boolean;
}

function ExpandedTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const keyWidth = columns.reduce((max, col) => Math.max(max, col.length), 0);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i} flexDirection="column" marginBottom={i < rows.length - 1 ? 1 : 0}>
          <Text color={BORDER}>{`─[ Record ${i + 1} ]${'─'.repeat(Math.max(0, keyWidth + 14 - String(i + 1).length))}`}</Text>
          {columns.map((col) => (
            <Box key={col}>
              <Text color={HEADER_COLOR} bold>{col.padEnd(keyWidth)}</Text>
              <Text color={BORDER}>{' │ '}</Text>
              {isNull(row[col])
                ? <Text color={NULL_COLOR} dimColor>{NULL_MARKER}</Text>
                : <Text>{cellValue(row[col])}</Text>}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function Table({ columns, rows, expanded = false }: TableProps) {
  if (expanded) return <ExpandedTable columns={columns} rows={rows} />;

  const widths = colWidths(columns, rows);

  const topLine = hline(widths, '╭', '┬', '╮');
  const midLine = hline(widths, '├', '┼', '┤');
  const botLine = hline(widths, '╰', '┴', '╯');

  function renderHeaderRow(cols: string[]) {
    return (
      <Box>
        <Text color={BORDER}>│</Text>
        {cols.map((v, i) => (
          <Box key={i}>
            <Text color={HEADER_COLOR} bold>{' '.repeat(COL_PAD) + pad(v, widths[i]) + ' '.repeat(COL_PAD)}</Text>
            <Text color={BORDER}>│</Text>
          </Box>
        ))}
      </Box>
    );
  }

  function renderDataRow(row: Record<string, unknown>) {
    return (
      <Box>
        <Text color={BORDER}>│</Text>
        {columns.map((col, i) => (
          <Box key={i}>
            {isNull(row[col])
              ? <Text color={NULL_COLOR} dimColor>{' '.repeat(COL_PAD) + pad(NULL_MARKER, widths[i]) + ' '.repeat(COL_PAD)}</Text>
              : <Text>{' '.repeat(COL_PAD) + pad(cellValue(row[col]), widths[i]) + ' '.repeat(COL_PAD)}</Text>}
            <Text color={BORDER}>│</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={BORDER}>{topLine}</Text>
      {renderHeaderRow(columns)}
      <Text color={BORDER}>{midLine}</Text>
      {rows.map((row, i) => (
        <Box key={i} flexDirection="column">
          {renderDataRow(row)}
          {i < rows.length - 1 && <Text color={BORDER}>{midLine}</Text>}
        </Box>
      ))}
      <Text color={BORDER}>{botLine}</Text>
    </Box>
  );
}
