import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewLoader } from "./preview-loader";
import { ThumbnailCache } from "./thumbnail-cache";

const file = "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437";
const url = (i: number, fileId = file) => `/a/${fileId}/t/00000000-0000-4000-8000-${String(i).padStart(12, "0")}-1-lo.webp`;
const nameOf = (url: string) => url.split("/t/")[1]!;
class Image {
  src = "";
  decoding = ""; fetchPriority = "";
  naturalWidth = 256; naturalHeight = 256;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute() { this.src = ""; }
}
/** Records the bytes it was decoded from. Closing it reports 0x0, as a real ImageBitmap does. */
class Bitmap {
  constructor(readonly data: string, public width = 256, public height = 256) {}
  close = vi.fn(() => { this.width = this.height = 0; });
}
const image = () => new Image() as unknown as HTMLImageElement;
const ignore = () => {};
const fetcher = vi.fn<typeof fetch>();
const decode = vi.fn<(blob: Blob) => Promise<ImageBitmap>>();
const items = (call: number) => new URL(String(fetcher.mock.calls[call]![0]), "https://sharpner.example").searchParams.get("items")!.split(",");
let loader: PreviewLoader;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetcher);
  // Each preview's bytes are its own name, so a decoded bitmap shows which preview it came from.
  fetcher.mockReset().mockImplementation(async (input) => {
    const request = new URL(String(input), "https://sharpner.example");
    const fileId = request.pathname.split("/")[2]!;
    return Response.json({ previews: request.searchParams.get("items")!.split(",").map((name) => ({
      url: `/a/${fileId}/t/${name}`, data: btoa(name),
    })) });
  });
  decode.mockReset().mockImplementation(async (blob) => new Bitmap(await blob.text()) as unknown as ImageBitmap);
  loader = new PreviewLoader({ decode });
});
afterEach(() => { loader.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("canvas preview batches", () => {
  it("batches new theme-pair names together with legacy previews", async () => {
    const themed=url(2).replace("-1-lo.webp",`-2-${"a".repeat(64)}-lo.webp`);
    loader.prepare([url(1),themed]);
    const img=image(), decoded=vi.fn();loader.load(img,themed,decoded);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]![0]),"https://sharpner.example").searchParams.get("items")).toContain("a".repeat(64));
    expect(decode.mock.calls[0]![0].type).toBe("image/webp");
    expect(decoded.mock.calls[0]![0].data).toBe(nameOf(themed));
    expect(img.src).toBe("");
  });

  it("keeps batch URLs stable when paint priority and image completion order change", async () => {
    const urls = Array.from({ length: 32 }, (_, i) => url(i));
    loader.prepare(urls);
    loader.load(image(), url(0), ignore);
    loader.load(image(), url(20), ignore);
    await vi.advanceTimersByTimeAsync(10);
    const first = fetcher.mock.calls.map(([request]) => String(request)).sort();
    loader.dispose();
    loader = new PreviewLoader({ decode });
    fetcher.mockClear();
    loader.prepare([...urls].reverse());
    loader.load(image(), url(20), ignore);
    loader.load(image(), url(0), ignore);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher.mock.calls.map(([request]) => String(request)).sort()).toEqual(first);
  });

  it("loads a real 159-preview cache working set in ten requests while retaining every image", async () => {
    const images: Image[] = [];
    const cache = new ThumbnailCache(() => {}, { loadImage: loader.load, prepareImages: loader.prepare, createImage: () => {
      const img = new Image(); images.push(img); return img as unknown as HTMLImageElement;
    } });
    cache.setViewport(Array.from({ length: 159 }, (_, i) => ({ url: url(i), priority: 159 - i })));
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(images).toHaveLength(159);
    // Every preview decoded from its batch; none fell back to its individual URL.
    expect(images.every((img) => !img.src)).toBe(true);
    expect(cache.stats.loading).toBe(0);
    expect(cache.stats.queued).toBe(0);
    expect(cache.stats.decodedPixels).toBe(159 * 256 * 256);
    for (let i = 0; i < 159; i++) expect((cache.get(url(i)) as unknown as Bitmap).data).toBe(nameOf(url(i)));
    cache.dispose();
  });

  it("keeps at most four sixteen-image batches in flight and starts queued work only after one completes", async () => {
    const responses: ((response: Response) => void)[] = [];
    fetcher.mockImplementation(() => new Promise((resolve) => responses.push(resolve)));
    loader.prepare(Array.from({ length: 80 }, (_, i) => url(i)));
    for (let i = 0; i < 80; i++) loader.load(image(), url(i), ignore);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const call of fetcher.mock.calls) expect(new URL(String(call[0]), "https://sharpner.example").searchParams.get("items")!.split(",")).toHaveLength(16);
    responses[0]!(Response.json({ previews: [] }));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(new URL(String(fetcher.mock.calls[4]![0]), "https://sharpner.example").searchParams.get("items")!.split(",")).toHaveLength(16);
  });

  it("never mixes files in a batch or substitutes original image uploads", async () => {
    const original = image();
    loader.prepare([url(1), url(2, "00000000-0000-4000-8000-000000000002")]);
    loader.load(original, "/a/file/u/original.jpg", ignore);
    loader.load(image(), url(1), ignore);
    loader.load(image(), url(2, "00000000-0000-4000-8000-000000000002"), ignore);
    await vi.advanceTimersByTimeAsync(10);
    expect(original.src).toBe("/a/file/u/original.jpg");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("loads the sharper working set in two stable batches while decoding only two images at a time", async () => {
    loader.dispose();
    loader = new PreviewLoader({ maxBatches: 1, decode });
    const images: Image[] = [];
    const cache = new ThumbnailCache(() => {}, {
      maxConcurrent: 2, maxEntries: 32, maxPixels: 32 * 1024 * 1024,
      loadImage: loader.load, prepareImages: loader.prepare,
      createImage: () => {
        const img = new Image(); images.push(img); return img as unknown as HTMLImageElement;
      },
    });
    const urls = Array.from({ length: 32 }, (_, i) => url(i).replace("-lo.webp", "-hi.webp"));
    cache.setViewport(urls.map((url) => ({ url, priority: 1 })));
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10);
      expect(cache.stats.loading).toBeLessThanOrEqual(2);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(images.every((img) => !img.src)).toBe(true);
    expect(urls.every((url) => cache.get(url))).toBe(true);
    cache.dispose();
  });

  it("falls back to individual immutable images if a batch fails or omits an entry", async () => {
    const first = image(), second = image(), decoded = vi.fn();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    loader.load(first, url(1), decoded);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.src).toBe(url(1));
    fetcher.mockResolvedValueOnce(Response.json({ previews: [] }));
    loader.load(second, url(2), decoded);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.src).toBe(url(2));
    expect(decoded).not.toHaveBeenCalled();
  });

  it("removes cancelled queued work and ignores a response arriving after disposal", async () => {
    const cancelled = image(), decoded = vi.fn();
    loader.load(cancelled, url(1), decoded)();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).not.toHaveBeenCalled();
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise((r) => { resolve = r; }));
    const late = image();
    loader.load(late, url(2), decoded);
    await vi.advanceTimersByTimeAsync(10);
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    loader.dispose();
    expect(signal.aborted).toBe(true);
    resolve(Response.json({ previews: [{ url: url(2), data: btoa("late") }] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(late.src).toBe("");
    expect(decode).not.toHaveBeenCalled();
    expect(decoded).not.toHaveBeenCalled();
  });

  it("requests only the previews a pan newly admits, keeping every admitted preview's group", async () => {
    const cache = new ThumbnailCache(() => {}, { loadImage: loader.load, prepareImages: loader.prepare, createImage: image });
    const shown = Array.from({ length: 48 }, (_, i) => url(2 * i));
    cache.setViewport(shown.map((url) => ({ url, priority: 1 })));
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(shown.every((url) => cache.get(url))).toBe(true);
    fetcher.mockClear();
    decode.mockClear();
    // Sorted in among the shown previews, these names would fall into every existing group.
    const panned = Array.from({ length: 8 }, (_, i) => url(12 * i + 1));
    cache.setViewport([...shown, ...panned].map((url) => ({ url, priority: 1 })));
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(items(0)).toEqual(panned.map(nameOf));
    expect(decode).toHaveBeenCalledTimes(8);
    expect([...shown, ...panned].every((url) => cache.get(url))).toBe(true);
    cache.dispose();
  });

  it("groups a preview that left the working set and returned as new", async () => {
    const urls = Array.from({ length: 16 }, (_, i) => url(i));
    loader.prepare(urls);
    loader.load(image(), url(0), ignore);
    await vi.advanceTimersByTimeAsync(10);
    expect(items(0)).toEqual(urls.map(nameOf));
    loader.prepare(urls.filter((candidate) => candidate !== url(5)));
    loader.prepare([...urls, url(40)]);
    const returned = vi.fn(), kept = vi.fn();
    loader.load(image(), url(5), returned);
    loader.load(image(), url(3), kept);
    await vi.advanceTimersByTimeAsync(10);
    // The returning preview's data left with it, and it joins only the other new preview. A
    // preview that stayed still decodes from the batch it already has.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(items(1)).toEqual([url(5), url(40)].map(nameOf));
    expect(returned.mock.calls[0]![0].data).toBe(nameOf(url(5)));
    expect(kept.mock.calls[0]![0].data).toBe(nameOf(url(3)));
  });

  it("joins a returning preview to the request already carrying its bytes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const respond = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (input, init) => { await held; return respond(input, init); });
    const urls = Array.from({ length: 16 }, (_, i) => url(i));
    loader.prepare(urls);
    loader.load(image(), url(0), ignore);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The preview leaves and returns while the request for its old group is still on its way.
    loader.prepare(urls.filter((candidate) => candidate !== url(5)));
    loader.prepare(urls);
    const returned = vi.fn();
    loader.load(image(), url(5), returned);
    await vi.advanceTimersByTimeAsync(10);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(returned.mock.calls[0]![0].data).toBe(nameOf(url(5)));
  });

  it("forgets a failed batch once its previews leave, so their return batches again", async () => {
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const urls = [url(1), url(2)];
    loader.prepare(urls);
    const first = image(), second = image(), decoded = vi.fn();
    loader.load(first, url(1), decoded);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.src).toBe(url(1));
    loader.load(second, url(2), decoded);
    expect(second.src).toBe(url(2));
    loader.prepare([]);
    loader.prepare(urls);
    loader.load(image(), url(2), decoded);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(decoded).toHaveBeenCalledTimes(1);
  });

  it("makes a batch preview ready only once its bitmap has decoded", async () => {
    const decodes: { blob: Blob; resolve: (bitmap: ImageBitmap) => void }[] = [];
    decode.mockImplementation((blob) => new Promise((resolve) => decodes.push({ blob, resolve })));
    const changed = vi.fn();
    const cache = new ThumbnailCache(changed, { loadImage: loader.load, prepareImages: loader.prepare, createImage: image });
    cache.setViewport([{ url: url(1), priority: 1 }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(decodes).toHaveLength(1);
    expect(decodes[0]!.blob.type).toBe("image/webp");
    expect(await decodes[0]!.blob.text()).toBe(nameOf(url(1)));
    expect(cache.get(url(1))).toBeNull();
    expect(cache.stats.loading).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    const bitmap = new Bitmap("decoded", 300, 200);
    decodes[0]!.resolve(bitmap as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get(url(1))).toBe(bitmap);
    expect(cache.stats.decodedPixels).toBe(300 * 200);
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("closes a bitmap that decodes after its load was cancelled or the loader disposed", async () => {
    const decodes: ((bitmap: ImageBitmap) => void)[] = [];
    decode.mockImplementation(() => new Promise((resolve) => decodes.push(resolve)));
    loader.prepare([url(1), url(2)]);
    const cancelled = vi.fn(), disposed = vi.fn();
    const cancel = loader.load(image(), url(1), cancelled);
    loader.load(image(), url(2), disposed);
    await vi.advanceTimersByTimeAsync(10);
    expect(decodes).toHaveLength(2);
    cancel();
    const first = new Bitmap("1");
    decodes[0]!(first as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    loader.dispose();
    const second = new Bitmap("2");
    decodes[1]!(second as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
  });

  it("falls back to the immutable URL when a batch preview cannot be decoded, without refetching the batch", async () => {
    decode.mockRejectedValueOnce(new DOMException("The source image cannot be decoded.", "InvalidStateError"));
    const images: Image[] = [];
    const cache = new ThumbnailCache(() => {}, { loadImage: loader.load, prepareImages: loader.prepare, createImage: () => {
      const img = new Image(); images.push(img); return img as unknown as HTMLImageElement;
    } });
    cache.setViewport([{ url: url(1), priority: 1 }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(images[0]!.src).toBe(url(1));
    expect(cache.get(url(1))).toBeNull();
    images[0]!.onload!();
    expect(cache.get(url(1))).toBe(images[0]);
    // A later load of the same preview goes straight to its URL rather than to the batch again.
    const retry = image();
    loader.load(retry, url(1), ignore);
    expect(retry.src).toBe(url(1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    cache.dispose();
  });
});
