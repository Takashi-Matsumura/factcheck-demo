// ハイブリッド検索: 実ブラウザ (Playwright) で Bing を検索し、失敗時は
// Wikipedia API にフォールバックする。curl 等の単純な HTTP リクエストは
// DuckDuckGo / Bing 双方でボット判定されブロックされることを確認済みのため、
// 実ブラウザ経由を第一手段にしている。

import type { Page } from "playwright";

export interface SearchHit {
  url: string;
  title: string;
  /** 検索結果のスニペット(取得できた場合)。事前フィルタ・並べ替えの参考にする。 */
  snippet?: string;
  /** Bing が表示する引用元表記(ドメイン等)。ページを開く前の権威性判定の参考にする。 */
  cite?: string;
  origin: "search" | "wikipedia" | "primary" | "manual";
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

/** Bing がボット判定した際に表示するチャレンジページの目印文言。 */
const CAPTCHA_MARKERS = ["以下の課題を解決してください", "unusual traffic", "認証が必要です"];

export interface BingSearchResult {
  hits: SearchHit[];
  /** ボット判定(CAPTCHA)によりブロックされたと判断した場合 true。 */
  blocked: boolean;
}

export async function searchBing(
  page: Page,
  query: string,
  limit = 5,
): Promise<BingSearchResult> {
  await page.goto(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja&mkt=ja-JP`,
    { waitUntil: "domcontentloaded", timeout: 15_000 },
  );
  const raw = await page.$$eval("li.b_algo", (items) =>
    items.map((el) => {
      const a = el.querySelector("h2 a") as HTMLAnchorElement | null;
      const snippet = el.querySelector(".b_caption p")?.textContent?.trim() ?? "";
      const cite = el.querySelector("cite")?.textContent?.trim() ?? "";
      return {
        title: a?.textContent?.trim() ?? "",
        href: a?.href ?? "",
        snippet,
        cite,
      };
    }),
  );

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of raw) {
    if (!r.href) continue;
    const url = decodeBingRedirect(r.href);
    if (!url || !url.startsWith("http") || url.includes("bing.com")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({
      url,
      title: r.title || url,
      snippet: r.snippet || undefined,
      cite: r.cite || undefined,
      origin: "search",
    });
    if (hits.length >= limit) break;
  }

  let blocked = false;
  if (hits.length === 0) {
    // 0件のとき、Bing 側の CAPTCHA によるブロックかどうかを判別する。
    // "site:" 演算子などはこの経路に落ちやすいことが実測で分かっている。
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    blocked = CAPTCHA_MARKERS.some((m) => bodyText.includes(m));
  }
  return { hits, blocked };
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
    origin: "wikipedia" as const,
  }));
}

export interface HybridSearchResult {
  hits: SearchHit[];
  usedFallback: boolean;
  /** Bing が CAPTCHA でブロックしたと判断した場合 true。呼び出し側はしばらく Bing を諦めてよい。 */
  blocked: boolean;
}

/**
 * Bing をまず試し、結果が 0 件、またはエラー（ボット判定・タイムアウト等）の場合は
 * Wikipedia API に自動フォールバックする。
 *
 * 各ヒットは取得元に応じて origin が確定した状態で返る(以前は呼び出し側で
 * usedFallback を全ヒットに一律適用していたため、同一バッチ内で Bing 由来のヒットが
 * 誤って "wikipedia" とラベル付けされることがあった)。
 */
export async function hybridSearch(
  page: Page,
  query: string,
  limit = 5,
): Promise<HybridSearchResult> {
  try {
    const { hits, blocked } = await searchBing(page, query, limit);
    if (hits.length > 0) return { hits, usedFallback: false, blocked };
    if (blocked) {
      const wiki = await searchWikipedia(query, limit);
      return { hits: wiki, usedFallback: true, blocked: true };
    }
  } catch {
    // 検索エンジン側のタイムアウト等はフォールバックへ
  }
  const hits = await searchWikipedia(query, limit);
  return { hits, usedFallback: true, blocked: false };
}

/**
 * 開いた HTML ページ(組織の公式ランディングページ等)に掲載されている PDF リンクを収集する。
 * "site:" 演算子は Bing の CAPTCHA を誘発することが実測で分かっているため、その代替として
 * 使う: 検索結果で見つけた組織の公式ページを実際に開き、そこに掲載されている一次資料の
 * PDF リンクを機械的に辿る。
 */
export async function harvestPdfLinks(
  page: Page,
  keywords: string[],
  limit = 3,
): Promise<SearchHit[]> {
  const raw = await page.$$eval('a[href$=".pdf"]', (anchors) =>
    anchors.map((a) => ({
      title: a.textContent?.trim() ?? "",
      href: (a as HTMLAnchorElement).href,
    })),
  );
  const kw = keywords.filter(Boolean).map((k) => k.toLowerCase());
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of raw) {
    if (!r.href.startsWith("http") || seen.has(r.href)) continue;
    // キーワードが1つも無ければ無条件で通す。あれば少なくとも1つはリンク文言に含まれるものだけ。
    if (kw.length > 0 && !kw.some((k) => r.title.toLowerCase().includes(k))) continue;
    seen.add(r.href);
    hits.push({ url: r.href, title: r.title || r.href, origin: "primary" });
    if (hits.length >= limit) break;
  }
  return hits;
}
