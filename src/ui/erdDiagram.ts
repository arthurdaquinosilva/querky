// Crow's-foot ERD rendered onto a character grid.
//
// Layout is layered: referenced (parent) tables sit above the tables that point
// at them, like a classic ER diagram. Edges always attach to the top/bottom
// border of a box so every cardinality marker is drawn vertically:
//
//        │                        │
//        ○   zero                 ┼   one (optional → ○)
//       ╱│╲  many                 ┼   one
//   ╭───┴───╮               ╭─────┴─────╮
//
// Edges are routed with A* over the grid (bend/crossing penalties), and a
// crossing is drawn as an unbroken vertical line through a gap in the
// horizontal one so it never reads as a junction.

import type { ErdData, ErdRelation, ErdTable } from '../db/erd.js';

export interface ErdStyle {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

export interface ErdSpan extends ErdStyle {
  text: string;
}

export interface ErdDiagram {
  lines: ErdSpan[][];
  unrouted: ErdRelation[];
}

export interface ErdPalette {
  tables: readonly string[];
  border: string;
  pk: string;
  muted: string;
}

const MARGIN = 2;
const HGAP = 5;
const MAX_NAME_W = 22;
const MAX_TYPE_W = 12;
const MAX_ROWS = 10;
const STUB = 2;
const BEND_COST = 6;
const CROSS_COST = 12;
const NEAR_BOX_COST = 3;
const NEAR_LINE_COST = 1;

type Dir = 0 | 1 | 2 | 3; // up, right, down, left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const opposite = (d: Dir) => ((d + 2) % 4) as Dir;
const isVertical = (d: Dir) => d === 0 || d === 2;

type Kind = 'empty' | 'box' | 'mark' | 'port' | 'line' | 'cross' | 'label';

interface Cell {
  ch: string;
  style: ErdStyle;
  kind: Kind;
  axis?: 'h' | 'v' | 'corner';
  edge?: number;
}

interface BoxRow {
  name: string;
  type: string;
  key: '' | 'PK' | 'FK';
  fkTable?: string;
  more?: boolean;
}

interface Box {
  table: ErdTable;
  color: string;
  rows: BoxRow[];
  nameW: number;
  typeW: number;
  hasKeys: boolean;
  w: number;
  h: number;
  x: number;
  y: number;
  row: number;
}

type Side = 'top' | 'bottom';

interface End {
  box: Box;
  side: Side;
  x: number;
  foot: boolean;
}

interface Edge {
  rel: ErdRelation;
  color: string;
  child: End;
  parent: End;
  path: Array<[number, number]> | null;
}

const trunc = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s);

function boxRows(table: ErdTable): BoxRow[] {
  const toRow = (c: ErdTable['columns'][number]): BoxRow => ({
    name: c.name,
    type: c.type,
    key: c.isPk ? 'PK' : c.fkTable ? 'FK' : '',
    fkTable: c.fkTable,
  });
  if (table.columns.length <= MAX_ROWS) return table.columns.map(toRow);

  const budget = MAX_ROWS - 1;
  const keyed = table.columns.filter((c) => c.isPk || c.fkTable).slice(0, budget);
  const rest = table.columns.filter((c) => !c.isPk && !c.fkTable).slice(0, budget - keyed.length);
  const chosen = new Set([...keyed, ...rest]);
  const rows = table.columns.filter((c) => chosen.has(c)).map(toRow);
  rows.push({ name: `… ${table.columns.length - rows.length} more`, type: '', key: '', more: true });
  return rows;
}

function makeBox(table: ErdTable, color: string, maxW: number): Box {
  const rows = boxRows(table);
  const plain = rows.filter((r) => !r.more);
  const hasKeys = plain.some((r) => r.key);
  let nameW = Math.min(MAX_NAME_W, Math.max(2, ...plain.map((r) => r.name.length)));
  let typeW = Math.min(MAX_TYPE_W, Math.max(0, ...plain.map((r) => r.type.length)));
  const keyW = hasKeys ? 4 : 0;

  // Shrink columns until the box fits the available width.
  while (nameW + typeW + keyW + 6 > maxW && (typeW > 4 || nameW > 4)) {
    if (typeW > 4) typeW--;
    else nameW--;
  }

  const contentW = nameW + typeW + keyW + 6;
  const titleW = table.name.length + 4;
  const w = Math.min(maxW, Math.max(contentW, titleW, 12));
  return { table, color, rows, nameW, typeW, hasKeys, w, h: rows.length + 4, x: 0, y: 0, row: 0 };
}

