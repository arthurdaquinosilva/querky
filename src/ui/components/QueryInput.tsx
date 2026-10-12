import { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useVimInput, type VimMode } from '../hooks/useVimInput.js';
import { BUILTIN_COMMAND_LIST, getCompletions } from '../../commands/router.js';
import { getSqlCompletions, getCurrentToken, applyCompletion, fuzzyMatchPositions, type Schema } from '../completions.js';
import { tokenizeSql } from '../sqlHighlight.js';
import { theme } from '../theme.js';
import { matchRanges } from '../historySearch.js';

const MAX_SUGGESTIONS = 6;
const PLACEHOLDER = 'Type a SQL query, / for commands, ! for shell';

const SHORTCUTS: Array<[string, string]> = [
  ['/', 'for commands'],
  ['!', 'for shell mode'],
  ['\\⏎', 'for newline'],
  ['tab', 'to autocomplete'],
  ['↑ ↓', 'for history'],
  ['ctrl+g', 'to edit in $EDITOR'],
  ['ctrl+r', 'to search history'],
  ['ctrl+c', 'to clear input / exit'],
  ['esc', 'for NORMAL mode (vim)'],
  ['/help', 'for all commands'],
];

const BUILTIN_DESC_MAP: Record<string, string> = Object.fromEntries(
  BUILTIN_COMMAND_LIST.map((c) => [c.name, c.description]),
);

