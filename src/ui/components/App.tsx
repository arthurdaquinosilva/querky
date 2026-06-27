import { useState, useEffect, useRef } from 'react';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, Static, Text, useApp, useInput, useStdin } from 'ink';
import type { ConnectionState, DbResult } from '../../db/client.js';
import { runQuery, type QueryState } from '../../db/query.js';
import { runCommand, type HelpData } from '../../commands/router.js';
import { fetchErd, type ErdData } from '../../db/erd.js';
import { runShell } from '../../commands/shell.js';
import { streamExplain } from '../../ai/client.js';
import { loadHistory, saveHistory, addToHistory } from '../../config/history.js';
import { getAllAliases, saveAlias, deleteAlias, makeScope } from '../../config/aliases.js';
import { fetchSchema, type Schema } from '../../db/schema.js';
import { QueryInput } from './QueryInput.js';
import { ErrorBox } from './QueryResult.js';
import { Banner } from './Banner.js';
import { theme } from '../theme.js';
import type { VimMode } from '../hooks/useVimInput.js';
import { fmtEntry, type EntryData } from '../format.js';

const PLACEHOLDER = theme.muted;
const QUERY_HEADER_COLOR = theme.muted;

// What the dynamic (prompt) area shows while work is in flight
type ActiveState =
  | { type: 'idle' }
  | { type: 'loading'; label: string; query: string }
  | { type: 'streaming'; query: string; text: string; error: string | null };

