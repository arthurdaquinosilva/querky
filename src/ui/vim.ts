// Pure prompt editor with vim keybindings, modelled on Claude Code's vim mode.
// The buffer is a single string (lines separated by '\n'); every key produces a
// new state plus an optional action the caller handles (submit, history, …).

export type VimMode = 'INSERT' | 'NORMAL' | 'VISUAL' | 'VISUAL LINE';

export interface VimKey {
  input: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  tab?: boolean;
}

interface Snapshot {
  text: string;
  cursor: number;
}

interface Register {
  text: string;
  linewise: boolean;
}

export interface VimState {
  text: string;
  cursor: number;
  mode: VimMode;
  pending: string;
  anchor: number;
  register: Register;
  undo: Snapshot[];
  redo: Snapshot[];
  /** Buffer as it was when the current INSERT session began; pushed to undo on its first edit. */
  insertStart: Snapshot | null;
  /** Column that j/k (and ↑/↓ in INSERT) try to return to across shorter lines. */
  goal: number | null;
  /** Last char typed in INSERT that could start a remapped sequence (e.g. the first j of jj). */
  remapPending: { ch: string; at: number; cursor: number } | null;
  lastFind: { cmd: string; ch: string } | null;
  lastChange: VimKey[] | null;
  recording: VimKey[] | null;
}

export type VimAction = 'submit' | 'history-prev' | 'history-next' | 'open-editor';

export interface VimResult {
  state: VimState;
  action?: VimAction;
}

const UNDO_LIMIT = 100;
const INDENT = '  ';

export function createVimState(text = '', mode: VimMode = 'INSERT'): VimState {
  return {
    text,
    cursor: mode === 'INSERT' ? text.length : clampNormal(text, text.length),
    mode,
    pending: '',
    anchor: 0,
    register: { text: '', linewise: false },
    undo: [],
    redo: [],
    insertStart: { text, cursor: text.length },
    goal: null,
    remapPending: null,
    lastFind: null,
    lastChange: null,
    recording: null,
  };
}

/** Replace the buffer (history recall, editor, clear) keeping registers and repeat state. */
export function setVimText(s: VimState, text: string, mode: VimMode = s.mode === 'INSERT' ? 'INSERT' : 'NORMAL'): VimState {
  const cursor = mode === 'INSERT' ? text.length : clampNormal(text, text.length);
  return { ...s, text, cursor, mode, pending: '', undo: [], redo: [], insertStart: { text, cursor }, recording: null };
}

// ── Text helpers ──────────────────────────────────────────────────────────────

const lineStart = (t: string, p: number) => (p <= 0 ? 0 : t.lastIndexOf('\n', p - 1) + 1);
const lineEnd = (t: string, p: number) => {
  const i = t.indexOf('\n', p);
  return i < 0 ? t.length : i;
};
const lineIndex = (t: string, p: number) => {
  let n = 0;
  for (let i = 0; i < p && i < t.length; i++) if (t[i] === '\n') n++;
  return n;
};
const lineCount = (t: string) => lineIndex(t, t.length) + 1;
const lineAt = (t: string, n: number) => {
  let p = 0;
  for (let i = 0; i < n; i++) {
    const nl = t.indexOf('\n', p);
    if (nl < 0) return p;
    p = nl + 1;
  }
  return p;
};
const firstNonBlank = (t: string, p: number) => {
  let i = lineStart(t, p);
  const e = lineEnd(t, p);
  while (i < e && (t[i] === ' ' || t[i] === '\t')) i++;
  return i;
};

export function clampNormal(t: string, p: number): number {
  const s = lineStart(t, Math.min(p, t.length));
  const e = lineEnd(t, s);
  return Math.max(s, Math.min(p, e - 1));
}

/** 0 = whitespace, 1 = word, 2 = punctuation; WORD motions treat all non-blanks as 1. */
const cls = (ch: string | undefined, big: boolean) =>
  ch === undefined || /\s/.test(ch) ? 0 : big || /\w/.test(ch) ? 1 : 2;

function wordForward(t: string, p: number, big: boolean) {
  let i = p;
  const c = cls(t[i], big);
  if (c !== 0) while (i < t.length && cls(t[i], big) === c) i++;
  while (i < t.length && cls(t[i], big) === 0) i++;
  return i;
}

function wordEnd(t: string, p: number, big: boolean) {
  let i = p + 1;
  while (i < t.length && cls(t[i], big) === 0) i++;
  const c = cls(t[i], big);
  while (i + 1 < t.length && cls(t[i + 1], big) === c) i++;
  return Math.max(0, Math.min(i, t.length - 1));
}

function wordBack(t: string, p: number, big: boolean) {
  let i = p - 1;
  while (i > 0 && cls(t[i], big) === 0) i--;
  const c = cls(t[i], big);
  while (i > 0 && cls(t[i - 1], big) === c) i--;
  return Math.max(0, i);
}

