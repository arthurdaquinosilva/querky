import { describe, expect, it } from 'vitest';
import { matchRanges, searchHistory } from './historySearch.js';
import { parseSettings } from '../config/settings.js';

describe('searchHistory', () => {
  const history = ['select * from book', 'select 1', '/erd', 'SELECT * FROM book', 'select 1'];

  it('returns case-insensitive matches newest first with duplicates collapsed', () => {
    expect(searchHistory(history, 'select')).toEqual(['select 1', 'SELECT * FROM book', 'select * from book']);
    expect(searchHistory(history, 'erd')).toEqual(['/erd']);
  });

  it('matches nothing for an empty query', () => {
    expect(searchHistory(history, '')).toEqual([]);
  });
});

describe('matchRanges', () => {
  it('finds every occurrence regardless of case', () => {
    expect(matchRanges('Book book BOOK', 'book')).toEqual([[0, 4], [5, 9], [10, 14]]);
    expect(matchRanges('abc', '')).toEqual([]);
  });
});

describe('parseSettings', () => {
  it('keeps only two-character sequences mapped to <Esc>', () => {
    const s = parseSettings({ vimInsertModeRemaps: { jj: '<Esc>', jk: '<Esc>', j: '<Esc>', jjj: '<Esc>', kj: 'x', '\u0001a': '<Esc>' } });
    expect(s.vimInsertModeRemaps).toEqual({ jj: '<Esc>', jk: '<Esc>' });
  });

  it('tolerates a missing or malformed file', () => {
    expect(parseSettings(null).vimInsertModeRemaps).toEqual({});
    expect(parseSettings({ vimInsertModeRemaps: 'jj' }).vimInsertModeRemaps).toEqual({});
  });
});
