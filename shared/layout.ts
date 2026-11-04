import { componentName } from "./specimens";
import type { CanvasNode } from "./types";

export type Rect = { x: number; y: number; w: number; h: number };

/** Space between a section's edge and its contents. */
export const SECTION_PAD = 128;
/** Space between neighbours in a row. */
export const AUTO_GAP = 80;
/** Space between rows. Each node's label sits in the gap above it, so rows sit further apart than columns. */
export const AUTO_ROW_GAP = 120;
/** Space between neighbours, rows and tiled sections at the top of a page. */
export const SECTION_GAP = 160;
/** Four desktop screens fit in a row. Flows of smaller screens keep reading left to right until the width runs out. */
export const AUTO_ROW_WIDTH = 6400;
/** Other automatic sections (images, token sheets, mixed previews) stop at four per row. */
export const AUTO_COLUMNS = 4;
/** Sibling sections without screens tile in about √n columns, so a group grows roughly as wide as it is tall. */
export const sectionColumns = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));
/** About four component catalogs side by side. Runs of sections without screens stay within this width. */
export const TILE_WIDTH = 8000;
/** Tiled sections may run a quarter past their widest member, so a narrow sheet can sit beside a full-width group. */
export const tileWidth = (widths: number[]) => Math.max(TILE_WIDTH, ...widths.map((w) => w * 1.25));
/** Width over height that a run of sibling flows aims for: a landscape block, like the screen viewing it. */
export const FLOW_TILE_ASPECT = 1.6;

/**
 * Offsets for a run of sibling sections. They fill about √n columns in order, top to bottom, each column a fixed
 * share of the run, so tall and short groups interleave instead of leaving gaps under a shared row height.
 * Columns come from order, count and widths only: measured heights move sections down within their column but
 * never into another one. Fewer columns are used when they would exceed the tile width.
 */
export function tileSections(sizes: readonly { w: number; h: number }[], gap: number, rowGap = gap) {
  const n = sizes.length, budget = tileWidth(sizes.map((s) => s.w));
  for (let columns = Math.min(n, sectionColumns(n)); ; columns--) {
    const starts: number[] = [];
    // Earlier columns take the remainder, so ten sections in four columns stack 3, 3, 2, 2.
    for (let c = 0, start = 0; c < columns; c++) { starts.push(start); start += Math.floor(n / columns) + (c < n % columns ? 1 : 0); }
    const block = tileColumns(sizes, starts, gap, rowGap);
    if (block.w <= budget || columns === 1) return block;
  }
}

/**
 * Offsets for a run of sibling sections that holds screens. Flows keep their order, top to bottom and then left to
 * right, in columns whose heights balance. The run takes the column count that brings it closest to
 * FLOW_TILE_ASPECT, so a few wide flows stay one per row and many narrow ones sit side by side.
 * Pass `starts` to keep columns chosen earlier; `starts` in the result says where each column begins.
 */
export function tileFlows(sizes: readonly { w: number; h: number }[], gap: number, rowGap = gap, starts?: readonly number[]) {
  if (starts && starts[0] === 0 && starts.every((start, i) => start < sizes.length && (!i || start > starts[i - 1]!))) {
    return { ...tileColumns(sizes, starts, gap, rowGap), starts };
  }
  const heights = sizes.map((s) => s.h);
  const skew = (b: { w: number; h: number }) => Math.abs(Math.log(b.w / Math.max(1, b.h) / FLOW_TILE_ASPECT));
  let best = { ...tileColumns(sizes, [0], gap, rowGap), starts: [0] as readonly number[] };
  // More columns make a run wider and shorter, so the search stops once a run is wider than the target.
  for (let columns = 2; columns <= sizes.length && best.w / Math.max(1, best.h) < FLOW_TILE_ASPECT; columns++) {
    const split = balancedStarts(heights, columns, rowGap), next = { ...tileColumns(sizes, split, gap, rowGap), starts: split };
    if (skew(next) >= skew(best)) break;
    best = next;
  }
  return best;
}

/** Stacks each run of `sizes` that begins at one of `starts` into a column, columns left to right. */
function tileColumns(sizes: readonly { w: number; h: number }[], starts: readonly number[], gap: number, rowGap: number) {
  const offsets: { x: number; y: number }[] = [];
  let x = 0, h = 0;
  starts.forEach((start, c) => {
    const column = sizes.slice(start, starts[c + 1] ?? sizes.length);
    let y = 0;
    for (const s of column) { offsets.push({ x, y }); y += s.h + rowGap; }
    h = Math.max(h, y - rowGap);
    x += Math.max(...column.map((s) => s.w)) + gap;
  });
  return { offsets, w: x - gap, h };
}

