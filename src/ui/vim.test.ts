import { describe, expect, it } from 'vitest';
import { createVimState, vimKey, visualRange, type VimKey, type VimResult, type VimState } from './vim.js';

const SPECIAL: Record<string, VimKey> = {
  '<Esc>': { input: '', escape: true },
  '<CR>': { input: '\r', return: true },
  '<S-CR>': { input: '\r', return: true, shift: true },
  '<BS>': { input: '', backspace: true },
  '<Up>': { input: '', upArrow: true },
  '<Down>': { input: '', downArrow: true },
  '<C-r>': { input: 'r', ctrl: true },
  '<C-w>': { input: 'w', ctrl: true },
  '<C-u>': { input: 'u', ctrl: true },
  '<C-g>': { input: 'g', ctrl: true },
};

function keys(seq: string): VimKey[] {
  const out: VimKey[] = [];
  for (let i = 0; i < seq.length; ) {
    const m = /^<[A-Za-z-]+>/.exec(seq.slice(i));
    if (m && SPECIAL[m[0]]) {
      out.push(SPECIAL[m[0]]);
      i += m[0].length;
    } else {
      out.push({ input: seq[i] });
      i++;
    }
  }
  return out;
}

function run(start: string, seq: string, opts: { cursor?: number; vim?: boolean } = {}) {
  let state: VimState = { ...createVimState(start, 'NORMAL'), cursor: opts.cursor ?? 0 };
  const actions: string[] = [];
  let last: VimResult = { state };
  for (const k of keys(seq)) {
    last = vimKey(state, k, opts.vim ?? true);
    state = last.state;
    if (last.action) actions.push(last.action);
  }
  return { text: state.text, cursor: state.cursor, mode: state.mode, state, actions };
}

