/** Case-insensitive substring matches over history, newest first, duplicates collapsed. */
export function searchHistory(history: string[], query: string): string[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (entry.toLowerCase().includes(q)) out.push(entry);
  }
  return out;
}

/** [start, end) ranges of every case-insensitive occurrence of `query` in `text`. */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  if (!query) return [];
  const ranges: Array<[number, number]> = [];
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) ranges.push([i, i + q.length]);
  return ranges;
}