function QueryHeader({ label, query }: { label: string; query: string }) {
  const isMultiLine = query.includes('\n');
  if (isMultiLine) {
    return (
      <Box flexDirection="column">
        <Text><Text color={theme.accent} bold>{'● '}</Text><Text color={QUERY_HEADER_COLOR} bold>{label}:</Text></Text>
        {query.split('\n').map((line, i) => (
          <Text key={i} color={QUERY_HEADER_COLOR} bold>{'  '}{line}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Text><Text color={theme.accent} bold>{'● '}</Text><Text color={QUERY_HEADER_COLOR} bold>{label}({query})</Text></Text>
  );
}

interface AppProps {
  connectionState: ConnectionState;
  aiUrl: string;
  aiModel: string;
  aiKey: string;
  onChangeDatabase?: (database: string) => void;
}

export function App({ connectionState, aiUrl, aiModel, aiKey, onChangeDatabase }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  const [active, setActive] = useState<ActiveState>({ type: 'idle' });
  const [hasHistory, setHasHistory] = useState(false);
  const [completedEntries, setCompletedEntries] = useState<Array<{ id: string; formatted: string }>>([]);
  const entryIdRef = useRef(0);
  const [lastSqlQuery, setLastSqlQuery] = useState('');
  const [lastResult, setLastResult] = useState<DbResult | null>(null);
  const [lastResultPage, setLastResultPage] = useState(0);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [inputIsShell, setInputIsShell] = useState(false);
  const [vimEnabled, setVimEnabled] = useState(true);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [schema, setSchema] = useState<Schema | null>(null);

  const aliasScope = connectionState.status === 'connected'
    ? makeScope(connectionState.driver, connectionState.user, connectionState.host, connectionState.database)
    : '';
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    aliasScope ? getAllAliases(aliasScope) : {}
  );

  function writeEntry(entry: EntryData) {
    const formatted = fmtEntry(entry);
    const id = String(++entryIdRef.current);
    setCompletedEntries(prev => [...prev, { id, formatted }]);
    setHasHistory(true);
  }

  function handleSaveAlias(name: string, query: string) {
    saveAlias(aliasScope, name, query);
    setAliases(getAllAliases(aliasScope));
  }

  function handleDeleteAlias(name: string): boolean {
    const removed = deleteAlias(aliasScope, name);
    if (removed) setAliases(getAllAliases(aliasScope));
    return removed;
  }

  useEffect(() => {
    if (connectionState.status !== 'connected') { setSchema(null); return; }
    void fetchSchema(connectionState.client, connectionState.driver).then(setSchema);
  }, [connectionState]);

  useEffect(() => {
    if (!isRawModeSupported) return;
    const ttyStdin = process.stdin as { setRawMode?: (mode: boolean) => void };
    const handleCont = () => ttyStdin.setRawMode?.(true);
    process.on('SIGCONT', handleCont);
    return () => { process.off('SIGCONT', handleCont); };
  }, [isRawModeSupported]);

  useEffect(() => {
    if (!isRawModeSupported) return;
    process.stdout.write('\x1B[?25l');
    return () => { process.stdout.write('\x1B[?25h'); };
  }, [isRawModeSupported]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') exit();
      if (key.ctrl && input === 'z') {
        const ttyStdin = process.stdin as { setRawMode?: (mode: boolean) => void };
        ttyStdin.setRawMode?.(false);
        process.kill(process.pid, 'SIGTSTP');
      }
    },
    { isActive: isRawModeSupported },
  );

  async function handleQuery(sql: string) {
    if (connectionState.status !== 'connected') return;
    setLastSqlQuery(sql);
    setActive({ type: 'loading', label: 'Query', query: sql });
    const updated = addToHistory(history, sql);
    setHistory(updated);
    saveHistory(updated);
    const start = Date.now();
    const result = await runQuery(connectionState.client, sql);
    const elapsed = Date.now() - start;
    if (result.status === 'success') { setLastResult(result.result); setLastResultPage(0); }
    writeEntry({ query: sql, commandMessage: null, queryState: result, elapsed, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
    setActive({ type: 'idle' });
  }

  async function handleErd() {
    if (connectionState.status !== 'connected') {
      writeEntry({ query: '/erd', commandMessage: { ok: false, text: 'Not connected.' }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      return;
    }
    setActive({ type: 'loading', label: 'Command', query: '/erd' });
    try {
      const data = await fetchErd(connectionState.client, connectionState.driver);
      writeEntry({ query: '/erd', commandMessage: null, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: data });
    } catch (err) {
      writeEntry({ query: '/erd', commandMessage: { ok: false, text: err instanceof Error ? err.message : String(err) }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
    }
    setActive({ type: 'idle' });
  }

  async function handleExplain(query: string) {
    setActive({ type: 'streaming', query, text: '', error: null });
    let fullText = '';
    let error: string | null = null;
    try {
      for await (const chunk of streamExplain(query, aiUrl, aiModel, aiKey || undefined)) {
        fullText += chunk;
        setActive({ type: 'streaming', query, text: fullText, error: null });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    writeEntry({ query: '/explain', commandMessage: null, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: fullText, aiError: error, shellOutput: null, erdData: null });
    setActive({ type: 'idle' });
  }

  function handleExport(format: 'csv' | 'json') {
    if (!lastResult || lastResult.rows.length === 0) {
      writeEntry({ query: `/export ${format}`, commandMessage: { ok: false, text: 'No results to export — run a query first.' }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = join(homedir(), `q-export-${ts}.${format}`);
    try {
      if (format === 'json') {
        writeFileSync(filename, JSON.stringify(lastResult.rows, null, 2));
      } else {
        const header = lastResult.fields.join(',');
        const rows = lastResult.rows.map((row) =>
          lastResult!.fields.map((f) => {
            const v = row[f];
            if (v === null || v === undefined) return '';
            const s = String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n')
              ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(',')
        );
        writeFileSync(filename, [header, ...rows].join('\n'));
      }
      writeEntry({ query: `/export ${format}`, commandMessage: { ok: true, text: `Exported to ${filename}` }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
    } catch (err) {
      writeEntry({ query: `/export ${format}`, commandMessage: { ok: false, text: err instanceof Error ? err.message : String(err) }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
    }
  }

  async function handleShell(cmd: string) {
    const q = `!${cmd}`;
    setActive({ type: 'loading', label: 'Shell', query: q });
    const result = await runShell(cmd);
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    writeEntry({ query: q, commandMessage: null, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: combined || '(no output)', erdData: null });
    setActive({ type: 'idle' });
  }

  async function handleSubmit(sql: string) {
    if (sql === '/next') {
      if (!lastResult) return;
      const p = lastResultPage + 1;
      setLastResultPage(p);
      writeEntry({ query: '/next', commandMessage: null, queryState: { status: 'success', result: lastResult }, elapsed: null, page: p, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      return;
    }
    if (sql === '/prev') {
      if (!lastResult || lastResultPage === 0) return;
      const p = lastResultPage - 1;
      setLastResultPage(p);
      writeEntry({ query: '/prev', commandMessage: null, queryState: { status: 'success', result: lastResult }, elapsed: null, page: p, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      return;
    }

    if (sql.startsWith('!')) {
      void handleShell(sql.slice(1).trim());
      return;
    }

    if (sql.startsWith('/') || sql.startsWith('\\')) {
      const result = runCommand(sql, {
        vimEnabled,
        setVimEnabled,
        lastSqlQuery,
        currentDatabase: connectionState.status === 'connected' ? connectionState.database : '',
        driver: connectionState.status === 'connected' ? connectionState.driver : 'postgresql',
        onExplain: (query) => { void handleExplain(query); },
        onQuery: (query) => { void handleQuery(query); },
        onChangeDatabase: (db) => { onChangeDatabase?.(db); },
        onExport: handleExport,
        onErd: () => { void handleErd(); },
        onClear: () => {
          setCompletedEntries([]);
          setHasHistory(false);
          setActive({ type: 'idle' });
          process.stdout.write('\x1B[H\x1B[2J\x1B[3J');
        },
        aliases,
        onSaveAlias: handleSaveAlias,
        onDeleteAlias: handleDeleteAlias,
      });
      if (result.cleared) return;
      // Commands that trigger async handlers (erd, explain, query) manage their
      // own active state — only add an entry if there's a direct message/help result.
      if (result.helpData) {
        writeEntry({ query: sql, commandMessage: { ok: result.ok, text: '', helpData: result.helpData }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      } else if (result.message) {
        writeEntry({ query: sql, commandMessage: { ok: result.ok, text: result.message }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      }
      return;
    }

    void handleQuery(sql);
  }

  const isLoading = active.type !== 'idle';
  const isConnected = connectionState.status === 'connected';

  return (
    <Box flexDirection="column">
      <Static items={completedEntries}>
        {({ id, formatted }) => (
          <Box key={id}>
            <Text>{formatted}</Text>
          </Box>
        )}
      </Static>
      <Box flexDirection="column" paddingX={1}>
        {!hasHistory && active.type === 'idle' && (
          <Banner connectionState={connectionState} />
        )}

        {/* Loading indicator — replaces the large active-result block */}
        {active.type === 'loading' && (
          <Box flexDirection="column" marginBottom={1}>
            <QueryHeader label={active.label} query={active.query} />
            <Text dimColor> running…</Text>
          </Box>
        )}

        {/* Streaming AI — grows while streaming, committed to Static on done */}
        {active.type === 'streaming' && (
          <Box flexDirection="column" marginBottom={1}>
            <QueryHeader label="Query" query={active.query} />
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent} bold>Explanation:</Text>
              <Box marginTop={1}>
                {active.error
                  ? <ErrorBox message={active.error} />
                  : <Text color={PLACEHOLDER}>{active.text}<Text color={PLACEHOLDER}>▋</Text></Text>
                }
              </Box>
            </Box>
          </Box>
        )}

        {isConnected ? (
          <QueryInput
            onSubmit={handleSubmit}
            isLoading={isLoading}
            onModeChange={setVimMode}
            onShellModeChange={setInputIsShell}
            vimEnabled={vimEnabled}
            history={history}
            aliases={aliases}
            schema={schema ?? undefined}
          />
        ) : (
          <Text dimColor>Not connected. Press Ctrl+C to exit.</Text>
        )}

        {(vimEnabled || inputIsShell) && (
          <Box marginTop={1}>
            <Text bold color={inputIsShell ? theme.shellMode : (vimMode === 'NORMAL' ? theme.normalMode : theme.insertMode)}>
              {isRawModeSupported ? (inputIsShell ? '[SHELL]' : `[${vimMode}]`) : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
