import { Box, Text } from 'ink';
import type { ErdData, ErdTable } from '../../db/erd.js';

const TABLE_COLORS = [
  '#cba6f7',
  '#a6e3a1',
  '#89b4fa',
  '#f38ba8',
  '#fab387',
  '#94e2d5',
  '#f9e2af',
  '#f5c2e7',
];

const BORDER = '#585b70';
const PAD = 1;
const FK_PREFIX = 'FK → ';

interface Metrics {
  nameW: number;
  typeW: number;
  keyW: number;
  totalW: number;
}

function computeMetrics(table: ErdTable): Metrics {
  const nameW = Math.max(2, ...table.columns.map((c) => c.name.length));
  const typeW = Math.max(4, ...table.columns.map((c) => c.type.length));
  const keyW = Math.max(
    2,
    ...table.columns.map((c) => {
      if (c.isPk) return 2;
      if (c.fkTable) return FK_PREFIX.length + c.fkTable.length;
      return 0;
    }),
  );
  const totalW = 4 + 3 * PAD * 2 + nameW + typeW + keyW;
  return { nameW, typeW, keyW, totalW };
}

interface TableBoxProps {
  table: ErdTable;
  m: Metrics;
  color: string;
  colorMap: Map<string, string>;
}

function TableBox({ table, m, color, colorMap }: TableBoxProps) {
  const { nameW, typeW, keyW, totalW } = m;
  const sp = ' '.repeat(PAD);
  const p = (s: string, w: number) => s.slice(0, w).padEnd(w);

  const top = '╭' + '─'.repeat(totalW - 2) + '╮';
  const sep = '├' + '─'.repeat(nameW + PAD * 2) + '┬' + '─'.repeat(typeW + PAD * 2) + '┬' + '─'.repeat(keyW + PAD * 2) + '┤';
  const bot = '╰' + '─'.repeat(nameW + PAD * 2) + '┴' + '─'.repeat(typeW + PAD * 2) + '┴' + '─'.repeat(keyW + PAD * 2) + '╯';
  const headerW = totalW - 4;

  return (
    <Box flexDirection="column">
      <Text color={BORDER}>{top}</Text>
      <Box>
        <Text color={BORDER}>{'│'}</Text>
        <Text color={color} bold>{sp}{p(table.name, headerW)}{sp}</Text>
        <Text color={BORDER}>{'│'}</Text>
      </Box>
      <Text color={BORDER}>{sep}</Text>
      {table.columns.map((col, i) => (
        <Box key={i}>
          <Text color={BORDER}>{'│'}</Text>
          <Text>{sp}{p(col.name, nameW)}{sp}</Text>
          <Text color={BORDER}>{'│'}</Text>
          <Text dimColor>{sp}{p(col.type, typeW)}{sp}</Text>
          <Text color={BORDER}>{'│'}</Text>
          {col.isPk ? (
            <Text bold>{sp}{p('PK', keyW)}{sp}</Text>
          ) : col.fkTable ? (
            <>
              <Text dimColor>{sp}{FK_PREFIX}</Text>
              <Text color={colorMap.get(col.fkTable) ?? color}>{p(col.fkTable, keyW - FK_PREFIX.length)}{sp}</Text>
            </>
          ) : (
            <Text>{sp}{' '.repeat(keyW)}{sp}</Text>
          )}
          <Text color={BORDER}>{'│'}</Text>
        </Box>
      ))}
      <Text color={BORDER}>{bot}</Text>
    </Box>
  );
}

export function ErdView({ data }: { data: ErdData }) {
  if (data.tables.length === 0) {
    return <Text dimColor>No tables found in the current schema.</Text>;
  }

  const metrics = data.tables.map(computeMetrics);
  const colorMap = new Map(
    data.tables.map((t, i) => [t.name, TABLE_COLORS[i % TABLE_COLORS.length]]),
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {data.tables.map((table, ti) => (
        <Box key={table.name} marginBottom={ti < data.tables.length - 1 ? 1 : 0}>
          <TableBox
            table={table}
            m={metrics[ti]}
            color={colorMap.get(table.name) ?? BORDER}
            colorMap={colorMap}
          />
        </Box>
      ))}
    </Box>
  );
}