/**
 * A component-only section is a catalog: specimens pack tightly, each component family
 * ("Chip" in "Chip/Active") starts its own row, and the family name sits once in a left gutter.
 */
export const CATALOG_PAD = 64;
export const CATALOG_GAP = 40;
export const CATALOG_ROW_GAP = 64;
export const CATALOG_ROW_WIDTH = 1600;
export const CATALOG_GUTTER = 160;
/** Catalogs taller than this multiple of their width split their family rows into columns; shorter ones keep one. */
export const CATALOG_TALL = 1.5;
/** Space between catalog columns. The next column's gutter holds its family names, so this only clears the specimens. */
export const CATALOG_COLUMN_GAP = AUTO_GAP;
const EMPTY_SECTION = { w: 480, h: 280 };

/** Height used for layout: fixed, else what a live iframe reported, else the renderer's measurement. */
export const layoutHeight = (f: CanvasNode, live?: Map<string, number>) =>
  f.height ?? live?.get(f.id) ?? f.measuredHeight ?? Math.round(f.width * 0.625);

/**
 * Canvas rectangles for a page's nodes. Every position comes from order and size: a section arranges its children
 * inside its padding, and the page arranges its top-level nodes from the origin the same way. Stored x/y are ignored.
 * Flows pick their columns from stored heights, so heights a live view reports move a flow down its column but never
 * into another one, and every viewer and agent sees the same columns.
 */
export function layoutRects(frames: CanvasNode[], heightOf: (f: CanvasNode) => number) {
  const flowColumns = new Map<string, readonly number[]>();
  const stored = arrangePage(frames, (f) => layoutHeight(f), flowColumns);
  if (frames.every((f) => f.kind === "section" || heightOf(f) === layoutHeight(f))) return stored;
  return arrangePage(frames, heightOf, flowColumns);
}

