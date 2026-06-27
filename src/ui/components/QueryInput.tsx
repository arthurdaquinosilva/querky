import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useVimInput, type VimMode } from '../hooks/useVimInput.js';
import { BUILTIN_COMMAND_LIST, getCompletions } from '../../commands/router.js';
import { getSqlCompletions, getCurrentToken, applyCompletion, fuzzyMatchPositions, type Schema } from '../completions.js';
import { tokenizeSql, type TokenType } from '../sqlHighlight.js';
import { theme } from '../theme.js';

function FuzzyHighlight({ text, token, selected }: { text: string; token: string; selected: boolean }) {
  if (!token) return <Text dimColor={!selected}>{text}</Text>;
  const matched = new Set(fuzzyMatchPositions(token.toLowerCase(), text.toLowerCase()));
  type Seg = { chars: string; hit: boolean };
  const segs: Seg[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = matched.has(i);
    const last = segs[segs.length - 1];
    if (last && last.hit === hit) last.chars += text[i];
    else segs.push({ chars: text[i], hit });
  }
  return (
    <>
      {segs.map((seg, i) =>
        seg.hit
          ? <Text key={i} color={ACCENT} bold>{seg.chars}</Text>
          : <Text key={i} dimColor={!selected}>{seg.chars}</Text>
      )}
    </>
  );
}

const BG = '#1e1e1e';
const ACCENT = theme.insertMode;
const PROMPT_MUTED = '#6b7280';
const PLACEHOLDER = '#4b5563';
const KW_COLOR = '#a5b4fc';
const STR_COLOR = '#fb923c';
const NUM_COLOR = '#86efac';
const CMT_COLOR = '#6b7280';

function sqlTokenColor(type: TokenType): string | undefined {
  if (type === 'keyword') return KW_COLOR;
  if (type === 'string') return STR_COLOR;
  if (type === 'number') return NUM_COLOR;
  if (type === 'comment') return CMT_COLOR;
  return undefined;
}

function SqlLine({ text, bg }: { text: string; bg?: string }) {
  const tokens = tokenizeSql(text);
  return (
    <>
      {tokens.map((tok, i) => (
        <Text key={i} backgroundColor={bg} color={sqlTokenColor(tok.type)}>{tok.text}</Text>
      ))}
    </>
  );
}

function SqlHighlightedInput({ text, cursorAt, mode, pad }: { text: string; cursorAt: number; mode: VimMode; pad: string }) {
  const tokens = tokenizeSql(text);
  const parts: React.ReactElement[] = [];
  let pos = 0;
  let cursorDone = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const tokEnd = pos + tok.text.length;
    const color = sqlTokenColor(tok.type);

    if (!cursorDone && cursorAt >= pos && cursorAt < tokEnd) {
      const rel = cursorAt - pos;
      const before = tok.text.slice(0, rel);
      const ch = tok.text[rel];
      const after = tok.text.slice(rel + 1);
      if (before) parts.push(<Text key={`${i}b`} backgroundColor={BG} color={color}>{before}</Text>);
      if (mode === 'INSERT') {
        // ▌ replaces the char at cursor — same width as the replaced char.
        parts.push(<Text key={`${i}c`} backgroundColor={BG} color={PROMPT_MUTED} bold>{'▌'}</Text>);
      } else {
        parts.push(<Text key={`${i}c`} backgroundColor={ACCENT} color={BG} bold>{ch || ' '}</Text>);
      }
      if (after) parts.push(<Text key={`${i}a`} backgroundColor={BG} color={color}>{after}</Text>);
      cursorDone = true;
    } else {
      parts.push(<Text key={i} backgroundColor={BG} color={color}>{tok.text}</Text>);
    }

    pos = tokEnd;
  }

  if (!cursorDone) {
    if (mode === 'INSERT') {
      parts.push(<Text key="c" backgroundColor={BG} color={PROMPT_MUTED} bold>{'▌'}</Text>);
    } else {
      parts.push(<Text key="c" backgroundColor={ACCENT} color={BG} bold>{' '}</Text>);
    }
  }

  parts.push(<Text key="pad" backgroundColor={BG}>{pad}</Text>);
  return <>{parts}</>;
}