function rankTables(tables: ErdTable[], relations: ErdRelation[]): Map<string, number> {
  const parents = new Map<string, string[]>(tables.map((t) => [t.name, []]));
  for (const r of relations) {
    if (r.table !== r.refTable) parents.get(r.table)?.push(r.refTable);
  }

  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (name: string): number => {
    const known = rank.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return -1; // cycle: ignore this back edge
    visiting.add(name);
    let r = 0;
    for (const p of parents.get(name) ?? []) {
      const pr = visit(p);
      if (pr >= 0) r = Math.max(r, pr + 1);
    }
    visiting.delete(name);
    rank.set(name, r);
    return r;
  };
  tables.forEach((t) => visit(t.name));
  return rank;
}

function orderLayers(layers: string[][], relations: ErdRelation[], rank: Map<string, number>) {
  const neighbors = new Map<string, string[]>();
  for (const r of relations) {
    if (r.table === r.refTable) continue;
    neighbors.set(r.table, [...(neighbors.get(r.table) ?? []), r.refTable]);
    neighbors.set(r.refTable, [...(neighbors.get(r.refTable) ?? []), r.table]);
  }

  const pos = new Map<string, number>();
  const refresh = (layer: string[]) => layer.forEach((n, i) => pos.set(n, (i + 0.5) / layer.length));
  layers.forEach(refresh);

  const sortLayer = (layer: string[], useRank: (r: number) => boolean) => {
    const key = new Map<string, number>();
    for (const n of layer) {
      const ns = (neighbors.get(n) ?? []).filter((m) => useRank(rank.get(m) ?? 0));
      key.set(n, ns.length ? ns.reduce((s, m) => s + (pos.get(m) ?? 0), 0) / ns.length : (pos.get(n) ?? 0));
    }
    layer.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0));
    refresh(layer);
  };

  for (let iter = 0; iter < 8; iter++) {
    if (iter % 2 === 0) {
      for (let r = 1; r < layers.length; r++) sortLayer(layers[r], (nr) => nr < r);
    } else {
      for (let r = layers.length - 2; r >= 0; r--) sortLayer(layers[r], (nr) => nr > r);
    }
  }
}

function wrapRow(boxes: Box[], maxW: number): Box[][] {
  const rows: Box[][] = [];
  let cur: Box[] = [];
  let curW = 0;
  for (const b of boxes) {
    const add = (cur.length ? HGAP : 0) + b.w;
    if (cur.length && curW + add > maxW) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    curW += (cur.length ? HGAP : 0) + b.w;
    cur.push(b);
  }
  if (cur.length) rows.push(cur);
  return rows;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.vals.length;
  }
  push(key: number, val: number) {
    const { keys, vals } = this;
    let i = vals.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): number {
    const { keys, vals } = this;
    const top = vals[0];
    const lastK = keys.pop()!;
    const lastV = vals.pop()!;
    if (vals.length) {
      let i = 0;
      const n = vals.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[c] >= lastK) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastK;
      vals[i] = lastV;
    }
    return top;
  }
}

