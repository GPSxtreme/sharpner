import { describe, expect, it } from "vitest";
import { scopeDesign } from "./component-scope";
import { interactionDocument } from "./interaction-document";
import { componentTag, frameDocument, renderedHtml, type DesignSystem } from "./types";

const tokens = "@theme { --color-primary: #4f46e5; }";
// Design order differs from use order, which the result must keep.
const design = (overrides: Record<string, string> = {}): DesignSystem => ({
  tokens,
  components: Object.entries({
    "x-button": '<button class="bg-primary">{{label|Go}}</button>',
    "x-unused": "<aside>Unused</aside>",
    "x-card": "<article><slot></slot><x-button></x-button></article>",
    "x-page": "<main><x-card>Body</x-card></main>",
    ...overrides,
  }).map(([tag, html]) => ({ tag, html })),
});
const tags = (scoped: DesignSystem) => scoped.components.map((c) => c.tag);
const live = (html: string, d: DesignSystem) => frameDocument(html, { measure: true, base: "https://sharpner.test", design: scopeDesign(html, d) });

describe("scopeDesign", () => {
  it("keeps the components a document uses and the ones they nest, in design order", () => {
    const scoped = scopeDesign("<x-page></x-page>", design());
    expect(tags(scoped)).toEqual(["x-button", "x-card", "x-page"]);
    expect(scoped.tokens).toBe(tokens);
    expect(tags(scopeDesign("<x-card>Hi</x-card>", design()))).toEqual(["x-button", "x-card"]);
    expect(scopeDesign("<p>No components</p>", design())).toEqual({ tokens, components: [] });
  });

  it("builds the same live and playback documents when an unrelated component changes", () => {
    const html = "<x-card>Hi</x-card>";
    const edited = design({ "x-unused": "<aside>Edited</aside>", "x-page": "<main>Edited</main>" });
    expect(live(html, edited)).toBe(live(html, design()));
    const play = (d: DesignSystem) => interactionDocument(html, { base: "https://sharpner.test", token: "t", design: scopeDesign(html, d) });
    expect(play(edited)).toBe(play(design()));
    // The whole design would have changed it.
    expect(frameDocument(html, { design: edited })).not.toBe(frameDocument(html, { design: design() }));
  });

  it("changes the document when a used nested component or the tokens change", () => {
    const html = "<x-page></x-page>";
    expect(live(html, design({ "x-button": "<button>Edited</button>" }))).not.toBe(live(html, design()));
    expect(live(html, { ...design(), tokens: "@theme { --color-primary: red; }" })).not.toBe(live(html, design()));
  });

  it("keeps a tag that only a script mentions, written in any letter case", () => {
    expect(tags(scopeDesign('<div id="root"></div><script>root.innerHTML = "<x-card></x-card>"</script>', design()))).toEqual(["x-button", "x-card"]);
    expect(tags(scopeDesign('<script>document.body.append(document.createElement("x-page"))</script>', design()))).toEqual(["x-button", "x-card", "x-page"]);
    expect(tags(scopeDesign("<X-Button></X-Button>", design()))).toEqual(["x-button"]);
  });

  it("keeps every component when a tag name is built at runtime", () => {
    const all = ["x-button", "x-unused", "x-card", "x-page"];
    for (const html of [
      "<script>document.body.append(document.createElement(`x-${kind}`))</script>",
      "<script>root.innerHTML = `<x-card-${variant}></x-card-${variant}>`</script>",
      '<script>document.createElement("x-" + name)</script>',
      "<script>document.createElement('x-card-'+variant)</script>",
      '<script>document.createElement("x-".concat(name))</script>',
      '<script>const prefix = "x-"; document.createElement(prefix + name)</script>',
      // Inline handlers decode entities before they run; JSON inside a script escapes its quotes.
      '<button onclick="this.append(document.createElement(&quot;x-&quot; + this.dataset.kind))" data-kind="star">Add</button>',
      "<button onclick=\"make(&#39;x-card-&#39;+variant)\">Add</button>",
      "<button onclick=\"make(&#x27;x-&#x27;.concat(variant))\">Add</button>",
      '<script>run("document.createElement(\\"x-\\" + kind)")</script>',
    ]) expect(tags(scopeDesign(html, design())), html).toEqual(all);
    // A placeholder inside a used component builds its tag from the instance's attributes.
    expect(tags(scopeDesign('<x-card icon="unused"></x-card>', design({ "x-button": "<x-{{icon|button}}></x-{{icon|button}}>" })))).toEqual(all);
    // "x-" inside a word, as in max-w or px-4, is not a tag prefix.
    expect(tags(scopeDesign('<div class="max-w-xl px-4 flex-col"></div><script>el.className = `max-w-${size}`</script>', design()))).toEqual([]);
  });

  it("keeps a component specimen's own definition", () => {
    const name = "Button/Primary";
    const d: DesignSystem = { tokens, components: [{ tag: "x-other", html: "<p>Other</p>" }, { tag: componentTag(name), html: "<button><x-icon></x-icon>Go</button>" }, { tag: "x-icon", html: "<svg></svg>" }] };
    expect(tags(scopeDesign(renderedHtml({ kind: "component", name }, "<button><x-icon></x-icon>Go</button>", d), d))).toEqual(["x-button-primary", "x-icon"]);
    const dark = { ...d, tokens: `${tokens} [data-theme="dark"] { --color-primary: #818cf8; }` };
    const specimen = renderedHtml({ kind: "component", name }, "<button><x-icon></x-icon>Go</button>", dark);
    expect(specimen).toContain('data-theme="dark"');
    expect(tags(scopeDesign(specimen, dark))).toEqual(["x-button-primary", "x-icon"]);
  });

  it("answers repeated calls from memory, per design and document", () => {
    const d = design();
    const html = "<x-card></x-card>";
    expect(scopeDesign(html, d)).toBe(scopeDesign(html, d));
    expect(scopeDesign(html, d)).not.toBe(scopeDesign(html, design()));
    // A document using everything renders with the design itself.
    expect(scopeDesign("<x-page></x-page><x-unused></x-unused>", d)).toBe(d);
  });

  it("bounds the remembered documents by text, keeping the newest", () => {
    const d = design();
    const large = (tag: string) => `<${tag}></${tag}>${"<p>filler</p>".repeat(250_000)}`;
    const first = scopeDesign(large("x-card"), d);
    expect(scopeDesign(large("x-card"), d)).toBe(first);
    const second = scopeDesign(large("x-page"), d);
    expect(scopeDesign(large("x-page"), d)).toBe(second);
    // Two 3.25M-character documents exceed the per-design text budget, so the older one is computed again.
    const again = scopeDesign(large("x-card"), d);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it("stays linear on long runs of tag prefixes", () => {
    const started = performance.now();
    expect(tags(scopeDesign("x-".repeat(200_000), design()))).toEqual([]);
    // A quadratic scan of this 400 KB run takes tens of seconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