const HINTS = {
  INSERT: [
    ['Esc', 'NORMAL MODE'],
    ['Enter', 'RUN QUERY'],
    ['Ctrl+E', 'EDITOR'],
    ['!cmd', 'SHELL'],
    ['Ctrl+C', 'EXIT'],
  ],
  NORMAL: [
    ['i/a/A', 'INSERT'],
    ['h/l', 'MOVE'],
    ['w/b', 'WORD'],
    ['0/$', 'LINE ENDS'],
    ['dd/cc/S', 'CLEAR'],
    ['x/s/dw/cw', 'DELETE'],
    ['D/C', 'TO END'],
    ['e', 'EDITOR'],
  ],
  PLAIN: [
    ['Enter', 'RUN QUERY'],
    ['!cmd', 'SHELL'],
    ['Ctrl+C', 'EXIT'],
    ['Ctrl+Z', 'BACKGROUND'],
    ['/toggle-vim-mode', 'ENABLE VIM'],
  ],
} as const;

const BUILTIN_DESC_MAP = Object.fromEntries(BUILTIN_COMMAND_LIST.map((c) => [c.name, c.description]));

interface QueryInputProps {
  onSubmit: (query: string) => void;
  isLoading: boolean;
  onModeChange?: (mode: VimMode) => void;
  onShellModeChange?: (isShell: boolean) => void;
  vimEnabled?: boolean;
  history?: string[];
  aliases?: Record<string, string>;
  schema?: Schema;
}