class Grid {
  cells: Cell[][];
  constructor(
    public w: number,
    public h: number,
  ) {
    this.cells = Array.from({ length: h }, () =>
      Array.from({ length: w }, (): Cell => ({ ch: ' ', style: {}, kind: 'empty' })),
    );
  }
  in(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  at(x: number, y: number): Cell {
    return this.cells[y][x];
  }
  set(x: number, y: number, ch: string, style: ErdStyle, kind: Kind, extra: Partial<Cell> = {}) {
    if (!this.in(x, y)) return;
    this.cells[y][x] = { ch, style, kind, ...extra };
  }
  text(x: number, y: number, s: string, style: ErdStyle, kind: Kind) {
    [...s].forEach((ch, i) => this.set(x + i, y, ch, style, kind));
  }
}

const outward = (side: Side): Dir => (side === 'top' ? 0 : 2);
const borderY = (end: End) => (end.side === 'top' ? end.box.y : end.box.y + end.box.h - 1);
const portOf = (end: End): [number, number] => [end.x, borderY(end) + (end.side === 'top' ? -1 : 1) * (STUB + 1)];

function drawBox(g: Grid, b: Box, palette: ErdPalette, colorOf: (t: string) => string) {
  const border: ErdStyle = { color: palette.border };
  const { x, y, w } = b;
  g.set(x, y, '╭', border, 'box');
  for (let i = x + 1; i < x + w - 1; i++) g.set(i, y, '─', border, 'box');
  g.set(x + w - 1, y, '╮', border, 'box');
  g.set(x, y + 1, '│', border, 'box');
  for (let i = x + 1; i < x + w - 1; i++) g.set(i, y + 1, ' ', {}, 'box');
  g.text(x + 2, y + 1, trunc(b.table.name, w - 4), { color: b.color, bold: true }, 'box');
  g.set(x + w - 1, y + 1, '│', border, 'box');
  g.set(x, y + 2, '├', border, 'box');
  for (let i = x + 1; i < x + w - 1; i++) g.set(i, y + 2, '─', border, 'box');
  g.set(x + w - 1, y + 2, '┤', border, 'box');

  const typeW = w - 6 - b.nameW - (b.hasKeys ? 4 : 0);
  b.rows.forEach((r, i) => {
    const ry = y + 3 + i;
    g.set(x, ry, '│', border, 'box');
    for (let cx = x + 1; cx < x + w - 1; cx++) g.set(cx, ry, ' ', {}, 'box');
    if (r.more) {
      g.text(x + 2, ry, trunc(r.name, w - 4), { color: palette.muted, dim: true }, 'box');
    } else {
      g.text(x + 2, ry, trunc(r.name, b.nameW), r.key === 'PK' ? { bold: true } : {}, 'box');
      g.text(x + 4 + b.nameW, ry, trunc(r.type, typeW), { color: palette.muted }, 'box');
      if (r.key === 'PK') g.text(x + w - 4, ry, 'PK', { color: palette.pk, bold: true }, 'box');
      if (r.key === 'FK') g.text(x + w - 4, ry, 'FK', { color: r.fkTable ? colorOf(r.fkTable) : palette.muted }, 'box');
    }
    g.set(x + w - 1, ry, '│', border, 'box');
  });

  const by = y + b.h - 1;
  g.set(x, by, '╰', border, 'box');
  for (let i = x + 1; i < x + w - 1; i++) g.set(i, by, '─', border, 'box');
  g.set(x + w - 1, by, '╯', border, 'box');
}

function drawStub(g: Grid, end: End, max: 'one' | 'many', min: 'zero' | 'one', color: string, edgeIdx: number) {
  const style: ErdStyle = { color };
  const dy = end.side === 'top' ? -1 : 1;
  const by = borderY(end);
  g.set(end.x, by, end.side === 'top' ? '┴' : '┬', style, 'box');
  if (max === 'many') {
    // Prongs open toward the box: ╱│╲ above a top border, ╲│╱ below a bottom one.
    const [l, r] = end.side === 'top' ? ['╱', '╲'] : ['╲', '╱'];
    g.set(end.x - 1, by + dy, l, style, 'mark');
    g.set(end.x, by + dy, '│', style, 'mark');
    g.set(end.x + 1, by + dy, r, style, 'mark');
  } else {
    g.set(end.x, by + dy, '┼', style, 'mark');
  }
  g.set(end.x, by + 2 * dy, min === 'zero' ? '○' : '┼', style, 'mark');
  const [px, py] = portOf(end);
  g.set(px, py, ' ', style, 'port', { edge: edgeIdx });
}

function clearStub(g: Grid, end: End, palette: ErdPalette) {
  const dy = end.side === 'top' ? -1 : 1;
  const by = borderY(end);
  g.set(end.x, by, '─', { color: palette.border }, 'box');
  for (const [x, y] of [
    [end.x - 1, by + dy],
    [end.x, by + dy],
    [end.x + 1, by + dy],
    [end.x, by + 2 * dy],
    portOf(end),
  ] as Array<[number, number]>) {
    if (g.in(x, y) && g.at(x, y).kind !== 'box') g.set(x, y, ' ', {}, 'empty');
  }
}

function route(g: Grid, edge: Edge): Array<[number, number]> | null {
  const [sx, sy] = portOf(edge.child);
  const [tx, ty] = portOf(edge.parent);
  if (!g.in(sx, sy) || !g.in(tx, ty)) return null;
  const startDir = outward(edge.child.side);
  const inward = opposite(outward(edge.parent.side));
  const W = g.w;
  const N = W * g.h * 4;
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const sid = (sy * W + sx) * 4 + startDir;
  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  cost[sid] = 0;
  heap.push(h(sx, sy), sid);

  const nearCost = (x: number, y: number) => {
    let c = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!g.in(nx, ny)) continue;
      const k = g.at(nx, ny).kind;
      if (k === 'box' || k === 'mark') c = Math.max(c, NEAR_BOX_COST);
      else if ((k === 'line' || k === 'cross') && c === 0) c = NEAR_LINE_COST;
    }
    return c;
  };

  let found = -1;
  while (heap.size) {
    const s = heap.pop();
    const d = (s & 3) as Dir;
    const ci = s >> 2;
    const x = ci % W;
    const y = (ci - x) / W;
    if (x === tx && y === ty) {
      found = s;
      break;
    }
    const here = g.at(x, y);
    const crossing = here.kind === 'line';
    for (let nd = 0 as Dir; nd < 4; nd = (nd + 1) as Dir) {
      if (nd === opposite(d)) continue;
      if (crossing && nd !== d) continue;
      const nx = x + DX[nd];
      const ny = y + DY[nd];
      if (!g.in(nx, ny)) continue;
      const cell = g.at(nx, ny);
      let step = 1;
      if (nx === tx && ny === ty) {
        if (nd !== inward) step += BEND_COST;
      } else if (cell.kind === 'line') {
        const perpendicular = cell.axis === (isVertical(nd) ? 'h' : 'v');
        if (!perpendicular) continue;
        step += CROSS_COST;
      } else if (cell.kind !== 'empty') {
        continue;
      } else {
        step += nearCost(nx, ny);
      }
      if (nd !== d) step += BEND_COST;
      const ns = (ny * W + nx) * 4 + nd;
      const nc = cost[s] + step;
      if (nc < cost[ns]) {
        cost[ns] = nc;
        prev[ns] = s;
        heap.push(nc + h(nx, ny), ns);
      }
    }
  }
  if (found < 0) return null;

  const path: Array<[number, number]> = [];
  for (let s = found; s >= 0; s = prev[s]) {
    const ci = s >> 2;
    path.push([ci % W, Math.floor(ci / W)]);
  }
  path.reverse();
  return path;
}