// ── Motions ───────────────────────────────────────────────────────────────────

type MotionKind = 'exclusive' | 'inclusive' | 'linewise';
interface MotionResult {
  pos: number;
  kind: MotionKind;
}

const SINGLE_MOTIONS = new Set(['h', 'l', ' ', 'j', 'k', 'w', 'W', 'b', 'B', 'e', 'E', '0', '^', '$', 'G', ';', ',']);
const FIND_MOTIONS = new Set(['f', 'F', 't', 'T']);

function parseMotion(p: string, i: number): { motion: string; next: number } | 'more' | 'bad' {
  const c = p[i];
  if (c === undefined) return 'more';
  if (SINGLE_MOTIONS.has(c)) return { motion: c, next: i + 1 };
  if (c === 'g') {
    if (p[i + 1] === undefined) return 'more';
    return p[i + 1] === 'g' ? { motion: 'gg', next: i + 2 } : 'bad';
  }
  if (FIND_MOTIONS.has(c)) {
    if (p[i + 1] === undefined) return 'more';
    return { motion: c + p[i + 1], next: i + 2 };
  }
  return 'bad';
}

function findInLine(t: string, p: number, cmd: string, ch: string, count: number, repeat = false): number | null {
  const s = lineStart(t, p);
  const e = lineEnd(t, p);
  const forward = cmd === 'f' || cmd === 't';
  let i = p;
  for (let n = 0; n < count; n++) {
    // t/T skip an adjacent match so repeating with ; makes progress.
    let j = forward ? i + 1 : i - 1;
    if (repeat && n === 0 && (cmd === 't' || cmd === 'T') && t[j] === ch) j += forward ? 1 : -1;
    while (j >= s && j < e && t[j] !== ch) j += forward ? 1 : -1;
    if (j < s || j >= e) return null;
    i = j;
  }
  if (cmd === 't') return i - 1;
  if (cmd === 'T') return i + 1;
  return i;
}

function runMotion(
  s: VimState,
  motion: string,
  count: number,
  hasCount: boolean,
  forOperator: string | null,
): { result: MotionResult | null; lastFind?: VimState['lastFind'] } {
  const t = s.text;
  const p = s.cursor;
  const ls = lineStart(t, p);
  const le = lineEnd(t, p);

  switch (motion) {
    case 'h':
      return { result: { pos: Math.max(ls, p - count), kind: 'exclusive' } };
    case 'l':
    case ' ':
      return { result: { pos: Math.min(le, p + count), kind: 'exclusive' } };
    case 'j':
    case 'k': {
      const line = lineIndex(t, p) + (motion === 'j' ? count : -count);
      if (line < 0 || line >= lineCount(t)) return { result: null };
      const start = lineAt(t, line);
      const col = s.goal ?? p - ls;
      return { result: { pos: Math.min(start + col, Math.max(start, lineEnd(t, start) - 1)), kind: 'linewise' } };
    }
    case 'w':
    case 'W': {
      const big = motion === 'W';
      if (forOperator === 'c' && cls(t[p], big) !== 0) {
        let e = p;
        for (let n = 0; n < count; n++) e = n === 0 && cls(t[e + 1], big) !== cls(t[e], big) ? e : wordEnd(t, e, big);
        return { result: { pos: e, kind: 'inclusive' } };
      }
      let q = p;
      for (let n = 0; n < count; n++) q = wordForward(t, q, big);
      // dw on the last word of a line stops at the line end instead of eating the newline.
      if (forOperator && q > le && p < le) q = le;
      return { result: { pos: q, kind: 'exclusive' } };
    }
    case 'e':
    case 'E': {
      let q = p;
      for (let n = 0; n < count; n++) q = wordEnd(t, q, motion === 'E');
      return { result: { pos: q, kind: 'inclusive' } };
    }
    case 'b':
    case 'B': {
      let q = p;
      for (let n = 0; n < count; n++) q = wordBack(t, q, motion === 'B');
      return { result: { pos: q, kind: 'exclusive' } };
    }
    case '0':
      return { result: { pos: ls, kind: 'exclusive' } };
    case '^':
      return { result: { pos: firstNonBlank(t, p), kind: 'exclusive' } };
    case '$':
      return le === ls
        ? { result: { pos: ls, kind: 'exclusive' } }
        : { result: { pos: le - 1, kind: 'inclusive' } };
    case 'gg':
      return { result: { pos: lineAt(t, hasCount ? Math.min(count, lineCount(t)) - 1 : 0), kind: 'linewise' } };
    case 'G':
      return { result: { pos: lineAt(t, hasCount ? Math.min(count, lineCount(t)) - 1 : lineCount(t) - 1), kind: 'linewise' } };
    case ';':
    case ',': {
      if (!s.lastFind) return { result: null };
      const { cmd, ch } = s.lastFind;
      const flip: Record<string, string> = { f: 'F', F: 'f', t: 'T', T: 't' };
      const c = motion === ',' ? flip[cmd] : cmd;
      const pos = findInLine(t, p, c, ch, count, true);
      return { result: pos === null ? null : { pos, kind: c === 'f' || c === 't' ? 'inclusive' : 'exclusive' } };
    }
  }

  if (FIND_MOTIONS.has(motion[0])) {
    const cmd = motion[0];
    const ch = motion.slice(1);
    const pos = findInLine(t, p, cmd, ch, count);
    return {
      result: pos === null ? null : { pos, kind: cmd === 'f' || cmd === 't' ? 'inclusive' : 'exclusive' },
      lastFind: { cmd, ch },
    };
  }
  return { result: null };
}

