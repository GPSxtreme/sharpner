import { describe, expect, it } from "vitest";
import type { Rect } from "../shared/layout";
import { marqueeCommit, marqueeRect, marqueeSelection, sameSelection } from "./canvas-marquee";

const nodes: { id: string; rect: Rect }[] = [
  { id: "home", rect: { x: 0, y: 0, w: 100, h: 100 } },
  { id: "payment", rect: { x: 200, y: 0, w: 100, h: 100 } },
  { id: "receipt", rect: { x: 400, y: 0, w: 100, h: 100 } },
];
const select = (base: string[], from: { x: number; y: number }, to: { x: number; y: number }) =>
  marqueeSelection(base, marqueeRect(from, to), nodes, (node) => node.rect);

describe("canvas marquee", () => {
  it("spans the same area whichever way it is dragged", () => {
    expect(marqueeRect({ x: 250, y: 120 }, { x: 50, y: -20 })).toEqual({ x: 50, y: -20, w: 200, h: 140 });
    expect(marqueeRect({ x: 50, y: -20 }, { x: 250, y: 120 })).toEqual({ x: 50, y: -20, w: 200, h: 140 });
  });

  it("adds overlapped nodes to the selection it started from, without duplicates", () => {
    expect(select([], { x: 50, y: 50 }, { x: 250, y: 60 })).toEqual(["home", "payment"]);
    expect(select(["receipt", "home"], { x: 50, y: 50 }, { x: 250, y: 60 })).toEqual(["receipt", "home", "payment"]);
    // Shrinking the marquee drops what it no longer covers, but never the starting selection.
    expect(select(["receipt"], { x: 50, y: 50 }, { x: 60, y: 60 })).toEqual(["receipt", "home"]);
  });

  it("ignores nodes that only touch its edge", () => {
    expect(select([], { x: 100, y: 0 }, { x: 200, y: 100 })).toEqual([]);
  });

  it("compares selections by membership, so an unchanged drag keeps the toolbar still", () => {
    expect(sameSelection(["home", "payment"], ["payment", "home"])).toBe(true);
    expect(sameSelection([], [])).toBe(true);
    expect(sameSelection(["home"], ["home", "payment"])).toBe(false);
    expect(sameSelection(["home", "payment"], ["home", "receipt"])).toBe(false);
  });

  it("commits at release only when the selection changed", () => {
    // A click without a drag, and a drag that covered nothing new, leave the URL alone.
    expect(marqueeCommit(["home"], null)).toBeNull();
    expect(marqueeCommit(["home"], ["home"])).toBeNull();
    expect(marqueeCommit(["payment", "home"], ["home", "payment"])).toBeNull();
    expect(marqueeCommit([], [])).toBeNull();
    expect(marqueeCommit(["home"], ["home", "payment"])).toEqual(["home", "payment"]);
    // Escape cleared the selection mid-drag; release still selects what the marquee covers.
    expect(marqueeCommit([], ["home"])).toEqual(["home"]);
  });
});