const CORNER: Record<string, string> = {
  '0,2': '│',
  '1,3': '─',
  '1,2': '╭',
  '2,3': '╮',
  '0,1': '╰',
  '0,3': '╯',
};

function dirBetween(a: [number, number], b: [number, number]): Dir {
  if (b[1] < a[1]) return 0;
  if (b[0] > a[0]) return 1;
  if (b[1] > a[1]) return 2;
  return 3;
}

function drawPath(g: Grid, edge: Edge, idx: number) {
  const path = edge.path!;
  const style: ErdStyle = { color: edge.color };
  const startStub = opposite(outward(edge.child.side));
  const endStub = opposite(outward(edge.parent.side));
  path.forEach((p, i) => {
    const a = i === 0 ? startStub : dirBetween(p, path[i - 1]);
    const b = i === path.length - 1 ? endStub : dirBetween(p, path[i + 1]);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const ch = CORNER[`${lo},${hi}`] ?? '┼';
    const axis = ch === '│' ? 'v' : ch === '─' ? 'h' : 'corner';
    const cell = g.at(p[0], p[1]);
    if (cell.kind === 'line') {
      // Crossing: the vertical line stays unbroken and the horizontal one gaps around it.
      const vertical = cell.axis === 'v' ? cell : { ch, style };
      g.set(p[0], p[1], vertical.ch, vertical.style, 'cross');
      return;
    }
    g.set(p[0], p[1], ch, style, 'line', { axis, edge: idx });
  });
}

