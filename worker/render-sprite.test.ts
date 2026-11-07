import { describe, expect, it } from "vitest";
import { hiScale } from "./render";
import { alignment, planSprites } from "./render-sprite";

const node = (id: string, width = 400, height: number | null = null, measuredHeight: number | null = null) => ({ id, width, height, measuredHeight });
const ids = (sprites: { id: string }[][]) => sprites.map((s) => s.map((n) => n.id));

describe("sprite planning", () => {
  it("shares the batch across tabs in order, so the first nodes render first", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => node(`n${i}`));
    expect(ids(planSprites(jobs, 4))).toEqual([["n0", "n1", "n2"], ["n3", "n4", "n5"], ["n6", "n7", "n8"], ["n9"]]);
    expect(planSprites([], 4)).toEqual([]);
  });

  it("caps each sprite by node count and by the area it is expected to cover", () => {
    const many = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
    expect(planSprites(many, 1, { nodes: 12, pixels: Infinity }).map((s) => s.length)).toEqual([12, 12, 6]);
    // A known measured height counts; without one, an auto-height node is planned at its first 800px layout.
    const tall = [node("a", 1000, null, 3000), node("b", 1000, null, 3000), node("c", 1000), node("d", 1000, 500)];
    expect(ids(planSprites(tall, 1, { nodes: 24, pixels: 6_500_000 }))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("puts frames wider than the sharp tier in sprites of their own width, captured at one scale", () => {
    const jobs = [node("phone", 390), node("desk", 1440), node("card", 400), node("wide", 1920), node("desk2", 1440)];
    const sprites = planSprites(jobs, 1);
    expect(ids(sprites)).toEqual([["phone", "card"], ["desk", "desk2"], ["wide"]]);
    for (const sprite of sprites) expect(new Set(sprite.map((n) => hiScale(n.width))).size).toBe(1);
  });

  it("aligns offsets so a scaled crop starts on a whole pixel", () => {
    expect([400, 1280, 1440, 1920, 2560].map(alignment)).toEqual([1, 1, 9, 3, 2]);
    for (let width = 1281; width <= 3000; width++) {
      const step = alignment(width) * hiScale(width);
      expect(Math.abs(step - Math.round(step))).toBeLessThan(1e-9);
    }
  });
});