// ── Text objects ──────────────────────────────────────────────────────────────

const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
};

function textObject(t: string, p: number, kind: 'i' | 'a', obj: string): [number, number] | null {
  if (obj === 'w' || obj === 'W') {
    const big = obj === 'W';
    const c = (i: number) => (t[i] === '\n' ? 3 : cls(t[i], big));
    if (p >= t.length) return null;
    const k = c(p);
    let s = p;
    let e = p + 1;
    while (s > 0 && c(s - 1) === k) s--;
    while (e < t.length && c(e) === k) e++;
    if (kind === 'a') {
      if (k !== 0) {
        const e0 = e;
        while (e < t.length && c(e) === 0) e++;
        if (e === e0) while (s > 0 && c(s - 1) === 0) s--;
      } else if (e < t.length && c(e) !== 3) {
        const k2 = c(e);
        while (e < t.length && c(e) === k2) e++;
      }
    }
    return [s, e];
  }

  if (obj === '"' || obj === "'" || obj === '`') {
    const ls = lineStart(t, p);
    const le = lineEnd(t, p);
    const quotes: number[] = [];
    for (let i = ls; i < le; i++) if (t[i] === obj && t[i - 1] !== '\\') quotes.push(i);
    for (let i = 0; i + 1 < quotes.length; i += 2) {
      const [q0, q1] = [quotes[i], quotes[i + 1]];
      if (p <= q1) {
        if (kind === 'i') return [q0 + 1, q1];
        let e = q1 + 1;
        while (e < le && t[e] === ' ') e++;
        return [q0, e];
      }
    }
    return null;
  }

  const pair = PAIRS[obj];
  if (pair) {
    const [open, close] = pair;
    let depth = 0;
    let s = -1;
    for (let i = t[p] === close ? p - 1 : p; i >= 0; i--) {
      if (t[i] === close) depth++;
      else if (t[i] === open) {
        if (depth === 0) {
          s = i;
          break;
        }
        depth--;
      }
    }
    if (s < 0) return null;
    depth = 0;
    for (let i = s + 1; i < t.length; i++) {
      if (t[i] === open) depth++;
      else if (t[i] === close) {
        if (depth === 0) return kind === 'i' ? [s + 1, i] : [s, i + 1];
        depth--;
      }
    }
  }
  return null;
}

// ── Edits ─────────────────────────────────────────────────────────────────────

function withUndo(s: VimState): VimState {
  const undo = [...s.undo, { text: s.text, cursor: s.cursor }].slice(-UNDO_LIMIT);
  return { ...s, undo, redo: [], insertStart: null };
}

function enterInsert(s: VimState, cursor: number): VimState {
  return { ...s, mode: 'INSERT', cursor, pending: '', insertStart: { text: s.text, cursor: s.cursor } };
}

function lineRange(t: string, a: number, b: number): [number, number] {
  return [lineStart(t, Math.min(a, b)), lineEnd(t, Math.max(a, b))];
}

function applyOperator(
  s: VimState,
  op: string,
  start: number,
  end: number,
  linewise: boolean,
): VimState {
  const t = s.text;

  if (op === '>' || op === '<') {
    const [ls, le] = lineRange(t, start, end);
    const lines = t.slice(ls, le).split('\n').map((l) => {
      if (op === '>') return l.length ? INDENT + l : l;
      let n = 0;
      while (n < INDENT.length && l[n] === ' ') n++;
      return l.slice(n);
    });
    const text = t.slice(0, ls) + lines.join('\n') + t.slice(le);
    const n = withUndo(s);
    return { ...n, text, cursor: firstNonBlank(text, ls) };
  }

  if (linewise) {
    const [ls, le] = lineRange(t, start, end);
    const register = { text: t.slice(ls, le), linewise: true };
    if (op === 'y') return { ...s, register, cursor: ls < lineStart(t, s.cursor) ? ls : s.cursor };
    const n = withUndo(s);
    if (op === 'c') {
      const indent = t.slice(ls, firstNonBlank(t, ls));
      const text = t.slice(0, ls) + indent + t.slice(le);
      return enterInsert({ ...n, text, register, insertStart: null }, ls + indent.length);
    }
    let text: string;
    let at: number;
    if (le < t.length) {
      text = t.slice(0, ls) + t.slice(le + 1);
      at = ls;
    } else if (ls > 0) {
      text = t.slice(0, ls - 1);
      at = lineStart(text, ls - 1);
    } else {
      text = '';
      at = 0;
    }
    return { ...n, text, register, cursor: clampNormal(text, firstNonBlank(text, at)) };
  }

  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(t.length, Math.max(start, end));
  const register = { text: t.slice(a, b), linewise: false };
  if (op === 'y') return { ...s, register, cursor: a };
  if (a === b && op === 'd') return s;
  const n = withUndo(s);
  const text = t.slice(0, a) + t.slice(b);
  if (op === 'c') return enterInsert({ ...n, text, register, insertStart: null }, a);
  return { ...n, text, register, cursor: clampNormal(text, a) };
}

