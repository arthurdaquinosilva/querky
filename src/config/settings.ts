import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SETTINGS_FILE = join(homedir(), '.config', 'querky', 'settings.json');

export interface Settings {
  /** Two-key INSERT-mode sequences mapped to Escape, e.g. { "jj": "<Esc>" }. */
  vimInsertModeRemaps: Record<string, '<Esc>'>;
}

const isPrintable = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/** Keeps only entries Claude Code would honour: exactly two printable characters → "<Esc>". */
export function parseSettings(raw: unknown): Settings {
  const remaps: Record<string, '<Esc>'> = {};
  const source = (raw as { vimInsertModeRemaps?: unknown } | null)?.vimInsertModeRemaps;
  if (source && typeof source === 'object') {
    for (const [keys, target] of Object.entries(source)) {
      if ([...keys].length === 2 && isPrintable(keys) && target === '<Esc>') remaps[keys] = '<Esc>';
    }
  }
  return { vimInsertModeRemaps: remaps };
}

export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return parseSettings(null);
  }
}
