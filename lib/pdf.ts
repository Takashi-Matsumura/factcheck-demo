// PDF 本文抽出。日本の公的統計・調査(IPA白書、JUAS調査等)は一次資料そのものが
// PDF であることが多く、これに対応しないと一次ソースに永久に届かない。
// pdf.js をサーバーレス環境向けにバンドルした unpdf を使う
// (ネイティブ依存やワーカー設定が不要で、テキスト抽出だけなら @napi-rs/canvas も要らない)。

import { createRequire } from "node:module";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { assertPublicHttpUrl } from "./url-safety";

// unpdf が内部で使う pdf.js の一部(フォーム/レイアウト計算)は、TC39 提案段階の
// Math.sumPrecise() を呼び出す。この関数は Node.js の V8 バージョンによっては
// 未実装で、その場合 getDocumentProxy() が "Math.sumPrecise is not a function"
// で例外になる(実測で確認済み)。テキスト抽出用途では丸め誤差は問題にならないため、
// 単純な合計でポリフィルしておく。
type MathWithSumPrecise = typeof Math & { sumPrecise?: (values: number[]) => number };
const mathRef = Math as MathWithSumPrecise;
if (typeof mathRef.sumPrecise !== "function") {
  mathRef.sumPrecise = (values: number[]) => values.reduce((a, b) => a + b, 0);
}

/**
 * unpdf は Node.js 環境で cMapUrl / standardFontDataUrl を `pdfjs-dist` パッケージから
 * 自動解決するが、この解決に `import.meta.resolve` を使っており、unpdf の CJS ビルド
 * ではトランスパイル時にこれが壊れて常に失敗する(実測で確認済み: `{}.resolve is not
 * a function` を握り潰し、cMap 抜きで読み込まれる)。cMap が無いと日本語 CID フォントの
 * 文字がほぼ全て復元できず、本文抽出がスカスカになる。ここで自前に解決して明示的に渡す。
 *
 * さらに、Node 版 pdf.js のリソース読み込みは最終的に `fs.readFile(pathString)` に
 * 素通しされる(内部で `${cMapUrl}${filename}` の文字列結合をそのまま渡すだけで、
 * URL としてのパース/変換は一切行わない)。そのため `file://` URL 文字列を渡すと
 * "file:" という名前のディレクトリを探しにいって失敗する(実測で確認済み)。
 * ここでは file:// ではなく素のファイルシステムパスを渡す。
 */
function resolvePdfjsResourcePaths(): { standardFontDataUrl: string; cMapUrl: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    const base = path.dirname(pkgPath);
    return {
      standardFontDataUrl: `${path.join(base, "standard_fonts")}${path.sep}`,
      cMapUrl: `${path.join(base, "cmaps")}${path.sep}`,
    };
  } catch {
    return null;
  }
}

export interface PdfDoc {
  totalPages: number;
  /** ページごとの正規化済みテキスト(0番目が1ページ目)。 */
  pages: string[];
}

const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30MB
// 官公庁の調査報告書は「データ集」等の付録が100ページを超えることがある
// (実測: IPA「DX動向2025(データ集)」は105ページ)。実用に足る余裕を持たせる。
const MAX_PDF_PAGES = 200;
const MAX_REDIRECTS = 5;

export function isPdfUrl(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith(".pdf");
}

/**
 * PDF を安全に取得する。Playwright のブラウザを経由しない素の fetch になるため、
 * guardPageRequests()(lib/url-safety.ts)による多層防御が効かない。
 * assertPublicHttpUrl() は最初の URL しか検証しないので、リダイレクトが
 * 発生するたびにホップ先を検証し直す(redirect: "manual" で手動フォロー)。
 * ここを素の fetch(自動リダイレクト追従)にすると、リダイレクト経由で
 * 内部アドレスに到達できる SSRF の穴が空く。
 */
export async function fetchPdfBytes(rawUrl: string): Promise<Buffer> {
  let current = await assertPublicHttpUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "FactCheckDemo/0.1" },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`PDF取得: リダイレクト先が不明です (status ${res.status})`);
      }
      current = await assertPublicHttpUrl(new URL(location, current.href).href);
      continue;
    }
    if (!res.ok) {
      throw new Error(`PDF取得に失敗しました: status ${res.status}`);
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_PDF_BYTES) {
      throw new Error("PDFのサイズが上限を超えています");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) {
      throw new Error("PDFのサイズが上限を超えています");
    }
    return buf;
  }
  throw new Error("PDF取得: リダイレクトが多すぎます");
}

/**
 * pdf.js は日本語の文字間に不要な空白を挿入したり、行末で欧文単語を
 * ハイフンで分断したりすることがある。これを正規化しないと、逐語引用の
 * `bodyText.includes(quote)` 検証(lib/pipeline.ts)が PDF ではほぼ常に失敗する。
 */
export function normalizePdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    // 日本語文字の間に挟まる余分な空白を除去
    .replace(/([ぁ-んァ-ヶー一-龠々])[ \t]+(?=[ぁ-んァ-ヶー一-龠々])/g, "$1")
    // 行末ハイフンによる欧文単語の分断を結合
    .replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2")
    // 連続空白の圧縮
    .replace(/[ \t]{2,}/g, " ");
}

export async function extractPdfText(buf: Buffer): Promise<PdfDoc> {
  const data = new Uint8Array(buf);
  const resources = resolvePdfjsResourcePaths();
  const doc = await getDocumentProxy(
    data,
    resources
      ? { disableFontFace: true, cMapPacked: true, ...resources }
      : undefined,
  );
  if (doc.numPages > MAX_PDF_PAGES) {
    throw new Error(`PDFのページ数が上限(${MAX_PDF_PAGES}ページ)を超えています`);
  }
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  return { totalPages, pages: text.map(normalizePdfText) };
}
