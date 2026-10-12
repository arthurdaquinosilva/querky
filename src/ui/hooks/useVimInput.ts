import { useRef, useState } from 'react';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useInput, useStdin, type Key } from 'ink';
import { createVimState, setVimText, vimKey, visualRange, type VimMode, type VimState } from '../vim.js';
import { searchHistory } from '../historySearch.js';

export type { VimMode } from '../vim.js';

interface PromptState {
  vim: VimState;
  shell: boolean;
  historyIndex: number; // -1 = not browsing history
  draft: string; // input saved when history browsing started
  suggestionIndex: number; // -1 = none selected
  showHelp: boolean;
  search: HistorySearch | null;
}

interface HistorySearch {
  query: string;
  index: number; // position in the match list; Ctrl+R moves to older matches
  original: string; // full input (with ! prefix), kept if no match is accepted
  mode: VimMode; // mode to land in after accepting
  fromSlash: boolean;
}

export interface PromptInputOptions {
  onSubmit: (value: string) => void;
  isActive: boolean;
  vimEnabled: boolean;
  history: string[];
  getSuggestions: (value: string, cursor: number) => string[];
  acceptSuggestion: (value: string, cursor: number, suggestion: string) => { value: string; cursor: number };
  /** Suggestions that are navigable with ↑/↓ before Tab is pressed (slash commands). */
  eagerSuggestions: (value: string) => boolean;
  onTab?: (value: string) => string | null;
  onExitRequest: () => void;
  vimRemaps?: Record<string, string>;
}

function openEditor(initial: string): string | null {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  const tmpPath = join(tmpdir(), `querky-edit-${Date.now()}.sql`);
  const ttyStdin = process.stdin as { setRawMode?: (mode: boolean) => void };
  try {
    writeFileSync(tmpPath, initial);
    // spawnSync blocks the event loop so the editor owns the TTY; raw mode must be off meanwhile.
    process.stdout.write('\x1B[?25h');
    ttyStdin.setRawMode?.(false);
    spawnSync(editor, [tmpPath], { stdio: 'inherit' });
    process.stdout.write('\x1B[2J\x1B[H\x1B[?25l');
    ttyStdin.setRawMode?.(true);
    return readFileSync(tmpPath, 'utf8').trimEnd();
  } catch {
    ttyStdin.setRawMode?.(true);
    return null;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }
}

function withText(s: PromptState, raw: string, keepMode = true): PromptState {
  const shell = raw.startsWith('!');
  const text = shell ? raw.slice(1).trimStart() : raw;
  const mode: VimMode = keepMode && s.vim.mode !== 'INSERT' ? 'NORMAL' : 'INSERT';
  return { ...s, shell, vim: setVimText(s.vim, text, mode), suggestionIndex: -1 };
}

