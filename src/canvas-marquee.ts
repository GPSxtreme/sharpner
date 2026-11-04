import type { Rect } from "../shared/layout";

type Point = { x: number; y: number };

/** The world rectangle a marquee spans, from where the drag started to the pointer, in any direction. */
export const marqueeRect = (from: Point, to: Point): Rect => ({
  x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y),
});

/** A marquee adds every node it overlaps to the selection it started from. Touching an edge is not overlapping. */
export function marqueeSelection<T extends { id: string }>(base: readonly string[], area: Rect, nodes: readonly T[], rectOf: (node: T) => Rect): string[] {
  const hits = nodes.filter((node) => {
    const r = rectOf(node);
    return r.x < area.x + area.w && r.x + r.w > area.x && r.y < area.y + area.h && r.y + r.h > area.y;
  }).map((node) => node.id);
  return [...new Set([...base, ...hits])];
}

/** Whether two selections hold the same nodes, in any order. */
export function sameSelection(a: readonly string[], b: readonly string[]) {
  if (a === b) return true;
  const set = new Set(a);
  return b.length === set.size && b.every((id) => set.has(id));
}

/**
 * The selection a finished marquee writes, or null when it never moved or ends with the same nodes selected.
 * The URL owns selection and browsers throttle history writes, so a drag commits once, on release.
 */
export function marqueeCommit(current: readonly string[], dragged: string[] | null): string[] | null {
  return !dragged || sameSelection(current, dragged) ? null : dragged;
}
