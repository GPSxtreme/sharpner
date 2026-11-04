import { thumbnailUrl } from "../shared/thumbnail-url";

type PreviewGroup = { key: string; fileId: string; names: string[] };
type PendingPreview = {
  image: HTMLImageElement; url: string; group: PreviewGroup; decoded: (bitmap: ImageBitmap) => void;
  cancelled: boolean; batch?: PreviewBatch;
};
type PreviewBatch = { group: PreviewGroup; controller: AbortController; items: PendingPreview[]; timeout?: ReturnType<typeof setTimeout> };
const THUMBNAIL_URL = thumbnailUrl;
const PREVIEWS_PER_BATCH = 16;
const MAX_INFLIGHT_BATCHES = 4;
const BATCH_TIMEOUT_MS = 15_000;

function previewGroup(fileId: string, names: string[]): PreviewGroup {
  return {
    key: `/a/${fileId}/bundle?version=1&items=${encodeURIComponent(names.join(","))}`,
    fileId,
    names,
  };
}

// Native base64 decoding where the engine has it; this can run inside a paint, so avoid the per-byte loop.
const fromBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64;

function webpBlob(encoded: string) {
  let bytes: Uint8Array<ArrayBuffer>;
  if (fromBase64) bytes = fromBase64(encoded);
  else {
    const binary = atob(encoded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/webp" });
}

/** Bounded transport for one admitted viewport preview set. Original images keep native loading. */
export class PreviewLoader {
  private groups = new Map<string, PreviewGroup>();
  private ready = new Map<string, string>();
  private failed = new Set<string>();
  private pending: PendingPreview[] = [];
  private batches = new Map<string, PreviewBatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly maxBatches: number;
  private readonly decode: (blob: Blob) => Promise<ImageBitmap>;

  constructor(options: { maxBatches?: number; decode?: (blob: Blob) => Promise<ImageBitmap> } = {}) {
    this.maxBatches = Math.max(1, Math.min(MAX_INFLIGHT_BATCHES, options.maxBatches ?? MAX_INFLIGHT_BATCHES));
    // A detached image decodes on the main thread at its first drawImage; a bitmap is decoded before then.
    this.decode = options.decode ?? ((blob) => createImageBitmap(blob));
  }

  prepare = (urls: string[]) => {
    if (this.disposed) return;
    const previews = new Set(urls.filter((url) => THUMBNAIL_URL.test(url)));
    if (previews.size === this.groups.size && [...previews].every((url) => this.groups.has(url))) return;
    // A preview keeps its group while it stays admitted, so a pan requests only what it newly admits.
    // Sorting the new immutable URLs keeps a view's first keys stable as priorities and completions change.
    const groups = new Map<string, PreviewGroup>();
    const files = new Map<string, { url: string; name: string }[]>();
    for (const url of [...previews].sort()) {
      const group = this.groups.get(url);
      if (group) {
        groups.set(url, group);
        continue;
      }
      const match = THUMBNAIL_URL.exec(url)!;
      const entries = files.get(match[1]!) ?? [];
      entries.push({ url, name: match[2]! });
      files.set(match[1]!, entries);
    }
    for (const [fileId, entries] of files) {
      for (let start = 0; start < entries.length; start += PREVIEWS_PER_BATCH) {
        const chunk = entries.slice(start, start + PREVIEWS_PER_BATCH);
        const group = previewGroup(fileId, chunk.map((entry) => entry.name));
        for (const entry of chunk) groups.set(entry.url, group);
      }
    }
    this.groups = groups;
    for (const url of this.ready.keys()) if (!groups.has(url)) this.ready.delete(url);
    const keys = new Set([...groups.values()].map((group) => group.key));
    for (const key of this.failed) if (!keys.has(key)) this.failed.delete(key);
  };

  /** A bundle preview arrives through `decoded` as a bitmap; any other preview loads into `image`. */
  load = (image: HTMLImageElement, url: string, decoded: (bitmap: ImageBitmap) => void): (() => void) => {
    const match = THUMBNAIL_URL.exec(url);
    if (!match || this.disposed) {
      if (!this.disposed) image.src = url;
      return () => image.removeAttribute("src");
    }
    const group = this.groups.get(url) ?? previewGroup(match[1]!, [match[2]!]);
    const item: PendingPreview = { image, url, group, decoded, cancelled: false };
    const encoded = this.ready.get(url);
    if (encoded) this.decodePreview(item, encoded);
    else if (this.failed.has(group.key)) image.src = url;
    else {
      // A preview that left and returned while its old group is on its way joins that request.
      const batch = this.batches.get(group.key) ?? this.inflightWith(group.fileId, match[2]!);
      if (batch) {
        item.batch = batch;
        batch.items.push(item);
      } else {
        this.pending.push(item);
        this.schedule();
      }
    }
    return () => {
      item.cancelled = true;
      this.pending = this.pending.filter((candidate) => candidate !== item);
      image.removeAttribute("src");
      if (item.batch?.items.every((entry) => entry.cancelled)) item.batch.controller.abort();
    };
  };

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.groups.clear();
    this.ready.clear();
    this.failed.clear();
    for (const batch of this.batches.values()) {
      clearTimeout(batch.timeout);
      batch.controller.abort();
    }
    this.batches.clear();
  }

  private schedule() {
    if (this.disposed || this.timer !== null || this.batches.size >= this.maxBatches || !this.pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 0);
  }

  private flush() {
    this.pending = this.pending.filter((item) => !item.cancelled);
    while (!this.disposed && this.batches.size < this.maxBatches && this.pending.length) {
      const group = this.pending[0]!.group;
      const items: PendingPreview[] = [];
      this.pending = this.pending.filter((item) => {
        if (item.group.key !== group.key) return true;
        items.push(item);
        return false;
      });
      const batch: PreviewBatch = { group, controller: new AbortController(), items };
      for (const item of items) item.batch = batch;
      this.batches.set(group.key, batch);
      batch.timeout = setTimeout(() => batch.controller.abort(), BATCH_TIMEOUT_MS);
      void this.fetchBatch(group, batch);
    }
  }

  private async fetchBatch(group: PreviewGroup, batch: PreviewBatch) {
    // New consumers can join this array while the request is in flight.
    const { controller, items } = batch;
    try {
      const response = await fetch(group.key, { signal: controller.signal, credentials: "omit" });
      if (!response.ok) throw new Error("Preview batch unavailable");
      const data = await response.json() as { previews: { url: string; data?: string }[] };
      const previews = new Map(data.previews.map((preview) => [preview.url, preview.data]));
      for (const name of group.names) {
        const url = `/a/${group.fileId}/t/${name}`;
        const encoded = previews.get(url);
        if (this.groups.has(url) && encoded) this.ready.set(url, encoded);
        if (!encoded) this.failed.add(group.key);
      }
      for (const item of items) {
        if (this.disposed || item.cancelled) continue;
        const encoded = previews.get(item.url);
        if (encoded) this.decodePreview(item, encoded);
        else item.image.src = item.url;
      }
    } catch {
      if (!controller.signal.aborted) this.failed.add(group.key);
      for (const item of items) {
        if (!this.disposed && !item.cancelled) item.image.src = item.url;
      }
    } finally {
      clearTimeout(batch.timeout);
      for (const item of items) item.batch = undefined;
      this.batches.delete(group.key);
      this.schedule();
    }
  }

  private inflightWith(fileId: string, name: string) {
    for (const batch of this.batches.values()) if (batch.group.fileId === fileId && batch.group.names.includes(name)) return batch;
    return undefined;
  }

  private decodePreview(item: PendingPreview, encoded: string) {
    new Promise<ImageBitmap>((resolve) => resolve(this.decode(webpBlob(encoded)))).then((bitmap) => {
      // No cache entry will draw or release a bitmap that resolves after its load ended.
      if (this.disposed || item.cancelled) bitmap.close();
      else item.decoded(bitmap);
    }, () => {
      if (this.disposed || item.cancelled) return;
      // Fall back to the immutable URL, and send this group's retries there instead of refetching it.
      this.ready.delete(item.url);
      this.failed.add(item.group.key);
      item.image.src = item.url;
    });
  }
}