function paste(s: VimState, before: boolean, count: number): VimState {
  const { text: reg, linewise } = s.register;
  if (!reg) return s;
  const t = s.text;
  const n = withUndo(s);
  const body = Array(count).fill(reg).join(linewise ? '\n' : '');
  if (linewise) {
    if (before) {
      const ls = lineStart(t, s.cursor);
      const text = t.slice(0, ls) + body + '\n' + t.slice(ls);
      return { ...n, text, cursor: firstNonBlank(text, ls) };
    }
    const le = lineEnd(t, s.cursor);
    const text = t.slice(0, le) + '\n' + body + t.slice(le);
    return { ...n, text, cursor: firstNonBlank(text, le + 1) };
  }
  const at = before || t.length === 0 || t[s.cursor] === '\n' ? s.cursor : s.cursor + 1;
  const text = t.slice(0, at) + body + t.slice(at);
  return { ...n, text, cursor: Math.max(0, at + body.length - 1) };
}

function joinLines(s: VimState, count: number): VimState {
  let t = s.text;
  let cursor = s.cursor;
  let changed = false;
  for (let i = 0; i < Math.max(1, count - 1); i++) {
    const le = lineEnd(t, cursor);
    if (le >= t.length) break;
    let next = le + 1;
    while (next < t.length && (t[next] === ' ' || t[next] === '\t')) next++;
    const sep = t[next] === '\n' || next >= t.length || t[le - 1] === ' ' || le === lineStart(t, le) ? '' : ' ';
    t = t.slice(0, le) + sep + t.slice(next);
    cursor = le;
    changed = true;
  }
  if (!changed) return s;
  return { ...withUndo(s), text: t, cursor: clampNormal(t, cursor) };
}

function mapChars(s: VimState, a: number, b: number, fn: (ch: string) => string): VimState {
  const t = s.text;
  const mapped = [...t.slice(a, b)].map((ch) => (ch === '\n' ? ch : fn(ch))).join('');
  return { ...withUndo(s), text: t.slice(0, a) + mapped + t.slice(b) };
}

const toggleCase = (ch: string) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());

// ── Key handling ──────────────────────────────────────────────────────────────

function insertText(s: VimState, str: string): VimState {
  const base = s.insertStart ? withUndo({ ...s, text: s.insertStart.text, cursor: s.insertStart.cursor }) : s;
  const t = s.text;
  return { ...base, text: t.slice(0, s.cursor) + str + t.slice(s.cursor), cursor: s.cursor + str.length, insertStart: null };
}

function deleteRange(s: VimState, a: number, b: number): VimState {
  if (a >= b) return s;
  const base = s.insertStart ? withUndo({ ...s, text: s.insertStart.text, cursor: s.insertStart.cursor }) : s;
  return { ...base, text: s.text.slice(0, a) + s.text.slice(b), cursor: a, insertStart: null };
}

function verticalMove(s: VimState, dir: -1 | 1): VimState | null {
  const t = s.text;
  const line = lineIndex(t, s.cursor) + dir;
  if (line < 0 || line >= lineCount(t)) return null;
  const col = s.goal ?? s.cursor - lineStart(t, s.cursor);
  const start = lineAt(t, line);
  const max = s.mode === 'INSERT' ? lineEnd(t, start) : Math.max(start, lineEnd(t, start) - 1);
  return { ...s, cursor: Math.min(start + col, max), goal: col };
}

