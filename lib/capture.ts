// 開いた Playwright ページ上で逐語引用の位置を特定し、ハイライトを注入した上で
// クリップスクリーンショット（証拠カード用）とフルページスクリーンショット（参照用）を撮る。
//
// AI検索サービスのファクトチェック機能にある「該当箇所にマーカー付きのスクショ」を
// ローカルで再現する部分。引用箇所が見つからない場合は嘘をつかず found:false を返す。

import type { Page } from "playwright";

export interface CaptureResult {
  /** ページ内で引用箇所を特定できたか */
  found: boolean;
  /** 出力先ディレクトリ内でのファイル名（相対）。撮影自体に失敗した場合は null。 */
  clipFile: string | null;
  fullFile: string | null;
}

const VIEWPORT_PAD_X = 80;
const VIEWPORT_PAD_Y = 140;

export async function captureHighlight(
  page: Page,
  quote: string,
  outDir: string,
  baseName: string,
): Promise<CaptureResult> {
  const rect = await page.evaluate((quoteText: string) => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = node.textContent;
      if (!content) continue;
      const idx = content.indexOf(quoteText);
      if (idx === -1) continue;

      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + quoteText.length);
      const mark = document.createElement("mark");
      mark.setAttribute("data-fc-hit", "true");
      mark.style.background = "#fde68a";
      mark.style.boxShadow = "0 0 0 3px #f59e0b";
      mark.style.borderRadius = "2px";
      try {
        range.surroundContents(mark);
      } catch {
        continue; // 部分的に他要素をまたぐ等で失敗した場合は次候補へ
      }
      mark.scrollIntoView({ block: "center", inline: "nearest" });
      const box = mark.getBoundingClientRect();
      return {
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      };
    }
    return null;
  }, quote);

  if (!rect) {
    return { found: false, clipFile: null, fullFile: null };
  }

  // ハイライト直後は smooth scroll / レイアウトシフトが起きうるため少し待つ
  await page.waitForTimeout(150);

  const viewport = page.viewportSize() ?? { width: 1280, height: 1600 };
  const x = Math.max(0, rect.left - VIEWPORT_PAD_X);
  const y = Math.max(0, rect.top - VIEWPORT_PAD_Y);
  const width = Math.min(viewport.width - x, rect.width + VIEWPORT_PAD_X * 2);
  const height = Math.min(
    viewport.height - y,
    rect.height + VIEWPORT_PAD_Y * 2,
  );

  const clipFile = `${baseName}-clip.png`;
  const fullFile = `${baseName}-full.png`;

  await page.screenshot({
    path: `${outDir}/${clipFile}`,
    clip: { x, y, width: Math.max(width, 10), height: Math.max(height, 10) },
  });
  await page.screenshot({
    path: `${outDir}/${fullFile}`,
    fullPage: true,
  });

  return { found: true, clipFile, fullFile };
}

/** 引用箇所が見つからなかった場合のフォールバック: 現在のビューポートをそのまま撮る。 */
export async function captureFallback(
  page: Page,
  outDir: string,
  baseName: string,
): Promise<CaptureResult> {
  const clipFile = `${baseName}-clip.png`;
  await page.screenshot({ path: `${outDir}/${clipFile}` });
  return { found: false, clipFile, fullFile: null };
}
