// pitch: cool blue/violet hues on a pitch-black terminal, the palette shared with
// ember, shtick, cinder, flare and lore; each tool gets its own accent (querky's is teal).
export const theme = {
  accent: '#73daca',
  fg: '#c0caf5',
  insertMode: '#bb9af7',
  normalMode: '#e0af68',
  shellMode: '#9ece6a',
  logo: '#73daca',
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',
  muted: '#737aa2',
  subtle: '#565f89',
  border: '#3b4261',
  rule: '#2a2e42',
  selection: '#161925',
  sql: {
    keyword: '#bb9af7',
    string: '#9ece6a',
    number: '#ff9e64',
    comment: '#565f89',
  },
  tables: ['#73daca', '#7aa2f7', '#bb9af7', '#9ece6a', '#ff9e64', '#e0af68', '#7dcfff', '#f7768e'],
} as const;
