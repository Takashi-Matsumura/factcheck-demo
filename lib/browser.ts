// Playwright Chromium のプロセス内シングルトン管理。
// 開発サーバは長時間常駐するため、毎リクエストで起動すると数秒のオーバーヘッドが乗る。
// ここでモジュールスコープにキャッシュして使い回す。

import type { Browser, BrowserContext } from "playwright";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FactCheckDemo/0.1";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) =>
      chromium.launch({ headless: true }),
    );
  }
  return browserPromise;
}

export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 1600 },
    locale: "ja-JP",
  });
}

/**
 * 開発サーバ終了時などに明示的にクリーンアップしたい場合用。
 * (Next.js dev サーバのホットリロードでは通常呼ばれない)
 */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}
