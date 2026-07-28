// ハイブリッド検索: 実ブラウザ (Playwright) で Bing を検索し、失敗時は
// Wikipedia API にフォールバックする。curl 等の単純な HTTP リクエストは
// DuckDuckGo / Bing 双方でボット判定されブロックされることを確認済みのため、
// 実ブラウザ経由を第一手段にしている。

import type { Page } from "playwright";

export interface SearchHit {
  url: string;
  title: string;
}

/** Bing の `bing.com/ck/a?...&u=a1BASE64&...` 形式のトラッキングリダイレクトを実URLに戻す。 */
function decodeBingRedirect(href: string): string | null {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("bing.com")) return href;
    const param = u.searchParams.get("u");
    if (!param) return null;
    const b64 = param.startsWith("a1") ? param.slice(2) : param;
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return decodeURIComponent(decoded);
  } catch {
    return null;
  }
}

export async function searchBing(
  page: Page,
  query: string,
  limit = 5,
): Promise<SearchHit[]> {
  await page.goto(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja&mkt=ja-JP`,
    { waitUntil: "domcontentloaded", timeout: 15_000 },
  );
  const raw = await page.$$eval("li.b_algo h2 a", (anchors) =>
    anchors.map((a) => ({
      title: a.textContent?.trim() ?? "",
      href: (a as HTMLAnchorElement).href,
    })),
  );

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of raw) {
    const url = decodeBingRedirect(r.href);
    if (!url || !url.startsWith("http") || url.includes("bing.com")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title: r.title || url });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function searchWikipedia(
  query: string,
  limit = 3,
): Promise<SearchHit[]> {
  const res = await fetch(
    `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query,
    )}&srlimit=${limit}&format=json`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return [];
  const data = await res.json();
  const results = (data?.query?.search ?? []) as Array<{ title: string }>;
  return results.map((r) => ({
    title: r.title,
    url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
  }));
}

export interface HybridSearchResult {
  hits: SearchHit[];
  usedFallback: boolean;
}

/**
 * Bing をまず試し、結果が 0 件、またはエラー（ボット判定・タイムアウト等）の場合は
 * Wikipedia API に自動フォールバックする。
 */
export async function hybridSearch(
  page: Page,
  query: string,
  limit = 5,
): Promise<HybridSearchResult> {
  try {
    const hits = await searchBing(page, query, limit);
    if (hits.length > 0) return { hits, usedFallback: false };
  } catch {
    // 検索エンジン側のブロック・タイムアウトはフォールバックへ
  }
  const hits = await searchWikipedia(query, limit);
  return { hits, usedFallback: true };
}