export function QueryInput({ onSubmit, isLoading, onModeChange, onShellModeChange, vimEnabled = true, history = [], aliases = {}, schema }: QueryInputProps) {
  function handleTab(current: string): string | null {
    if (!current.startsWith('/')) return null;
    const partial = current.slice(1);
    const matches = getCompletions(partial, aliases);
    if (matches.length === 0) return null;
    if (matches.length === 1) return `/${matches[0]}`;
    let prefix = matches[0];
    for (const m of matches.slice(1)) {
      while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (!prefix) return null;
    }
    return `/${prefix}`;
  }

  function handleSuggestionAccept(v: string, cur: number, suggestion: string) {
    if (v.startsWith('/')) {
      const val = `/${suggestion}`;
      return { value: val, cursor: val.length };
    }
    return applyCompletion(v, cur, suggestion);
  }

  const { value, cursor: cursorPos, mode, suggestionIndex } = useVimInput(
    onSubmit, !isLoading, vimEnabled, handleTab, history,
    (v, cur) => v.startsWith('/') ? getCompletions(v.slice(1), aliases) : (schema ? getSqlCompletions(v, cur, schema) : []),
    handleSuggestionAccept,
  );

  const isShellMode = value.startsWith('!');
  const isCommand = !isShellMode && value.startsWith('/');
  const partial = isCommand ? value.slice(1) : '';

  // Live suggestions — kept in sync with useVimInput's internal list so the
  // prompt preview (suggestionIndex → renderValue) is always correct.
  const liveSuggestions = isCommand
    ? getCompletions(partial, aliases)
    : (!isShellMode && schema ? getSqlCompletions(value, cursorPos, schema) : []);
  const sqlToken = isCommand ? '' : getCurrentToken(value, cursorPos);

  // Debounced suggestions — used only for the strip display to reduce the
  // number of Ink re-renders while the user is typing quickly.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setSuggestions(liveSuggestions), 150);
    return () => clearTimeout(t);
  }, [value, cursorPos]);

  const descMap: Record<string, string> = {
    ...BUILTIN_DESC_MAP,
    ...Object.fromEntries(
      Object.entries(aliases).map(([name, sql]) => [
        name,
        sql.length > 55 ? sql.slice(0, 55) + '…' : sql,
      ])
    ),
  };

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    onShellModeChange?.(isShellMode);
  }, [isShellMode, onShellModeChange]);

  const termWidth = process.stdout.columns ?? 80;
  const innerWidth = termWidth - 2; // App paddingX={1} consumes 1 char each side
  const emptyLine = ' '.repeat(innerWidth);

  const isEmpty = value === '';
  const isMultiLine = !isEmpty && !isShellMode && !isCommand && value.includes('\n');
  const dOff = isShellMode ? 2 : 0;

  const placeholder = 'Type a SQL query…';

  // When a suggestion is selected, preview the completed text in the prompt
  // while keeping the typed stem in `value` so suggestion filtering stays correct.
  const previewResult = !isMultiLine && suggestionIndex >= 0 && liveSuggestions.length > 0
    ? handleSuggestionAccept(value, cursorPos, liveSuggestions[suggestionIndex])
    : null;
  const renderValue = previewResult?.value ?? value;
  const renderCursor = previewResult?.cursor ?? cursorPos;

  // Scrolled single-line input: show a lineWidth-wide window around the cursor
  // so the input line never wraps. This avoids both the BG-gap and cursor-at-
  // wrap-boundary bugs that plague multi-line Ink text nodes.
  const lineWidth = innerWidth - 4; // 4 = prompt '  > ' or '  $ '
  const displayValue = renderValue.slice(dOff);
  const displayCursor = Math.max(0, renderCursor - dOff);
  // Scroll so the cursor stays at the rightmost visible position when overflowing
  const scrollStart = displayCursor > lineWidth - 1 ? displayCursor - lineWidth + 1 : 0;

  // Non-SQL / shell / command path slices
  const visibleBefore = displayValue.slice(scrollStart, displayCursor);
  const cursorChar = renderCursor < dOff ? ' ' : (displayValue[displayCursor] ?? ' ');
  const visibleAfter = displayValue.slice(displayCursor + 1, scrollStart + lineWidth);
  const textPad = ' '.repeat(Math.max(0, lineWidth - visibleBefore.length - 1 - visibleAfter.length));

  // SQL-highlighted path slices (dOff is always 0 for SQL mode)
  const visibleSql = renderValue.slice(scrollStart, scrollStart + lineWidth);
  const relativeSqlCursor = renderCursor - scrollStart;
  const sqlCursorAtEnd = relativeSqlCursor >= visibleSql.length;
  const sqlPad = ' '.repeat(Math.max(0, lineWidth - visibleSql.length - (sqlCursorAtEnd ? 1 : 0)));

  // Empty-placeholder pad fills remainder of BG line
  const emptyPad = ' '.repeat(Math.max(0, lineWidth - placeholder.length - 1));

  const SEP = '  |  ';
  const allHints = vimEnabled ? HINTS[mode] : HINTS.PLAIN;
  const totalHintsWidth = allHints.reduce(
    (w, [key, desc], i) => w + (i > 0 ? SEP.length : 0) + desc.length + 2 + key.length,
    0,
  );
  const hintsInline = totalHintsWidth <= termWidth;

  // Suggestion strip — computed before render so JSX stays structurally stable
  const STRIP_VISIBLE = 4;
  const stripPrefixW = isCommand ? 1 : 0;
  const stripAvailW = termWidth - 2 - 3 /* '  …' */ - (STRIP_VISIBLE - 1) * 3 - STRIP_VISIBLE * stripPrefixW;
  const stripMaxPerItem = Math.max(6, Math.floor(stripAvailW / STRIP_VISIBLE));
  const hasSuggestions = !isEmpty && !isShellMode && !isMultiLine && suggestions.length > 0;
  const stripWinStart = hasSuggestions
    ? Math.min(Math.max(0, suggestionIndex - 1), Math.max(0, suggestions.length - STRIP_VISIBLE))
    : 0;
  const stripWindow = hasSuggestions ? suggestions.slice(stripWinStart, stripWinStart + STRIP_VISIBLE) : [];
  const stripNavHint = hasSuggestions
    ? `Tab/↑↓ navigate  Enter select  ${suggestionIndex + 1}/${suggestions.length}`
    : ' ';
  function truncateSugg(s: string) {
    return s.length > stripMaxPerItem ? s.slice(0, stripMaxPerItem - 1) + '…' : s;
  }

  return (
    <Box flexDirection="column">
      {isMultiLine ? (
        <>
          <Text backgroundColor={BG}>{emptyLine}</Text>
          {value.split('\n').map((line, i, arr) => {
            const numW = String(arr.length).length;
            const prefixWidth = 2 + numW + 3; // "  N │ "
            const contentWidth = innerWidth - prefixWidth;
            const isLast = i === arr.length - 1;
            const linePad = ' '.repeat(Math.max(0, contentWidth - line.length - (isLast ? 1 : 0)));
            return (
              <Box key={i}>
                <Text backgroundColor={BG} dimColor>{'  '}{String(i + 1).padStart(numW)}{' │ '}</Text>
                <SqlLine text={line} bg={BG} />
                {isLast && (mode === 'INSERT'
                  ? <Text backgroundColor={BG} color={PROMPT_MUTED} bold>{'▌'}</Text>
                  : <Text backgroundColor={ACCENT} color={BG} bold>{' '}</Text>
                )}
                <Text backgroundColor={BG}>{linePad}</Text>
              </Box>
            );
          })}
          <Text backgroundColor={BG}>{emptyLine}</Text>
        </>
      ) : (
        <>
          <Text backgroundColor={BG}>{emptyLine}</Text>

          {/* Input line */}
          <Box>
            <Text backgroundColor={BG} color={isShellMode ? theme.shellMode : PROMPT_MUTED} bold>{isShellMode ? '  $ ' : '  > '}</Text>
            {isEmpty ? (
              <>
                <Text backgroundColor={BG} color={PLACEHOLDER}>{placeholder}</Text>
                <Text backgroundColor={BG} color={PROMPT_MUTED} bold>{'▌'}</Text>
                <Text backgroundColor={BG}>{emptyPad}</Text>
              </>
            ) : isShellMode || isCommand ? (
              <>
                <Text backgroundColor={BG}>{visibleBefore}</Text>
                {mode === 'INSERT' ? (
                  <Text backgroundColor={BG} color={PROMPT_MUTED} bold>{'▌'}</Text>
                ) : (
                  <Text backgroundColor={ACCENT} color={BG} bold>{cursorChar}</Text>
                )}
                <Text backgroundColor={BG}>{visibleAfter}{textPad}</Text>
              </>
            ) : (
              <SqlHighlightedInput text={visibleSql} cursorAt={relativeSqlCursor} mode={mode} pad={sqlPad} />
            )}
          </Box>

          <Text backgroundColor={BG}>{emptyLine}</Text>
        </>
      )}

      {/* Bottom: fixed 2-row block — suggestions strip or hints, then nav/empty */}
      <Box flexDirection="column" marginTop={1}>
        {/* Row 1 */}
        <Box marginLeft={2}>
          {hasSuggestions ? (
            <>
              {stripWindow.map((name, i) => {
                const realIdx = stripWinStart + i;
                const selected = realIdx === suggestionIndex;
                return (
                  <Text key={name}>
                    {i > 0 && <Text dimColor>{'   '}</Text>}
                    {isCommand && <Text dimColor={!selected} color={selected ? ACCENT : undefined}>/</Text>}
                    <FuzzyHighlight text={truncateSugg(name)} token={isCommand ? partial : sqlToken} selected={selected} />
                  </Text>
                );
              })}
              {suggestions.length > STRIP_VISIBLE && <Text dimColor>{'  …'}</Text>}
            </>
          ) : (
            <Box flexDirection={hintsInline ? 'row' : 'column'}>
              {allHints.map(([key, desc], i) => (
                <Text key={desc}>
                  {hintsInline && i > 0 && <Text dimColor>{'  |  '}</Text>}
                  <Text color={ACCENT} bold>{desc}</Text>
                  <Text dimColor>{`: ${key}`}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
        {/* Row 2 */}
        <Text dimColor>{stripNavHint}</Text>
      </Box>
    </Box>
  );
}
