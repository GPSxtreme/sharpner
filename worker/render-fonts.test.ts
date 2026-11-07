import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRenderDesign, pruneFontFaces } from "./render-fonts";
afterEach(()=>vi.unstubAllGlobals());
describe("shared web-font preparation",()=>{
  it("fetches stylesheet and font bytes once, before paid browser work, preserving font-face descriptors",async()=>{
    const fetcher = vi.fn(async(url:string)=>new Response(url.includes("googleapis")?'@font-face {font-family:Inter; font-weight:100 900; src:url(https://fonts.gstatic.com/test.woff2) format("woff2");}':new Uint8Array([1,2,3])));
    vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Inter-test"); @theme {--font-sans:Inter}',components:[]};
    const prepared=await prepareRenderDesign(design);
    expect(prepared.fonts).toContain("data:font/woff2;base64,AQID");
    expect(prepared.fonts).toContain("font-weight:100 900");
    // Font bytes stay out of the Tailwind source, and the remote link is no longer needed.
    expect(prepared.tokens).toBe(' @theme {--font-sans:Inter}');
    expect(await prepareRenderDesign(design)).toEqual(prepared);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("leaves other providers alone and falls back to the original font link on upstream failure",async()=>{
    const fetcher=vi.fn(async()=>new Response("unavailable",{status:503}));vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Fallback-test"); @import url("https://other.example/fonts.css");',components:[]};
    expect(await prepareRenderDesign(design)).toBe(design);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("font subsets for a sprite", () => {
  const face = (subset: string, range?: string) => `/* ${subset} */\n@font-face {\n  font-family: 'Inter';\n  src: url(data:font/woff2;base64,${subset}) format('woff2');${range ? `\n  unicode-range: ${range};` : ""}\n}\n`;
  const sheet = face("latin", "U+0000-00FF, U+0131, U+2000-206F, U+20AC") + face("cyrillic", "U+0301, U+0400-045F, U+0490-0491") + face("greek", "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF") + face("vietnamese", "U+1EA0-1EF9, U+20AB") + face("variable");
  const kept = (text: string) => [...pruneFontFaces(sheet, text).matchAll(/base64,(\w+)/g)].map((m) => m[1]);
  it("keeps only the subsets whose ranges cover the documents' characters, and faces without a range", async () => {
    expect(kept("<p class=\"p-4\">Hello – €12</p>")).toEqual(["latin", "variable"]);
    expect(kept("<p>Привет and Ελληνικά</p>")).toEqual(["latin", "cyrillic", "greek", "variable"]);
    expect(kept("Tiếng Việt")).toEqual(["latin", "vietnamese", "variable"]);
  });
  it("reads single code points and wildcard ranges", async () => {
    expect([...pruneFontFaces(face("one", "U+0131") + face("wild", "U+4??"), "ı").matchAll(/base64,(\w+)/g)].map((m) => m[1])).toEqual(["one"]);
    expect([...pruneFontFaces(face("one", "U+0131") + face("wild", "U+4??"), "ѐ").matchAll(/base64,(\w+)/g)].map((m) => m[1])).toEqual(["wild"]);
  });
});