/** Rects for `frames`. Flow runs use the columns in `flowColumns`, keyed by their first section, or record new ones there. */
function arrangePage(frames: CanvasNode[], heightOf: (f: CanvasNode) => number, flowColumns: Map<string, readonly number[]>) {
  const kids = childrenOf(frames);
  const ids = new Set(frames.map((f) => f.id));
  const rects = new Map<string, Rect>();
  const ordered = inOrder(frames);
  const shift = (f: CanvasNode, dx: number, dy: number, seen = new Set<string>()) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    const r = rects.get(f.id);
    if (r) rects.set(f.id, { ...r, x: r.x + dx, y: r.y + dy });
    for (const k of kids.get(f.id) ?? []) shift(k, dx, dy, seen);
  };
  // A section with screens, at any depth, is a flow that reads left to right. Runs that hold flows tile toward a
  // landscape block; runs of other sections (catalogs, token sheets, groups of them) tile in about √n columns.
  const screens = new Map<string, boolean>();
  const hasScreens = (s: CanvasNode): boolean => {
    if (!screens.has(s.id)) {
      screens.set(s.id, false);
      screens.set(s.id, (kids.get(s.id) ?? []).some((k) => k.kind === "frame" || k.kind === "section" && hasScreens(k)));
    }
    return screens.get(s.id)!;
  };
  /**
   * Offsets for a group's contents in order. Nodes sit in rows: screens wrap only when the row width runs out,
   * other nodes after four. Consecutive sections tile as one block on rows of their own.
   */
  const arrange = (children: CanvasNode[], inner: Rect[], gap: number, rowGap: number) => {
    const flow = children.some((k) => k.kind === "frame");
    const offsets: { x: number; y: number }[] = [];
    let x = 0, y = 0, rowHeight = 0, columns = 0, width = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!, cr = inner[i]!;
      if (child.kind === "section") {
        let end = i + 1;
        while (end < children.length && children[end]!.kind === "section") end++;
        const run = children.slice(i, end), sizes = inner.slice(i, end);
        let block: { offsets: { x: number; y: number }[]; w: number; h: number };
        if (run.some(hasScreens)) {
          const tiled = tileFlows(sizes, gap, rowGap, flowColumns.get(child.id));
          flowColumns.set(child.id, tiled.starts);
          block = tiled;
        } else block = tileSections(sizes, gap, rowGap);
        if (columns) { y += rowHeight + rowGap; x = 0; }
        for (const o of block.offsets) offsets.push({ x: o.x, y: y + o.y });
        width = Math.max(width, block.w); rowHeight = block.h; columns = 1;
        i = end - 1;
        continue;
      }
      const wraps = children[i - 1]?.kind === "section" || !flow && columns >= AUTO_COLUMNS || x + cr.w > AUTO_ROW_WIDTH;
      if (columns && wraps) {
        y += rowHeight + rowGap; x = 0; rowHeight = 0; columns = 0;
      }
      offsets.push({ x, y });
      width = Math.max(width, x + cr.w);
      rowHeight = Math.max(rowHeight, cr.h);
      x += cr.w + gap; columns++;
    }
    return { offsets, w: width, h: y + rowHeight };
  };
  /** Moves each child so its rect starts at its offset from `origin`. */
  const place = (children: CanvasNode[], inner: Rect[], offsets: { x: number; y: number }[], origin: number) =>
    children.forEach((child, i) => shift(child, origin + offsets[i]!.x - inner[i]!.x, origin + offsets[i]!.y - inner[i]!.y));
  const rectOf = (f: CanvasNode, seen = new Set<string>()): Rect => {
    const cached = rects.get(f.id);
    if (cached) return cached;
    let r: Rect;
    if (f.kind !== "section") {
      r = { x: 0, y: 0, w: f.width, h: heightOf(f) };
    } else {
      seen.add(f.id);
      const children = ordered((kids.get(f.id) ?? []).filter((k) => !seen.has(k.id)));
      const inner = children.map((k) => rectOf(k, new Set(seen)));
      if (!inner.length) {
        r = { x: 0, y: 0, ...EMPTY_SECTION };
      } else if (isCatalog(children)) {
        const gutter = children.some((k) => familyOf(k.name)) ? CATALOG_GUTTER : 0;
        const block = catalogLayout(children.map((k) => k.name), inner, gutter);
        place(children, inner, block.offsets, CATALOG_PAD);
        r = { x: 0, y: 0, w: block.w + CATALOG_PAD * 2, h: block.h + CATALOG_PAD * 2 };
      } else {
        const block = arrange(children, inner, AUTO_GAP, AUTO_ROW_GAP);
        place(children, inner, block.offsets, SECTION_PAD);
        r = { x: 0, y: 0, w: block.w + SECTION_PAD * 2, h: block.h + SECTION_PAD * 2 };
      }
    }
    rects.set(f.id, r);
    return r;
  };
  for (const f of frames) rectOf(f);
  // Each page arranges its top-level nodes, and any whose section is missing, like a section without padding.
  const pages = new Map<string, CanvasNode[]>();
  for (const f of frames) if (!f.parentId || !ids.has(f.parentId)) (pages.get(f.pageId) ?? pages.set(f.pageId, []).get(f.pageId)!).push(f);
  for (const roots of pages.values()) {
    const sorted = ordered(roots), inner = sorted.map((root) => rects.get(root.id)!);
    place(sorted, inner, arrange(sorted, inner, SECTION_GAP, SECTION_GAP).offsets, 0);
  }
  return rects;
}

