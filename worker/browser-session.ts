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
 * Closes this turn's pages and disconnects, leaving the browser running for the next turn; returns its session.
 * A browser that may be unhealthy (a timed-out session, a wedged page) closes instead, as does one whose pages
 * will not close.
 */
export async function releaseBrowser(browser: Browser, pages: Page[], healthy: boolean): Promise<string | undefined> {
  if (healthy) {
    try {
      await withTimeout(Promise.all(pages.map((page) => page.close())), 5000, "page close");
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