export function useVimInput(opts: PromptInputOptions) {
  const { isRawModeSupported } = useStdin();
  const [state, setState] = useState<PromptState>(() => ({
    vim: createVimState(),
    shell: false,
    historyIndex: -1,
    draft: '',
    suggestionIndex: -1,
    showHelp: false,
    search: null,
  }));

  // Keys can arrive faster than React re-renders, so each one reduces from the
  // latest state rather than the one captured by the last render.
  const stateRef = useRef(state);
  stateRef.current = state;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const commit = (next: PromptState) => {
    stateRef.current = next;
    setState(next);
  };

  const handleKey = (input: string, key: Key) => {
    const o = optsRef.current;
    const s = stateRef.current;
    const text = s.vim.text;
    const full = (s.shell ? '!' : '') + text;

    if (s.search) return handleSearchKey(s, s.search, input, key, o);

    const inNormal = o.vimEnabled && s.vim.mode === 'NORMAL' && !s.vim.pending;
    const startsSearch = (key.ctrl && input === 'r' && (!o.vimEnabled || s.vim.mode === 'INSERT')) || (inNormal && input === '/' && !key.ctrl && !key.meta);
    if (startsSearch) {
      const mode = o.vimEnabled ? s.vim.mode : 'INSERT';
      commit({ ...s, showHelp: false, suggestionIndex: -1, search: { query: '', index: 0, original: full, mode, fromSlash: input === '/' } });
      return;
    }

    if (key.ctrl && input === 'c') {
      if (text || s.shell) commit({ ...withText(s, '', false), historyIndex: -1, showHelp: false });
      else o.onExitRequest();
      return;
    }
    if (key.ctrl && input === 'd' && !text && !s.shell) {
      o.onExitRequest();
      return;
    }

    const inInsert = !o.vimEnabled || s.vim.mode === 'INSERT';
    if (inInsert && !text && !s.shell && input === '?' && !key.ctrl && !key.meta) {
      commit({ ...s, showHelp: !s.showHelp });
      return;
    }
    const base = s.showHelp ? { ...s, showHelp: false } : s;
    if (inInsert && !text && !s.shell && input === '!' && !key.ctrl && !key.meta) {
      commit({ ...base, shell: true });
      return;
    }
    if (s.shell && !text && (key.backspace || key.delete || key.escape)) {
      commit({ ...base, shell: false });
      return;
    }

    if (inInsert && !s.shell) {
      const sugs = o.getSuggestions(full, s.vim.cursor);
      const selecting = s.suggestionIndex >= 0;
      const navigable = sugs.length > 0 && (selecting || o.eagerSuggestions(full));
      const step = (d: number) => commit({ ...base, suggestionIndex: (s.suggestionIndex + d + sugs.length) % sugs.length });
      if (sugs.length > 0 && key.tab) return step(key.shift ? -1 : 1);
      if (navigable && key.downArrow) return step(1);
      if (navigable && key.upArrow) return step(selecting ? -1 : sugs.length);
      if (selecting && key.escape) return commit({ ...base, suggestionIndex: -1 });
      if (selecting && (key.return || key.rightArrow)) {
        const r = o.acceptSuggestion(full, s.vim.cursor, sugs[s.suggestionIndex] ?? '');
        return commit({ ...base, vim: { ...setVimText(s.vim, r.value, 'INSERT'), cursor: r.cursor }, suggestionIndex: -1 });
      }
      if (key.tab) {
        const completed = o.onTab?.(full);
        if (completed != null) commit({ ...base, vim: setVimText(s.vim, completed, 'INSERT') });
        return;
      }
    }

    const { state: vim, action } = vimKey(base.vim, { ...key, input }, o.vimEnabled, { remaps: o.vimRemaps });
    let next: PromptState = { ...base, vim };
    if (vim.text !== text) next = { ...next, suggestionIndex: -1, historyIndex: -1 };

    if (action === 'submit') {
      const value = full.trim();
      commit({ ...withText(next, '', false), historyIndex: -1, draft: '' });
      if (value && value !== '!') o.onSubmit(value);
      return;
    }
    if (action === 'history-prev' || action === 'history-next') {
      const h = o.history;
      if (action === 'history-prev') {
        if (h.length === 0) return commit(next);
        const idx = s.historyIndex === -1 ? h.length - 1 : Math.max(0, s.historyIndex - 1);
        const draft = s.historyIndex === -1 ? full : s.draft;
        return commit({ ...withText(next, h[idx] ?? ''), historyIndex: idx, draft });
      }
      if (s.historyIndex === -1) return commit(next);
      if (s.historyIndex >= h.length - 1) return commit({ ...withText(next, s.draft), historyIndex: -1, draft: '' });
      const idx = s.historyIndex + 1;
      return commit({ ...withText(next, h[idx] ?? ''), historyIndex: idx });
    }
    if (action === 'open-editor') {
      const edited = openEditor(full);
      if (edited !== null) return commit({ ...withText(next, edited, false), historyIndex: -1 });
    }
    commit(next);
  };

  function handleSearchKey(s: PromptState, search: HistorySearch, input: string, key: Key, o: PromptInputOptions) {
    const matches = searchHistory(o.history, search.query);
    const current = matches[Math.min(search.index, matches.length - 1)];
    const accept = (): PromptState => {
      const chosen = current ?? search.original;
      const next = { ...s, search: null, historyIndex: -1 };
      const withChosen = withText(next, chosen, false);
      return search.mode === 'INSERT' ? withChosen : { ...withChosen, vim: setVimText(withChosen.vim, withChosen.vim.text, 'NORMAL') };
    };

    // The buffer is untouched while searching, so cancelling just drops the search.
    if (key.ctrl && input === 'c') return commit({ ...s, search: null });
    if (key.ctrl && input === 'r') return commit({ ...s, search: { ...search, index: Math.min(search.index + 1, Math.max(0, matches.length - 1)) } });
    if (key.backspace || key.delete) {
      if (!search.query) return commit({ ...s, search: null });
      return commit({ ...s, search: { ...search, query: search.query.slice(0, -1), index: 0 } });
    }
    if (key.escape || key.tab) return commit(accept());
    if (key.return) {
      const accepted = accept();
      const value = ((accepted.shell ? '!' : '') + accepted.vim.text).trim();
      commit({ ...withText(accepted, '', false), historyIndex: -1, draft: '' });
      if (value && value !== '!') o.onSubmit(value);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      return commit({ ...s, search: { ...search, query: search.query + input.replace(/[\r\n]+/g, ' '), index: 0 } });
    }
  }

  useInput(handleKey, { isActive: opts.isActive && (isRawModeSupported ?? false) });

  const mode: VimMode = opts.vimEnabled ? state.vim.mode : 'INSERT';
  return {
    text: state.vim.text,
    cursor: state.vim.cursor,
    mode,
    pending: state.vim.pending,
    shell: state.shell,
    suggestionIndex: state.suggestionIndex,
    showHelp: state.showHelp,
    selection: opts.vimEnabled ? visualRange(state.vim) : null,
    search: state.search
      ? (() => {
          const matches = searchHistory(opts.history, state.search.query);
          const index = Math.min(state.search.index, Math.max(0, matches.length - 1));
          return {
            query: state.search.query,
            match: matches[index] ?? null,
            index,
            total: matches.length,
            fromSlash: state.search.fromSlash,
          };
        })()
      : null,
  };
}