describe('vim normal mode', () => {
  it('moves by words and line ends', () => {
    expect(run('select id from users', 'w').cursor).toBe(7);
    expect(run('select id from users', '2w').cursor).toBe(10);
    expect(run('select id from users', 'e').cursor).toBe(5);
    expect(run('select id from users', '$b').cursor).toBe(15);
    expect(run('  select', '$^').cursor).toBe(2);
    expect(run('select', '$0').cursor).toBe(0);
  });

  it('treats punctuation as its own word but not for WORD motions', () => {
    expect(run('a.b c', 'w').cursor).toBe(1);
    expect(run('a.b c', 'W').cursor).toBe(4);
  });

  it('finds characters and repeats with ; and ,', () => {
    expect(run('a,b,c,d', 'f,').cursor).toBe(1);
    expect(run('a,b,c,d', 'f,;').cursor).toBe(3);
    expect(run('a,b,c,d', 'f,;;,').cursor).toBe(3);
    expect(run('a,b,c,d', 't,').cursor).toBe(0);
    expect(run('a,b,c,d', '$F,').cursor).toBe(5);
    expect(run('a,b,c,d', '$T,').cursor).toBe(6);
  });

  it('deletes with operators and motions', () => {
    expect(run('select id from users', 'dw').text).toBe('id from users');
    expect(run('select id from users', 'd2w').text).toBe('from users');
    expect(run('select id from users', '2dw').text).toBe('from users');
    expect(run('select id from users', 'de').text).toBe(' id from users');
    expect(run('select id from users', '$db').text).toBe('select id from s');
    expect(run('select id from users', 'df ').text).toBe('id from users');
    expect(run('select id from users', 'dt ').text).toBe(' id from users');
    expect(run('select id from users', 'wD').text).toBe('select ');
    expect(run('select id from users', 'w d0').text).toBe('d from users');
  });

  it('does not let dw on the last word eat the newline', () => {
    expect(run('select id\nfrom users', 'wdw').text).toBe('select \nfrom users');
  });

  it('changes text and enters INSERT', () => {
    const r = run('select id from users', 'cwSELECT<Esc>');
    expect(r.text).toBe('SELECT id from users');
    expect(r.mode).toBe('NORMAL');
    expect(run('select id from users', 'wC*<Esc>').text).toBe('select *');
    expect(run('select id from users', 'ccnew<Esc>').text).toBe('new');
    expect(run('abc', 'sX<Esc>').text).toBe('Xbc');
    expect(run('  abc', 'Sx<Esc>').text).toBe('  x');
  });

  it('supports text objects', () => {
    expect(run("where name = 'bob smith'", "f'ldi'").text).toBe("where name = ''");
    expect(run("where name = 'bob smith'", "f'lda'").text).toBe('where name = ');
    expect(run('count(a, (b))', 'fadi(').text).toBe('count()');
    expect(run('count(a, (b))', 'fada(').text).toBe('count');
    expect(run('select id from users', 'wdiw').text).toBe('select  from users');
    expect(run('select id from users', 'wdaw').text).toBe('select from users');
    expect(run('select a.b from x', 'wdiW').text).toBe('select  from x');
    expect(run('[1, 2]', 'lci[9<Esc>').text).toBe('[9]');
    expect(run('{a}', 'lyi{$p').text).toBe('{a}a');
  });

  it('replaces, toggles case, deletes chars', () => {
    expect(run('abc', 'rx').text).toBe('xbc');
    expect(run('abc', '2rx').text).toBe('xxc');
    expect(run('abc', '~~').text).toBe('ABc');
    expect(run('abc', 'x').text).toBe('bc');
    expect(run('abc', '2x').text).toBe('c');
    expect(run('abc', '$X').text).toBe('ac');
  });

  it('yanks and pastes charwise and linewise', () => {
    expect(run('abc', 'ylp').text).toBe('aabc');
    expect(run('abc', 'ywP').text).toBe('abcabc');
    expect(run('one\ntwo', 'yyp').text).toBe('one\none\ntwo');
    expect(run('one\ntwo', 'yyjP').text).toBe('one\none\ntwo');
    expect(run('one\ntwo', 'Yjp').text).toBe('one\ntwo\none');
    expect(run('one\ntwo\nthree', 'ddp').text).toBe('two\none\nthree');
  });

  it('works across lines', () => {
    expect(run('one\ntwo\nthree', 'dd').text).toBe('two\nthree');
    expect(run('one\ntwo\nthree', '2dd').text).toBe('three');
    expect(run('one\ntwo\nthree', 'dj').text).toBe('three');
    expect(run('one\ntwo\nthree', 'Gdk').text).toBe('one');
    expect(run('one\ntwo\nthree', 'jdG').text).toBe('one');
    expect(run('one\ntwo\nthree', 'Gdgg').text).toBe('');
    expect(run('one\ntwo\nthree', 'Gx').text).toBe('one\ntwo\nhree');
    expect(run('one\ntwo', 'J').text).toBe('one two');
    expect(run('one\n   two', 'J').text).toBe('one two');
    expect(run('one', 'otwo<Esc>').text).toBe('one\ntwo');
    expect(run('one', 'Otwo<Esc>').text).toBe('two\none');
    expect(run('a\nb', '>>').text).toBe('  a\nb');
    expect(run('  a\nb', '<<').text).toBe('a\nb');
    expect(run('a\nb', '>j').text).toBe('  a\n  b');
  });

  it('keeps the column when moving vertically', () => {
    const r = run('abcd\nxy\nlmnop', 'lllj');
    expect(r.cursor).toBe(6);
    expect(run('abcd\nxy\nlmnop', 'llljj').cursor).toBe(11);
    expect(run('abcd\nxy\nlmnop', 'llljhj').cursor).toBe(8);
    expect(run('abcd\nxy\nlmnop\nabcdef', 'llljjj').cursor).toBe(17);
    expect(run('abcd\nxy\nlmnop', 'lll2j').cursor).toBe(11);
  });

  it('navigates history with j/k at the edges', () => {
    expect(run('one', 'k').actions).toEqual(['history-prev']);
    expect(run('one', 'j').actions).toEqual(['history-next']);
    expect(run('one\ntwo', 'j').actions).toEqual([]);
    expect(run('one\ntwo', 'jj').actions).toEqual(['history-next']);
  });

  it('undoes and redoes', () => {
    expect(run('select id', 'dwu').text).toBe('select id');
    expect(run('select id', 'dwu<C-r>').text).toBe('id');
    expect(run('abc', 'xxuu').text).toBe('abc');
    expect(run('abc', 'Ax<Esc>Ay<Esc>u').text).toBe('abcx');
  });

  it('repeats the last change with .', () => {
    expect(run('a b c d', 'dw.').text).toBe('c d');
    expect(run('a,b,c', 'x..').text).toBe(',c');
    expect(run('one two', 'cwX<Esc>w.').text).toBe('X X');
    expect(run('a\nb', 'A;<Esc>j.').text).toBe('a;\nb;');
  });

  it('submits on Enter', () => {
    expect(run('select 1', '<CR>').actions).toEqual(['submit']);
  });

  it('ignores unknown sequences without getting stuck', () => {
    const r = run('abc', 'Qx');
    expect(r.text).toBe('bc');
  });
});

describe('vim visual mode', () => {
  it('deletes, yanks and changes a selection', () => {
    expect(run('select id from users', 'vex').text).toBe(' id from users');
    expect(run('select id from users', 'veyP').text).toBe('selectselect id from users');
    expect(run('select id from users', 'wvecname<Esc>').text).toBe('select name from users');
    expect(run('one\ntwo\nthree', 'Vjd').text).toBe('three');
    expect(run('abc', 'vlU').text).toBe('ABc');
    expect(run('abc', 'v$rx').text).toBe('xxx');
  });

  it('selects text objects and swaps ends', () => {
    const r = run("x = 'abc'", "f'lvi'");
    expect(visualRange(r.state)).toEqual([5, 8]);
    const o = run('abcdef', 'lvllo');
    expect(o.cursor).toBe(1);
  });

  it('toggles between visual kinds and exits', () => {
    expect(run('abc', 'vV').mode).toBe('VISUAL LINE');
    expect(run('abc', 'vv').mode).toBe('NORMAL');
    expect(run('abc', 'v<Esc>').mode).toBe('NORMAL');
  });
});

