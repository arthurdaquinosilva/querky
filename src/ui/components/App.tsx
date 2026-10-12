import { useState, useEffect, useRef } from 'react';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, Static, Text, useApp, useInput, useStdin } from 'ink';
import type { ConnectionState, DbResult } from '../../db/client.js';
import { runQuery } from '../../db/query.js';
import { runCommand } from '../../commands/router.js';
import { fetchErd, focusErd } from '../../db/erd.js';
import { runShell } from '../../commands/shell.js';
import { streamExplain } from '../../ai/client.js';
import { loadHistory, saveHistory, addToHistory } from '../../config/history.js';
import { getAllAliases, saveAlias, deleteAlias, makeScope } from '../../config/aliases.js';
import { loadSettings } from '../../config/settings.js';
import { fetchSchema, type Schema } from '../../db/schema.js';
import { QueryInput } from './QueryInput.js';
import { Banner } from './Banner.js';
import { Spinner } from './Spinner.js';
import { fmtEntry, fmtPromptEcho, fmtBody, fmtError, type EntryData } from '../format.js';

// What the dynamic (prompt) area shows while work is in flight
type ActiveState =
  | { type: 'idle' }
  | { type: 'loading'; label: string; query: string }
  | { type: 'streaming'; query: string; text: string; error: string | null };

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
  const [exitArmed, setExitArmed] = useState(false);
  const [settings] = useState(loadSettings);
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

  // Claude Code semantics: Ctrl+C clears the prompt (handled by the input), and on an
  // empty prompt the first press arms exit and a second one within a moment quits.
  useEffect(() => {
    if (!exitArmed) return;
    const t = setTimeout(() => setExitArmed(false), 1500);
    return () => clearTimeout(t);
  }, [exitArmed]);

  function requestExit() {
    if (exitArmed) exit();
    else setExitArmed(true);
  }

  useInput(
    (input, key) => {
      const inputOwnsCtrlC = connectionState.status === 'connected' && active.type === 'idle';
      if (key.ctrl && input === 'c' && !inputOwnsCtrlC) exit();
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
    setActive({ type: 'loading', label: 'Running query', query: sql });
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

  async function handleErd(table?: string) {
    if (connectionState.status !== 'connected') {
      writeEntry({ query: '/erd', commandMessage: { ok: false, text: 'Not connected.' }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
      return;
    }
    setActive({ type: 'loading', label: 'Drawing diagram', query: table ? `/erd ${table}` : '/erd' });
    try {
      const all = await fetchErd(connectionState.client, connectionState.driver);
      const data = table ? focusErd(all, table) : all;
      if (!data) throw new Error(`No table named "${table}". Run /erd to see all tables.`);
      writeEntry({ query: table ? `/erd ${table}` : '/erd', commandMessage: null, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: data });
    } catch (err) {
      writeEntry({ query: table ? `/erd ${table}` : '/erd', commandMessage: { ok: false, text: err instanceof Error ? err.message : String(err) }, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: '', aiError: null, shellOutput: null, erdData: null });
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
    writeEntry({ query: '/explain', echo: `/explain ${query}`, commandMessage: null, queryState: { status: 'idle' }, elapsed: null, page: 0, aiResponse: fullText, aiError: error, shellOutput: null, erdData: null });
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
    setActive({ type: 'loading', label: 'Running', query: q });
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
        onErd: (table) => { void handleErd(table); },
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
  const status = isConnected ? [connectionState.user, connectionState.database].filter(Boolean).join('@') : undefined;

  return (
    <Box flexDirection="column">
      <Static items={completedEntries}>
        {({ id, formatted }) => (
          <Box key={id}>
            <Text>{formatted}</Text>
          </Box>
        )}
      </Static>

      {!hasHistory && active.type === 'idle' && (
        <Box paddingX={1}>
          <Banner connectionState={connectionState} />
        </Box>
      )}

      {active.type === 'loading' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{fmtPromptEcho(active.query)}</Text>
          <Spinner label={active.label} />
        </Box>
      )}

      {active.type === 'streaming' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{fmtPromptEcho(`/explain ${active.query}`)}</Text>
          {active.error ? (
            <Text>{fmtBody(fmtError(active.error))}</Text>
          ) : active.text ? (
            <Text>{fmtBody(active.text + '▋')}</Text>
          ) : (
            <Spinner label="Explaining" />
          )}
        </Box>
      )}

      {isConnected ? (
        <QueryInput
          onSubmit={handleSubmit}
          isLoading={isLoading}
          onExitRequest={requestExit}
          vimEnabled={vimEnabled}
          history={history}
          aliases={aliases}
          schema={schema ?? undefined}
          status={status}
          notice={exitArmed ? 'Press Ctrl-C again to exit' : null}
          vimRemaps={settings.vimInsertModeRemaps}
        />
      ) : (
        <Text dimColor>Not connected. Press Ctrl+C to exit.</Text>
      )}
    </Box>
  );
}