function handleInsert(s: VimState, key: VimKey, vimEnabled: boolean): VimResult {
  const t = s.text;
  const p = s.cursor;
  const rec = (st: VimState): VimState => (st.recording ? { ...st, recording: [...st.recording, key] } : st);

  if (key.escape) {
    if (!vimEnabled) return { state: s };
    const lastChange = s.recording ? [...s.recording, key] : s.lastChange;
    return {
      state: { ...s, mode: 'NORMAL', cursor: Math.max(lineStart(t, p), p - 1), recording: null, lastChange, insertStart: null },
    };
  }
  if (key.ctrl && key.input === 'g') return { state: s, action: 'open-editor' };
  if (key.return) {
    if (key.meta || key.shift) return { state: rec(insertText(s, '\n')) };
    if (p > 0 && t[p - 1] === '\\') return { state: rec(insertText(deleteRange(s, p - 1, p), '\n')) };
    return { state: s, action: 'submit' };
  }
  if (key.upArrow) {
    const moved = verticalMove(s, -1);
    return moved ? { state: moved } : { state: s, action: 'history-prev' };
  }
  if (key.downArrow) {
    const moved = verticalMove(s, 1);
    return moved ? { state: moved } : { state: s, action: 'history-next' };
  }
  if (key.leftArrow) return { state: { ...s, cursor: key.meta || key.ctrl ? wordBack(t, p, false) : Math.max(0, p - 1) } };
  if (key.rightArrow) {
    return { state: { ...s, cursor: key.meta || key.ctrl ? Math.min(t.length, wordForward(t, p, false)) : Math.min(t.length, p + 1) } };
  }
  if (key.home) return { state: { ...s, cursor: lineStart(t, p) } };
  if (key.end) return { state: { ...s, cursor: lineEnd(t, p) } };
  if (key.backspace) {
    if (key.meta || key.ctrl) return { state: rec(deleteRange(s, wordBack(t, p, false), p)) };
    return { state: rec(deleteRange(s, Math.max(0, p - 1), p)) };
  }
  if (key.delete) return { state: rec(deleteRange(s, p, Math.min(t.length, p + 1))) };

  if (key.ctrl) {
    switch (key.input) {
      case 'a':
        return { state: { ...s, cursor: lineStart(t, p) } };
      case 'e':
        return { state: { ...s, cursor: lineEnd(t, p) } };
      case 'b':
        return { state: { ...s, cursor: Math.max(0, p - 1) } };
      case 'f':
        return { state: { ...s, cursor: Math.min(t.length, p + 1) } };
      case 'u':
        return { state: rec(deleteRange(s, lineStart(t, p), p)) };
      case 'k':
        return { state: rec(deleteRange(s, p, lineEnd(t, p))) };
      case 'w':
        return { state: rec(deleteRange(s, wordBack(t, p, false), p)) };
      case 'd':
        return { state: rec(deleteRange(s, p, Math.min(t.length, p + 1))) };
      case 'h':
        return { state: rec(deleteRange(s, Math.max(0, p - 1), p)) };
    }
    return { state: s };
  }
  if (key.meta) {
    if (key.input === 'b') return { state: { ...s, cursor: wordBack(t, p, false) } };
    if (key.input === 'f') return { state: { ...s, cursor: Math.min(t.length, wordForward(t, p, false)) } };
    if (key.input === 'd') return { state: rec(deleteRange(s, p, wordForward(t, p, false))) };
    return { state: s };
  }
  if (key.tab || !key.input) return { state: s };
  // Backslash and Enter typed fast can arrive as a single chunk.
  if (key.input === '\\\r') return { state: rec(insertText(s, '\n')) };
  return { state: rec(insertText(s, key.input.replace(/\r\n?/g, '\n'))) };
}

/** Normal/visual keys reduced to the characters the command parser understands. */
function normalChar(key: VimKey): string | null {
  if (key.leftArrow || key.backspace) return 'h';
  if (key.rightArrow) return 'l';
  if (key.upArrow) return 'k';
  if (key.downArrow) return 'j';
  if (key.home) return '0';
  if (key.end) return '$';
  if (key.delete) return 'x';
  if (key.ctrl || key.meta || key.tab) return null;
  return key.input.length === 1 ? key.input : null;
}

function readCount(p: string, i: number): { count: number | null; next: number } {
  let j = i;
  if (p[j] === undefined || p[j] < '1' || p[j] > '9') return { count: null, next: i };
  while (p[j] !== undefined && p[j] >= '0' && p[j] <= '9') j++;
  return { count: Math.min(9999, Number(p.slice(i, j))), next: j };
}

const OPERATORS = new Set(['d', 'c', 'y', '>', '<']);

function handleNormal(s: VimState, key: VimKey): VimResult {
  if (key.escape) return { state: { ...s, pending: '' } };
  if (key.return && !s.pending) return { state: s, action: 'submit' };
  if (key.ctrl && key.input === 'g') return { state: s, action: 'open-editor' };
  if (key.ctrl && key.input === 'r') {
    const next = s.redo[s.redo.length - 1];
    if (!next) return { state: s };
    return {
      state: {
        ...s,
        undo: [...s.undo, { text: s.text, cursor: s.cursor }],
        redo: s.redo.slice(0, -1),
        text: next.text,
        cursor: clampNormal(next.text, next.cursor),
      },
    };
  }

  const ch = normalChar(key);
  if (ch === null) return { state: { ...s, pending: '' } };
  const pending = s.pending + ch;
  const result = runNormal({ ...s, pending: '' }, pending);
  if (result === 'more') return { state: { ...s, pending } };
  if (result === 'bad') return { state: { ...s, pending: '' } };
  return result;
}