describe('insert mode', () => {
  const ins = (start: string, seq: string, vim = true) => {
    let state = createVimState(start);
    const actions: string[] = [];
    for (const k of keys(seq)) {
      const r = vimKey(state, k, vim);
      state = r.state;
      if (r.action) actions.push(r.action);
    }
    return { text: state.text, cursor: state.cursor, mode: state.mode, actions };
  };

  it('types and edits', () => {
    expect(ins('', 'select').text).toBe('select');
    expect(ins('select', '<BS><BS>').text).toBe('sele');
    expect(ins('select id', '<C-w>').text).toBe('select ');
    expect(ins('select id', '<C-u>').text).toBe('');
  });

  it('inserts newlines with backslash-Enter and Shift+Enter, submits on Enter', () => {
    expect(ins('select *\\', '<CR>').text).toBe('select *\n');
    expect(ins('select *', '<S-CR>from t').text).toBe('select *\nfrom t');
    expect(ins('select 1', '<CR>').actions).toEqual(['submit']);
  });

  it('moves between lines before falling back to history', () => {
    expect(ins('a\nb', '<Up>').actions).toEqual([]);
    expect(ins('a\nb', '<Up><Up>').actions).toEqual(['history-prev']);
    expect(ins('a', '<Down>').actions).toEqual(['history-next']);
  });

  it('Esc enters NORMAL only with vim enabled', () => {
    expect(ins('abc', '<Esc>').mode).toBe('NORMAL');
    expect(ins('abc', '<Esc>').cursor).toBe(2);
    expect(ins('abc', '<Esc>', false).mode).toBe('INSERT');
    expect(ins('abc', '<Esc>x', false).text).toBe('abcx');
  });

  it('reads Meta+key as Esc then key when vim is on', () => {
    const s = createVimState('select id');
    const r = vimKey(s, { input: '0', meta: true }, true);
    expect(r.state.mode).toBe('NORMAL');
    expect(r.state.cursor).toBe(0);
    expect(vimKey(s, { input: 'b', meta: true }, false).state.cursor).toBe(7);
    const visual = { ...createVimState('abc', 'NORMAL'), cursor: 0, mode: 'VISUAL' as const };
    expect(vimKey(visual, { input: 'x', meta: true }, true).state.text).toBe('bc');
  });

  it('splits a multi-key chunk into separate commands outside INSERT', () => {
    const s = { ...createVimState('select id', 'NORMAL'), cursor: 0 };
    const r = vimKey(s, { input: 'cwSELECT' }, true);
    expect(r.state.text).toBe('SELECT id');
    expect(r.state.mode).toBe('INSERT');
  });

  it('normalises pasted line endings', () => {
    expect(vimKey(createVimState(''), { input: 'a\r\nb' }, true).state.text).toBe('a\nb');
  });

  it('opens the external editor on Ctrl+G', () => {
    expect(ins('', '<C-g>').actions).toEqual(['open-editor']);
  });
});

describe('INSERT-mode remaps (jj → Esc)', () => {
  const remaps = { jj: '<Esc>' };
  const type = (start: string, chars: Array<[string, number]>) => {
    let state = createVimState(start);
    for (const [input, now] of chars) state = vimKey(state, { input }, true, { remaps, now }).state;
    return state;
  };

  it('switches to NORMAL and leaves neither character', () => {
    const s = type('select', [['j', 0], ['j', 200]]);
    expect(s.text).toBe('select');
    expect(s.mode).toBe('NORMAL');
    expect(s.cursor).toBe(5);
  });

  it('keeps both characters after the one-second window', () => {
    const s = type('', [['j', 0], ['j', 1500]]);
    expect(s.text).toBe('jj');
    expect(s.mode).toBe('INSERT');
  });

  it('keeps both characters when a different key comes between', () => {
    const s = type('', [['j', 0], ['x', 100], ['j', 200]]);
    expect(s.text).toBe('jxj');
    expect(s.mode).toBe('INSERT');
  });

  it('leaves no undo step and no dot-repeat residue', () => {
    let s = type('abc', [['j', 0], ['j', 100]]);
    expect(s.undo).toHaveLength(0);
    s = type('abc', [['X', 0], ['j', 10], ['j', 20]]);
    expect(s.text).toBe('abcX');
    expect(s.lastChange).toBeNull();
  });

  it('is ignored when vim is off', () => {
    let state = createVimState('');
    for (const input of ['j', 'j']) state = vimKey(state, { input }, false, { remaps, now: 0 }).state;
    expect(state.text).toBe('jj');
  });
});