/** Sorts nodes by `order`, falling back to their position in `frames`, then id. */
const inOrder = (frames: readonly CanvasNode[]) => {
  const order = new Map(frames.map((f, i) => [f.id, f.order ?? i]));
  return (nodes: readonly CanvasNode[]) => [...nodes].sort((a, b) => order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
};

/**
 * Offsets inside a catalog's padding. Each component family ("Chip" in "Chip/Active") is a block that starts its
 * own row and wraps at the row width, with its name in a gutter to the left. A catalog much taller than wide stacks
 * these blocks in columns instead, so a long Design System grows as wide as it is tall. Columns keep family order,
 * top to bottom then left to right, and split where their heights balance.
 */
export function catalogLayout(names: readonly string[], sizes: readonly { w: number; h: number }[], gutter: number) {
  const blocks: { offsets: { x: number; y: number }[]; w: number; h: number }[] = [];
  for (let i = 0; i < sizes.length;) {
    const start = i, family = familyOf(names[i]!), offsets: { x: number; y: number }[] = [];
    let x = 0, y = 0, rowHeight = 0, w = 0;
    for (; i < sizes.length && (i === start || familyOf(names[i]!) === family); i++) {
      const s = sizes[i]!;
      if (x && x + s.w > CATALOG_ROW_WIDTH) { y += rowHeight + CATALOG_ROW_GAP; x = 0; rowHeight = 0; }
      offsets.push({ x, y });
      w = Math.max(w, x + s.w); rowHeight = Math.max(rowHeight, s.h); x += s.w + CATALOG_GAP;
    }
    blocks.push({ offsets, w, h: y + rowHeight });
  }
  const arrange = (starts: number[]) => {
    const offsets: { x: number; y: number }[] = [];
    let x = 0, h = 0;
    starts.forEach((start, c) => {
      const column = blocks.slice(start, starts[c + 1] ?? blocks.length);
      let y = 0;
      for (const b of column) { for (const o of b.offsets) offsets.push({ x: x + gutter + o.x, y: y + o.y }); y += b.h + CATALOG_ROW_GAP; }
      h = Math.max(h, y - CATALOG_ROW_GAP);
      x += gutter + Math.max(...column.map((b) => b.w)) + CATALOG_COLUMN_GAP;
    });
    return { offsets, w: x - CATALOG_COLUMN_GAP, h };
  };
  let best = arrange([0]);
  if (best.h <= best.w * CATALOG_TALL) return best;
  // Closest to square wins, within the same width budget as tiled sections.
  const skew = (a: { w: number; h: number }) => Math.abs(Math.log(a.w / a.h));
  for (let columns = 2; columns <= blocks.length; columns++) {
    const next = arrange(balancedStarts(blocks.map((b) => b.h), columns, CATALOG_ROW_GAP));
    if (next.w > TILE_WIDTH) break;
    if (skew(next) < skew(best)) best = next;
  }
  return best;
}

/**
 * First index of each of `columns` contiguous runs of `heights`, chosen so the tallest run (with gaps between
 * members) is as short as possible, then so the runs are as even as possible. Remaining ties make the last run the shortest.
 */
export function balancedStarts(heights: readonly number[], columns: number, gap: number) {
  const n = heights.length, sum = [0];
  for (const h of heights) sum.push(sum.at(-1)! + h);
  const run = (i: number, j: number) => sum[j]! - sum[i]! + (j - i - 1) * gap;
  // best[c][j]: the tallest run, then the sum of squared runs, when the first j heights fill c columns.
  type Cost = { tallest: number; spread: number; from: number };
  const best: Cost[][] = [Array.from({ length: n + 1 }, (_, j) => ({ tallest: j ? Infinity : 0, spread: 0, from: 0 }))];
  for (let c = 1; c <= columns; c++) {
    best.push(Array.from({ length: n + 1 }, () => ({ tallest: Infinity, spread: Infinity, from: 0 })));
    for (let j = c; j <= n; j++) {
      for (let i = c - 1; i < j; i++) {
        const prev = best[c - 1]![i]!, h = run(i, j), cur = best[c]![j]!;
        const tallest = Math.max(prev.tallest, h), spread = prev.spread + h * h;
        if (tallest < cur.tallest || tallest === cur.tallest && spread <= cur.spread) best[c]![j] = { tallest, spread, from: i };
      }
    }
  }
  const starts: number[] = [];
  for (let c = columns, j = n; c > 0; c--) starts.unshift(j = best[c]![j]!.from);
  return starts;
}

const isCatalog = (children: CanvasNode[]) => children.length > 0 && children.every((k) => k.kind === "component");

/** "Chip" for "Chip/Active"; empty for a name without a family. Matches the specimens' componentName. */
export const familyOf = (name: string) => name.includes("/") ? componentName(name).family : "";

/** Sections laid out as a catalog. */
export function catalogSectionIds(frames: CanvasNode[]) {
  const ids = new Set<string>();
  const sections = new Set(frames.filter((f) => f.kind === "section").map((f) => f.id));
  for (const [id, children] of childrenOf(frames)) if (sections.has(id) && isCatalog(children)) ids.add(id);
  return ids;
}

/** Where each catalog family's name goes: the gutter beside its first specimen, in whichever column it landed. */
export function catalogFamilyLabels(frames: CanvasNode[], rects: ReadonlyMap<string, Rect>, catalogs: ReadonlySet<string>) {
  const labels: { family: string; x: number; y: number }[] = [];
  const kids = childrenOf(frames), ordered = inOrder(frames);
  for (const id of catalogs) {
    if (!rects.has(id)) continue;
    const placed = ordered(kids.get(id) ?? []).filter((node) => rects.has(node.id));
    placed.forEach((node, i) => {
      const family = familyOf(node.name), rect = rects.get(node.id)!;
      if (family && family !== familyOf(placed[i - 1]?.name ?? "")) labels.push({ family, x: rect.x - CATALOG_GUTTER, y: rect.y });
    });
  }
  return labels;
}

export function childrenOf(frames: CanvasNode[]) {
  const kids = new Map<string, CanvasNode[]>();
  for (const f of frames) if (f.parentId) (kids.get(f.parentId) ?? kids.set(f.parentId, []).get(f.parentId)!).push(f);
  return kids;
}

export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
