import puppeteer from "@cloudflare/puppeteer";
import { withTimeout } from "./render";

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

/**
 * Reconnects to the session the previous automatic turn left warm, when it still answers; otherwise launches a
 * browser that can stay warm for `keepAliveMs` after this turn. A launch costs one to two seconds in production.
 * Only a session Sharpner itself left is reused, never another idle session on the account.
 */
export async function openBrowser(endpoint: Parameters<typeof puppeteer.launch>[0], warm: string | undefined, keepAliveMs: number): Promise<{ browser: Browser; reused: boolean }> {
  if (warm) {
    try {
      return { browser: await withTimeout(puppeteer.connect(endpoint, warm), 5000, "browser connect"), reused: true };
    } catch (err) {
      console.warn("thumbnail browser reconnect failed", String(err));
    }
  }
  return { browser: await puppeteer.launch(endpoint, { keep_alive: keepAliveMs }), reused: false };
}

/**
 * Opens a tab in a browser context of its own. Puppeteer serializes screenshots per context and brings the
 * capturing tab to the front of its window, so tabs sharing one context take turns capturing; in their own
 * contexts they capture in parallel. Falls back to the shared context when contexts are unavailable.
 */
export async function openTab(browser: Browser, ownContext = true): Promise<Page> {
  if (!ownContext) return browser.newPage();
  try {
    return await (await browser.createBrowserContext()).newPage();
  } catch (err) {
    console.warn("thumbnail browser context failed", String(err));
    return browser.newPage();
  }
}

/**
 * Closes this turn's pages and disconnects, leaving the browser running for the next turn; returns its session.
 * A browser that may be unhealthy (a timed-out session, a wedged page) closes instead, as does one whose pages
 * will not close.
 */
export async function releaseBrowser(browser: Browser, pages: Page[], healthy: boolean): Promise<string | undefined> {
  if (healthy) {
    try {
      // A tab's own context closes with its pages; a tab in the shared context closes alone.
      await withTimeout(Promise.all(pages.map((page) => {
        const context = page.browserContext?.();
        return context && context !== browser.defaultBrowserContext() ? context.close() : page.close();
      })), 5000, "page close");
      const session = browser.sessionId();
      await browser.disconnect();
      return session;
    } catch (err) {
      console.warn("thumbnail browser release failed", String(err));
    }
  }
  await withTimeout(browser.close(), 5000, "browser close").catch(() => {});
  return undefined;
}