function useColumns() {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns ?? 80);
  useEffect(() => {
    const onResize = () => setColumns(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return columns;
}

interface Glyph {
  ch: string;
  color?: string;
  bold?: boolean;
}

function glyphs(text: string, sql: boolean): Glyph[] {
  if (!sql) return [...text].map((ch) => ({ ch }));
  const colors: Record<string, string | undefined> = theme.sql;
  return tokenizeSql(text).flatMap((tok) => [...tok.text].map((ch) => ({ ch, color: colors[tok.type] })));
}

interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  cursor: boolean;
  selected: boolean;
}

/** One rendered line split into runs of identical style. */
function lineSegments(
  line: Glyph[],
  offset: number,
  cursor: number | null,
  selection: [number, number] | null,
): Segment[] {
  const segs: Segment[] = [];
  const cells = cursor !== null && cursor === offset + line.length ? [...line, { ch: ' ' }] : line;
  cells.forEach((g, i) => {
    const pos = offset + i;
    const seg: Segment = {
      text: g.ch,
      color: g.color,
      bold: g.bold,
      cursor: pos === cursor,
      selected: selection !== null && pos >= selection[0] && pos < selection[1],
    };
    const last = segs[segs.length - 1];
    if (last && !last.cursor && !seg.cursor && last.color === seg.color && last.bold === seg.bold && last.selected === seg.selected) {
      last.text += seg.text;
    } else segs.push(seg);
  });
  return segs;
}

function Segments({ segs }: { segs: Segment[] }) {
  return (
    <Text wrap="wrap">
      {segs.length === 0 ? ' ' : segs.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          bold={s.bold}
          inverse={s.cursor}
          backgroundColor={s.selected && !s.cursor ? theme.subtle : undefined}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function FuzzyHighlight({ text, token, selected }: { text: string; token: string; selected: boolean }) {
  const color = selected ? theme.accent : undefined;
  if (!token) return <Text color={color}>{text}</Text>;
  const matched = new Set(fuzzyMatchPositions(token.toLowerCase(), text.toLowerCase()));
  return (
    <>
      {[...text].map((ch, i) => (
        <Text key={i} color={color} bold={matched.has(i)}>
          {ch}
        </Text>
      ))}
    </>
  );
}

function ShortcutsPanel({ columns }: { columns: number }) {
  const colW = Math.max(...SHORTCUTS.map(([k, d]) => k.length + d.length + 1)) + 4;
  const perRow = Math.max(1, Math.min(3, Math.floor((columns - 2) / colW)));
  const rows: Array<Array<[string, string]>> = [];
  for (let i = 0; i < SHORTCUTS.length; i += perRow) rows.push(SHORTCUTS.slice(i, i + perRow));
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((row, i) => (
        <Box key={i}>
          {row.map(([k, d]) => (
            <Box key={k} width={colW}>
              <Text color={theme.muted}>
                <Text bold>{k}</Text> {d}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

interface QueryInputProps {
  onSubmit: (query: string) => void;
  isLoading: boolean;
  onModeChange?: (mode: VimMode) => void;
  onExitRequest: () => void;
  vimEnabled?: boolean;
  history?: string[];
  aliases?: Record<string, string>;
  schema?: Schema;
  status?: string;
  notice?: string | null;
  vimRemaps?: Record<string, string>;
}

export function QueryInput({
  onSubmit,
  isLoading,
  onModeChange,
  onExitRequest,
  vimEnabled = true,
  history = [],
  aliases = {},
  schema,
  status,
  notice,
  vimRemaps,
}: QueryInputProps) {
  const columns = useColumns();

  function handleTab(current: string): string | null {
    if (!current.startsWith('/')) return null;
    const matches = getCompletions(current.slice(1), aliases);
    if (matches.length === 0) return null;
    if (matches.length === 1) return `/${matches[0]} `;
    let prefix = matches[0];
    for (const m of matches.slice(1)) {
      while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (!prefix) return null;
    }
    return `/${prefix}`;
  }

  function suggestionsFor(v: string, cur: number): string[] {
    if (v.startsWith('/')) return v.includes(' ') ? [] : getCompletions(v.slice(1), aliases);
    if (v.startsWith('!') || !schema || !v.trim()) return [];
    return getSqlCompletions(v, cur, schema);
  }

  function acceptSuggestion(v: string, cur: number, suggestion: string) {
    if (v.startsWith('/')) {
      const val = `/${suggestion} `;
      return { value: val, cursor: val.length };
    }
    return applyCompletion(v, cur, suggestion);
  }

  const input = useVimInput({
    onSubmit,
    isActive: !isLoading,
    vimEnabled,
    history,
    getSuggestions: suggestionsFor,
    acceptSuggestion,
    eagerSuggestions: (v) => v.startsWith('/'),
    onTab: handleTab,
    onExitRequest,
    vimRemaps,
  });
  const { text, cursor, mode, shell, suggestionIndex, showHelp, selection, pending, search } = input;

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const isCommand = !shell && text.startsWith('/');
  const isSql = !shell && !isCommand;

  // Debounced so fast typing doesn't re-render the list on every key.
  const live = suggestionsFor(text, cursor);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const liveKey = live.join('\0');
  useEffect(() => {
    const t = setTimeout(() => setSuggestions(live), suggestionIndex >= 0 ? 0 : 80);
    return () => clearTimeout(t);
  }, [liveKey, suggestionIndex]);

  const showSuggestions = !isLoading && !search && !shell && mode === 'INSERT' && !text.includes('\n') && suggestions.length > 0 && (isCommand || suggestionIndex >= 0 || text.length > 0);
  const token = isCommand ? text.slice(1) : getCurrentToken(text, cursor);

  const winStart = Math.min(Math.max(0, suggestionIndex - MAX_SUGGESTIONS + 1), Math.max(0, suggestions.length - MAX_SUGGESTIONS));
  const visible = suggestions.slice(winStart, winStart + MAX_SUGGESTIONS);
  const nameW = Math.min(28, Math.max(...visible.map((s) => s.length + (isCommand ? 1 : 0)))) + 3;

  // When a suggestion is selected, preview it in place while keeping the typed stem.
  const preview = suggestionIndex >= 0 && live[suggestionIndex] ? acceptSuggestion(text, cursor, live[suggestionIndex]) : null;
  // While searching history, the prompt previews the current match with the term highlighted.
  const searchShown = search?.match ?? null;
  const shownText = searchShown !== null ? searchShown.replace(/^!\s*/, '') : (preview?.value ?? text);
  const shownCursor = isLoading || search ? null : (preview?.cursor ?? cursor);

  const accent = shell ? theme.shellMode : theme.subtle;
  const rule = '─'.repeat(Math.max(10, columns));
  const all = glyphs(shownText, searchShown !== null ? !searchShown.startsWith('!') && !searchShown.startsWith('/') : isSql);
  if (search) {
    for (const [a, b] of matchRanges(shownText, search.query)) {
      for (let i = a; i < b; i++) all[i] = { ...all[i], color: theme.accent, bold: true };
    }
  }
  const lines: Array<{ glyphs: Glyph[]; offset: number }> = [];
  let offset = 0;
  for (const line of shownText.split('\n')) {
    lines.push({ glyphs: all.slice(offset, offset + line.length), offset });
    offset += line.length + 1;
  }

  const modeLabel = mode === 'INSERT' ? '-- INSERT --' : mode === 'NORMAL' ? '' : `-- ${mode} --`;
  const left = notice
    ? { text: notice, color: theme.warning }
    : shell
      ? { text: '! for shell mode · esc to exit', color: theme.shellMode }
      : vimEnabled && modeLabel
        ? { text: modeLabel, color: theme.muted }
        : vimEnabled && mode === 'NORMAL'
          ? { text: pending, color: theme.muted }
          : { text: '? for shortcuts', color: theme.muted };

  return (
    <Box flexDirection="column">
      <Text color={accent}>{rule}</Text>
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color={shell ? theme.shellMode : theme.muted} bold={shell}>
            {shell ? '!' : '>'}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {shownText === '' ? (
            <Text>
              <Text inverse={shownCursor !== null} color={theme.subtle}>
                {(shell ? 'Run a shell command' : PLACEHOLDER)[0]}
              </Text>
              <Text color={theme.subtle}>{(shell ? 'Run a shell command' : PLACEHOLDER).slice(1)}</Text>
            </Text>
          ) : (
            lines.map((l, i) => (
              <Segments key={i} segs={lineSegments(l.glyphs, l.offset, shownCursor, selection)} />
            ))
          )}
        </Box>
      </Box>
      <Text color={accent}>{rule}</Text>

      {search ? (
        <Box paddingLeft={2} justifyContent="space-between" width={columns}>
          <Box flexShrink={0} marginRight={2}>
            <Text color={theme.muted}>
              search history: <Text color={undefined}>{search.query}</Text>
              <Text inverse> </Text>
              {!search.query && search.fromSlash && <Text color={theme.subtle}>   esc then i then / for the command menu</Text>}
            </Text>
          </Box>
          <Box paddingRight={1}>
            <Text color={theme.subtle}>
              {search.query ? (search.total ? `${search.index + 1}/${search.total} · ctrl+r older` : 'no matches') : 'type to search'}
            </Text>
          </Box>
        </Box>
      ) : showHelp ? (
        <ShortcutsPanel columns={columns} />
      ) : showSuggestions ? (
        <Box flexDirection="column" paddingLeft={2}>
          {visible.map((name, i) => {
            const selected = winStart + i === suggestionIndex;
            const desc = isCommand ? (BUILTIN_DESC_MAP[name] ?? aliases[name] ?? '') : '';
            const label = (isCommand ? '/' : '') + name;
            return (
              <Box key={name}>
                <Box width={nameW} flexShrink={0}>
                  <Text wrap="truncate-end">
                    {isCommand && <Text color={selected ? theme.accent : undefined}>/</Text>}
                    <FuzzyHighlight text={label.slice(isCommand ? 1 : 0)} token={token} selected={selected} />
                  </Text>
                </Box>
                {desc && (
                  <Text color={selected ? theme.accent : theme.muted} wrap="truncate-end">
                    {desc}
                  </Text>
                )}
              </Box>
            );
          })}
          {suggestions.length > MAX_SUGGESTIONS && (
            <Text color={theme.subtle}>
              {suggestionIndex + 1 > 0 ? `${suggestionIndex + 1}/` : ''}
              {suggestions.length} matches
            </Text>
          )}
        </Box>
      ) : (
        <Box paddingLeft={2} justifyContent="space-between" width={columns}>
          <Box flexShrink={0} marginRight={2}>
            <Text color={left.color}>{left.text || ' '}</Text>
          </Box>
          {status && (
            <Box paddingRight={1} flexShrink={1}>
              <Text color={theme.subtle} wrap="truncate-start">
                {status}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
