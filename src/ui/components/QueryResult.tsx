import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { QueryState } from '../../db/query.js';
import { Table, cellValue, colWidths } from './Table.js';
import { theme } from '../theme.js';

const ERROR_FG = theme.error;

export function ErrorBox({ message }: { message: string }) {
  const lines = message.split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Text key={i} color={ERROR_FG} bold>{i === 0 ? '✗  ' : '   '}{line}</Text>
      ))}
    </Box>
  );
}

interface QueryResultProps {
  state: QueryState;
  elapsed: number | null;
  page: number;
  pageSize: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function useTerminalWidth() {
  const [width, setWidth] = useState(process.stdout.columns ?? 80);
  useEffect(() => {
    const handler = () => setWidth(process.stdout.columns ?? 80);
    process.stdout.on('resize', handler);
    return () => { process.stdout.off('resize', handler); };
  }, []);
  return width;
}

export function QueryResult({ state, elapsed, page, pageSize }: QueryResultProps) {
  const termWidth = useTerminalWidth();

  if (state.status === 'idle' || state.status === 'running') return null;

  const timing = elapsed !== null ? ` · ${formatDuration(elapsed)}` : '';

  if (state.status === 'error') {
    return (
      <Box flexDirection="column">
        <ErrorBox message={state.message} />
        {elapsed !== null && <Text color={theme.accent} dimColor>{formatDuration(elapsed)}</Text>}
      </Box>
    );
  }

  const { result } = state;
  const columns = result.fields;

  if (result.rows.length === 0) {
    return (
      <Box>
        <Text color={theme.accent}>
          No rows returned ({result.rowCount ?? 0} affected){timing}
        </Text>
      </Box>
    );
  }

  const totalRows = result.rows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const displayRows = result.rows.slice(start, start + pageSize);
  const isPaged = totalRows > pageSize;

  const widths = colWidths(columns, displayRows);
  const tableWidth = 1 + widths.reduce((sum, w) => sum + w + 3, 0);
  const expanded = tableWidth > termWidth;

  return (
    <Box flexDirection="column">
      <Table columns={columns} rows={displayRows} expanded={expanded} />
      <Box marginTop={1} flexDirection="column">
        {isPaged && (
          <Text color={theme.warning}>
            Page {currentPage + 1} of {totalPages} · showing rows {start + 1}–{start + displayRows.length} of {totalRows}
            {currentPage > 0 ? '  /prev' : ''}
            {currentPage < totalPages - 1 ? '  /next' : ''}
          </Text>
        )}
        <Text color={theme.accent}>
          {displayRows.length} row{displayRows.length !== 1 ? 's' : ''}{timing}
          {expanded ? '  [expanded]' : ''}
        </Text>
      </Box>
    </Box>
  );
}