function placeLabel(g: Grid, edge: Edge, idx: number, muted: string): boolean {
  const label = trunc(edge.rel.columns.join(', '), 24);
  const path = edge.path!;
  const len = label.length;
  const style: ErdStyle = { color: muted, italic: true };
  const own = (x: number, y: number, axis: 'h' | 'v') => {
    const c = g.at(x, y);
    return c.kind === 'line' && c.edge === idx && c.axis === axis;
  };
  const free = (x0: number, x1: number, y: number, except = -1) => {
    for (let x = x0; x <= x1; x++) {
      if (x === except) continue;
      if (!g.in(x, y) || g.at(x, y).kind !== 'empty') return false;
    }
    return true;
  };

  // Middle-out over the path so labels land near the centre of the edge.
  const order = path
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Math.abs(a.i - path.length / 2) - Math.abs(b.i - path.length / 2));

  for (const { p } of order) {
    const [x, y] = p;
    if (!own(x, y, 'v') || !own(x, y - 1, 'v') || !own(x, y + 1, 'v')) continue;
    const x0 = x - Math.floor(len / 2);
    if (free(x0 - 1, x0 + len, y, x)) {
      g.text(x0, y, label, style, 'label');
      return true;
    }
  }
  for (const { p } of order) {
    const [x, y] = p;
    const x0 = x - Math.floor(len / 2) - 1;
    let ok = true;
    for (let cx = x0 - 1; cx <= x0 + len + 2 && ok; cx++) ok = g.in(cx, y) && own(cx, y, 'h');
    if (ok) {
      g.text(x0, y, ` ${label} `, style, 'label');
      return true;
    }
  }
  for (const { p } of order) {
    const [x, y] = p;
    if (!own(x, y, 'v')) continue;
    if (free(x + 1, x + len + 2, y)) {
      g.text(x + 2, y, label, style, 'label');
      return true;
    }
    if (free(x - len - 2, x - 1, y)) {
      g.text(x - len - 1, y, label, style, 'label');
      return true;
    }
  }
  return false;
}

function assignPorts(ends: End[]) {
  const bySide = new Map<string, End[]>();
  for (const e of ends) {
    const k = `${e.box.table.name}\0${e.side}`;
    bySide.set(k, [...(bySide.get(k) ?? []), e]);
  }
  for (const group of bySide.values()) {
    const b = group[0].box;
    const n = group.length;
    const minS = group.some((e) => e.foot) ? 4 : 2;
    const s = Math.max(minS, Math.min(8, Math.floor((b.w - 4) / n)));
    const span = (n - 1) * s;
    const start = b.x + Math.floor((b.w - 1 - span) / 2);
    group.sort((a, c) => a.x - c.x);
    group.forEach((e, i) => (e.x = start + i * s));
  }
  return bySide;
}

export function buildErdDiagram(data: ErdData, maxWidth: number, palette: ErdPalette): ErdDiagram {
  // Dense schemas can wall off an edge; spare terminal width becomes extra routing corridors.
  let best: ErdDiagram | null = null;
  for (let extra = 0; ; extra += 3) {
    const attempt = layoutDiagram(data, maxWidth, palette, MARGIN + extra);
    if (!best || attempt.diagram.unrouted.length < best.unrouted.length) best = attempt.diagram;
    if (best.unrouted.length === 0 || attempt.gridW >= maxWidth) return best;
  }
}