function runNormal(s: VimState, p: string): VimResult | 'more' | 'bad' {
  const t = s.text;
  const { count: c1, next: i1 } = readCount(p, 0);
  const c = p[i1];
  if (c === undefined) return 'more';
  const count = c1 ?? 1;
  const keys = [...p].map((input) => ({ input }));
  const changed = (st: VimState): VimResult => {
    const isInsert = st.mode === 'INSERT';
    return {
      state: {
        ...st,
        lastChange: isInsert ? st.lastChange : keys,
        recording: isInsert ? keys : null,
      },
    };
  };

  if (OPERATORS.has(c)) {
    const { count: c2, next: i2 } = readCount(p, i1 + 1);
    const total = count * (c2 ?? 1);
    const n = p[i2];
    if (n === undefined) return 'more';
    if (n === c) {
      const last = lineAt(t, Math.min(lineCount(t) - 1, lineIndex(t, s.cursor) + total - 1));
      return changed(applyOperator(s, c, s.cursor, last, true));
    }
    if (n === 'i' || n === 'a') {
      const obj = p[i2 + 1];
      if (obj === undefined) return 'more';
      const range = textObject(t, s.cursor, n, obj);
      if (!range) return 'bad';
      return changed(applyOperator(s, c, range[0], range[1], false));
    }
    const m = parseMotion(p, i2);
    if (m === 'more' || m === 'bad') return m;
    if (m.next !== p.length) return 'bad';
    const { result, lastFind } = runMotion(s, m.motion, total, c1 !== null || c2 !== null, c);
    if (!result) return 'bad';
    const st = lastFind ? { ...s, lastFind } : s;
    const linewise = result.kind === 'linewise';
    const end = result.kind === 'inclusive' ? result.pos + 1 : result.pos;
    const out = applyOperator(st, c, st.cursor, linewise ? result.pos : end, linewise);
    return c === 'y' ? { state: out } : changed(out);
  }

  if (c === 'r') {
    const r = p[i1 + 1];
    if (r === undefined) return 'more';
    const le = lineEnd(t, s.cursor);
    if (s.cursor + count > le) return 'bad';
    const n = withUndo(s);
    const text = t.slice(0, s.cursor) + r.repeat(count) + t.slice(s.cursor + count);
    return changed({ ...n, text, cursor: s.cursor + count - 1 });
  }

  if (c === 'g' && p[i1 + 1] === undefined) return 'more';

  const m = parseMotion(p, i1);
  if (m !== 'bad') {
    if (m === 'more') return 'more';
    const { result, lastFind } = runMotion(s, m.motion, count, c1 !== null, null);
    if (!result) {
      if (m.motion === 'k') return { state: s, action: 'history-prev' };
      if (m.motion === 'j') return { state: s, action: 'history-next' };
      return 'bad';
    }
    const cursor = s.mode === 'NORMAL' ? clampNormal(t, result.pos) : Math.min(result.pos, Math.max(0, t.length - 1));
    const goal = m.motion === 'j' || m.motion === 'k' ? (s.goal ?? s.cursor - lineStart(t, s.cursor)) : null;
    return { state: { ...s, cursor, goal, ...(lastFind ? { lastFind } : {}) } };
  }

  if (p.length !== i1 + 1) return 'bad';
  const ls = lineStart(t, s.cursor);
  const le = lineEnd(t, s.cursor);

  switch (c) {
    case 'i':
      return changed(enterInsert(s, s.cursor));
    case 'a':
      return changed(enterInsert(s, Math.min(le, s.cursor + (le > ls ? 1 : 0))));
    case 'I':
      return changed(enterInsert(s, firstNonBlank(t, s.cursor)));
    case 'A':
      return changed(enterInsert(s, le));
    case 'o': {
      const n = withUndo(s);
      return changed(enterInsert({ ...n, text: t.slice(0, le) + '\n' + t.slice(le) }, le + 1));
    }
    case 'O': {
      const n = withUndo(s);
      return changed(enterInsert({ ...n, text: t.slice(0, ls) + '\n' + t.slice(ls) }, ls));
    }
    case 'v':
      return { state: { ...s, mode: 'VISUAL', anchor: s.cursor } };
    case 'V':
      return { state: { ...s, mode: 'VISUAL LINE', anchor: s.cursor } };
    case 'x':
      return le === ls ? 'bad' : changed(applyOperator(s, 'd', s.cursor, Math.min(le, s.cursor + count), false));
    case 'X':
      return s.cursor === ls ? 'bad' : changed(applyOperator(s, 'd', Math.max(ls, s.cursor - count), s.cursor, false));
    case 's':
      return changed(applyOperator(s, 'c', s.cursor, Math.min(le, s.cursor + count), false));
    case 'S':
      return changed(applyOperator(s, 'c', s.cursor, s.cursor, true));
    case 'C':
      return changed(applyOperator(s, 'c', s.cursor, le, false));
    case 'D':
      return changed(applyOperator(s, 'd', s.cursor, le, false));
    case 'Y':
      return { state: applyOperator(s, 'y', s.cursor, s.cursor, true) };
    case 'p':
    case 'P':
      return changed(paste(s, c === 'P', count));
    case 'J':
      return changed(joinLines(s, Math.max(2, count)));
    case '~': {
      const b = Math.min(le, s.cursor + count);
      if (b === s.cursor) return 'bad';
      const out = mapChars(s, s.cursor, b, toggleCase);
      return changed({ ...out, cursor: clampNormal(out.text, b) });
    }
    case 'u': {
      const prev = s.undo[s.undo.length - 1];
      if (!prev) return 'bad';
      return {
        state: {
          ...s,
          redo: [...s.redo, { text: s.text, cursor: s.cursor }],
          undo: s.undo.slice(0, -1),
          text: prev.text,
          cursor: clampNormal(prev.text, prev.cursor),
        },
      };
    }
    case '.':
      return repeatLastChange(s);
  }
  return 'bad';
}

function repeatLastChange(s: VimState): VimResult {
  if (!s.lastChange) return { state: s };
  let st: VimState = { ...s, pending: '' };
  for (const k of s.lastChange) st = vimKey(st, k, true).state;
  return { state: { ...st, lastChange: s.lastChange, recording: null } };
}

function handleVisual(s: VimState, key: VimKey): VimResult {
  const t = s.text;
  if (key.escape) return { state: { ...s, mode: 'NORMAL', pending: '' } };
  if (key.ctrl && key.input === 'g') return { state: s, action: 'open-editor' };
  const ch = normalChar(key);
  if (ch === null) return { state: s };
  const p = s.pending + ch;
  const lineMode = s.mode === 'VISUAL LINE';
  const lo = Math.min(s.anchor, s.cursor);
  const hi = Math.max(s.anchor, s.cursor);
  const [a, b] = lineMode ? lineRange(t, lo, hi) : [lo, Math.min(t.length, hi + 1)];
  const toNormal = (st: VimState): VimResult => ({
    state: { ...st, mode: st.mode === 'INSERT' ? 'INSERT' : 'NORMAL', pending: '', cursor: st.mode === 'INSERT' ? st.cursor : clampNormal(st.text, st.cursor) },
  });

  const { count: c1, next } = readCount(p, 0);
  const c = p[next];
  if (c === undefined) return { state: { ...s, pending: p } };

  if ((c === 'i' || c === 'a') && p.length === next + 1) return { state: { ...s, pending: p } };
  if ((c === 'i' || c === 'a') && p.length === next + 2) {
    const range = textObject(t, s.cursor, c, p[next + 1]);
    if (!range || range[1] <= range[0]) return { state: { ...s, pending: '' } };
    return { state: { ...s, mode: 'VISUAL', anchor: range[0], cursor: range[1] - 1, pending: '' } };
  }
  if (c === 'r') {
    if (p.length === next + 1) return { state: { ...s, pending: p } };
    const r = p[next + 1];
    return toNormal({ ...mapChars(s, a, b, () => r), cursor: a });
  }

  if (p.length === next + 1) {
    switch (c) {
      case 'v':
      case 'V': {
        const target: VimMode = c === 'v' ? 'VISUAL' : 'VISUAL LINE';
        return { state: { ...s, mode: s.mode === target ? 'NORMAL' : target, pending: '' } };
      }
      case 'o':
        return { state: { ...s, anchor: s.cursor, cursor: s.anchor, pending: '' } };
      case 'd':
      case 'x':
        return toNormal(applyOperator(s, 'd', a, lineMode ? b - 1 : b, lineMode));
      case 'y':
        return toNormal({ ...applyOperator(s, 'y', a, lineMode ? b - 1 : b, lineMode), cursor: a });
      case 'c':
      case 's':
        return toNormal(applyOperator(s, 'c', a, lineMode ? b - 1 : b, lineMode));
      case 'p': {
        if (!s.register.text) return toNormal(s);
        const text = t.slice(0, a) + s.register.text + t.slice(b);
        return toNormal({ ...withUndo(s), text, cursor: a + Math.max(0, s.register.text.length - 1) });
      }
      case '~':
      case 'u':
      case 'U': {
        const fn = c === '~' ? toggleCase : c === 'u' ? (x: string) => x.toLowerCase() : (x: string) => x.toUpperCase();
        return toNormal({ ...mapChars(s, a, b, fn), cursor: a });
      }
      case '>':
      case '<':
        return toNormal(applyOperator(s, c, a, b, true));
      case 'J':
        return toNormal(joinLines({ ...s, cursor: a }, Math.max(2, lineIndex(t, b) - lineIndex(t, a) + 1)));
    }
  }

  const m = parseMotion(p, next);
  if (m === 'more') return { state: { ...s, pending: p } };
  if (m === 'bad') return { state: { ...s, pending: '' } };
  const { result, lastFind } = runMotion(s, m.motion, c1 ?? 1, c1 !== null, null);
  if (!result) return { state: { ...s, pending: '' } };
  return {
    state: { ...s, cursor: clampNormal(t, result.pos), pending: '', ...(lastFind ? { lastFind } : {}) },
  };
}