function layoutDiagram(
  data: ErdData,
  maxWidth: number,
  palette: ErdPalette,
  margin: number,
): { diagram: ErdDiagram; gridW: number } {
  const tables = [...data.tables].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(tables.map((t) => t.name));
  const relations = data.relations.filter((r) => names.has(r.table) && names.has(r.refTable));
  const colorOf = (t: string) => palette.tables[tables.findIndex((x) => x.name === t) % palette.tables.length] ?? palette.border;

  const usableW = Math.max(20, maxWidth - 2 * margin);
  const boxes = new Map(tables.map((t) => [t.name, makeBox(t, colorOf(t.name), usableW)]));

  // Widen boxes so every attached edge gets its own port (feet need 4 cells each).
  const rank = rankTables(tables, relations);
  const portNeed = new Map<string, Record<Side, number> & { feet: Record<Side, number> }>();
  const need = (t: string) => {
    let n = portNeed.get(t);
    if (!n) portNeed.set(t, (n = { top: 0, bottom: 0, feet: { top: 0, bottom: 0 } }));
    return n;
  };
  for (const r of relations) {
    const pr = rank.get(r.refTable) ?? 0;
    const cr = rank.get(r.table) ?? 0;
    const childSide: Side = pr < cr ? 'top' : 'bottom';
    const parentSide: Side = pr > cr ? 'top' : 'bottom';
    need(r.table)[childSide]++;
    if (!r.unique) need(r.table).feet[childSide]++;
    need(r.refTable)[parentSide]++;
  }
  for (const [t, n] of portNeed) {
    const b = boxes.get(t)!;
    const sideW = (s: Side) => (n.feet[s] ? 4 * n[s] + 1 : 2 * n[s] + 3);
    b.w = Math.min(usableW, Math.max(b.w, sideW('top'), sideW('bottom')));
  }

  const connected = new Set(relations.flatMap((r) => [r.table, r.refTable]));
  const layers: string[][] = [];
  for (const t of tables) {
    if (!connected.has(t.name)) continue;
    const r = rank.get(t.name) ?? 0;
    (layers[r] ??= []).push(t.name);
  }
  const denseLayers = layers.filter((l) => l?.length);
  const layerOf = new Map(denseLayers.flatMap((l, i) => l.map((n) => [n, i] as const)));
  orderLayers(denseLayers, relations, layerOf);

  // When a layer wraps, tables with more edges going down sit in its last sub-row
  // (closest to their children); barycenter order is kept inside each sub-row.
  const flow = (n: string) => {
    let f = 0;
    for (const r of relations) {
      if (r.table === r.refTable) continue;
      const other = r.table === n ? r.refTable : r.refTable === n ? r.table : null;
      if (other !== null) f += Math.sign((layerOf.get(other) ?? 0) - (layerOf.get(n) ?? 0));
    }
    return f;
  };
  const rows: Box[][] = [];
  for (const layer of denseLayers) {
    const ordered = layer.map((n) => boxes.get(n)!);
    const wrapped = wrapRow(ordered, usableW);
    if (wrapped.length === 1) {
      rows.push(...wrapped);
      continue;
    }
    const byFlow = [...ordered].sort((a, b) => flow(b.table.name) - flow(a.table.name));
    const parts = wrapRow(byFlow, usableW).reverse();
    for (const part of parts) part.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
    rows.push(...parts);
  }
  const firstIsolated = rows.length;
  rows.push(...wrapRow(tables.filter((t) => !connected.has(t.name)).map((t) => boxes.get(t.name)!), usableW));
  rows.forEach((row, ri) => row.forEach((b) => (b.row = ri)));

  // Edge endpoints: parent above → child top / parent bottom; otherwise both hang below.
  const ends: End[] = [];
  const edges: Edge[] = relations.map((rel) => {
    const cb = boxes.get(rel.table)!;
    const pb = boxes.get(rel.refTable)!;
    const parentAbove = pb.row < cb.row;
    const parentBelow = pb.row > cb.row;
    const child: End = { box: cb, side: parentAbove ? 'top' : 'bottom', x: 0, foot: !rel.unique };
    const parent: End = { box: pb, side: parentBelow ? 'top' : 'bottom', x: 0, foot: false };
    ends.push(child, parent);
    return { rel, color: pb.color, child, parent, path: null };
  });

  // Tracks needed in the channel below each row.
  const channel = rows.map(() => 0);
  for (const e of edges) {
    const a = Math.min(e.child.box.row, e.parent.box.row);
    const b = Math.max(e.child.box.row, e.parent.box.row);
    if (a === b) channel[a]++;
    for (let r = a; r < b; r++) channel[r]++;
  }

  const contentW = Math.max(...rows.map((row) => row.reduce((s, b) => s + b.w, 0) + HGAP * (row.length - 1)));
  const gridW = Math.min(maxWidth, contentW + 2 * margin);
  let y = 0;
  rows.forEach((row, ri) => {
    const rowW = row.reduce((s, b) => s + b.w, 0) + HGAP * (row.length - 1);
    let x = margin + Math.floor((contentW - rowW) / 2);
    for (const b of row) {
      b.x = x;
      b.y = y;
      x += b.w + HGAP;
    }
    const rowH = Math.max(...row.map((b) => b.h));
    const gap = channel[ri] > 0 ? 2 * STUB + 1 + Math.min(9, Math.max(3, channel[ri] + 2)) : 1;
    y += rowH + (ri === firstIsolated - 1 && ri < rows.length - 1 ? Math.max(gap, 2) : gap);
  });

  // Initial port order follows the opposite end so edges fan out without crossing.
  const center = (b: Box) => b.x + b.w / 2;
  for (const e of edges) {
    e.child.x = center(e.parent.box) + (e.parent.box === e.child.box ? -1 : 0);
    e.parent.x = center(e.child.box) + (e.parent.box === e.child.box ? 1 : 0);
  }
  const groups = assignPorts(ends);

  // A lone port on each end with overlapping spans → line them up for a straight edge.
  const groupSize = (e: End) => groups.get(`${e.box.table.name}\0${e.side}`)?.length ?? 0;
  for (const e of edges) {
    if (e.child.box === e.parent.box || groupSize(e.child) !== 1 || groupSize(e.parent) !== 1) continue;
    const lo = Math.max(e.child.box.x + 2, e.parent.box.x + 2);
    const hi = Math.min(e.child.box.x + e.child.box.w - 3, e.parent.box.x + e.parent.box.w - 3);
    if (lo > hi) continue;
    const mid = Math.round((e.child.x + e.parent.x) / 2);
    e.child.x = e.parent.x = Math.min(hi, Math.max(lo, mid));
  }

  const grid = new Grid(gridW, y + 2);
  for (const b of boxes.values()) drawBox(grid, b, palette, colorOf);
  edges.forEach((e, i) => {
    drawStub(grid, e.child, e.rel.unique ? 'one' : 'many', 'zero', e.color, i);
    drawStub(grid, e.parent, 'one', e.rel.optional ? 'zero' : 'one', e.color, i);
  });

  const order = edges
    .map((e, i) => ({ e, i, d: Math.abs(e.child.x - e.parent.x) + Math.abs(e.child.box.y - e.parent.box.y) }))
    .sort((a, b) => a.d - b.d);
  const unrouted: ErdRelation[] = [];
  for (const { e, i } of order) {
    e.path = route(grid, e);
    if (e.path) drawPath(grid, e, i);
    else {
      unrouted.push(e.rel);
      clearStub(grid, e.child, palette);
      clearStub(grid, e.parent, palette);
    }
  }
  for (const { e, i } of order) if (e.path) placeLabel(grid, e, i, palette.muted);

  return { diagram: { lines: toSpans(grid), unrouted }, gridW };
}

function sameStyle(a: ErdStyle, b: ErdStyle) {
  return a.color === b.color && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic;
}

function toSpans(g: Grid): ErdSpan[][] {
  const indent = Math.min(
    ...g.cells.map((row) => {
      const i = row.findIndex((c) => c.ch !== ' ');
      return i < 0 ? Infinity : i;
    }),
  );
  const lines = g.cells.map((cells) => {
    const row = cells.slice(Number.isFinite(indent) ? indent : 0);
    let end = row.length;
    while (end > 0 && row[end - 1].ch === ' ') end--;
    const spans: ErdSpan[] = [];
    for (const cell of row.slice(0, end)) {
      const style = cell.ch === ' ' ? {} : cell.style;
      const last = spans[spans.length - 1];
      if (last && sameStyle(last, style)) last.text += cell.ch;
      else spans.push({ ...style, text: cell.ch });
    }
    return spans;
  });
  while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
  return lines.filter((l, i) => l.length > 0 || (i > 0 && lines[i - 1].length > 0));
}

export function erdPlainText(diagram: ErdDiagram): string {
  return diagram.lines.map((l) => l.map((s) => s.text).join('')).join('\n');
}