export interface VimOptions {
  /** INSERT-mode two-key sequences mapped to Escape, e.g. { jj: '<Esc>' }. */
  remaps?: Record<string, string>;
  /** Timestamp of this key in ms; defaults to Date.now(). */
  now?: number;
}

const REMAP_WINDOW_MS = 1000;

const isPlainChar = (key: VimKey) =>
  key.input.length === 1 && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !key.backspace && !key.delete;

export function vimKey(s: VimState, key: VimKey, vimEnabled: boolean, opts: VimOptions = {}): VimResult {
  const remaps = opts.remaps;
  if (!vimEnabled || !remaps || Object.keys(remaps).length === 0) return dispatchKey(s, key, vimEnabled);

  const now = opts.now ?? Date.now();
  const p = s.remapPending;
  const cleared = p ? { ...s, remapPending: null } : s;
  if (s.mode !== 'INSERT' || !isPlainChar(key)) return dispatchKey(cleared, key, vimEnabled);

  // Second key of a sequence within the window: drop the first char and act as Escape.
  if (p && now - p.at <= REMAP_WINDOW_MS && s.cursor === p.cursor + 1 && s.text[p.cursor] === p.ch && remaps[p.ch + key.input] === '<Esc>') {
    let st: VimState = {
      ...cleared,
      text: s.text.slice(0, p.cursor) + s.text.slice(p.cursor + 1),
      cursor: p.cursor,
      recording: s.recording ? s.recording.slice(0, -1) : null,
    };
    const top = st.undo[st.undo.length - 1];
    if (top && top.text === st.text) st = { ...st, undo: st.undo.slice(0, -1) };
    return dispatchKey(st, { input: '', escape: true }, true);
  }

  const r = dispatchKey(cleared, key, vimEnabled);
  const startsSequence = Object.keys(remaps).some((k) => [...k][0] === key.input);
  if (!startsSequence || r.state.mode !== 'INSERT') return r;
  return { ...r, state: { ...r.state, remapPending: { ch: key.input, at: now, cursor: s.cursor } } };
}

function dispatchKey(s: VimState, key: VimKey, vimEnabled: boolean): VimResult {
  // Keys typed faster than a read (or sent by tmux/ssh) arrive as one chunk; outside INSERT
  // each character is a separate command, and a switch to INSERT mid-chunk types the rest.
  if (vimEnabled && s.mode !== 'INSERT' && key.input.length > 1 && !key.ctrl && !key.meta) {
    let st = s;
    let action: VimAction | undefined;
    for (const ch of key.input) {
      const r = vimKey(st, { input: ch }, true);
      st = r.state;
      action = r.action ?? action;
    }
    return { state: st, action };
  }
  // Esc followed quickly by a key arrives as one Meta+key chunk; vim reads it as both keys.
  if (vimEnabled && key.meta && !key.ctrl && key.input.length === 1 && !key.return) {
    const escaped = vimKey(s, { input: '', escape: true }, true).state;
    return vimKey(escaped, { input: key.input }, true);
  }
  const r =
    !vimEnabled || s.mode === 'INSERT'
      ? handleInsert({ ...s, mode: 'INSERT' }, key, vimEnabled)
      : s.mode === 'NORMAL'
        ? handleNormal(s, key)
        : handleVisual(s, key);
  // Only vertical moves (and the counts typed before them) keep the remembered column.
  const typed = s.pending + (key.input.length === 1 ? key.input : '');
  const vertical =
    key.upArrow || key.downArrow || (vimEnabled && s.mode !== 'INSERT' && /^\d*[jk]?$/.test(typed) && typed !== '');
  return vertical || r.state.goal === null ? r : { ...r, state: { ...r.state, goal: null } };
}

/** Selected [start, end) range while in a visual mode, for rendering. */
export function visualRange(s: VimState): [number, number] | null {
  if (s.mode !== 'VISUAL' && s.mode !== 'VISUAL LINE') return null;
  const lo = Math.min(s.anchor, s.cursor);
  const hi = Math.max(s.anchor, s.cursor);
  if (s.mode === 'VISUAL LINE') return lineRange(s.text, lo, hi);
  return [lo, Math.min(s.text.length, hi + 1)];
}
