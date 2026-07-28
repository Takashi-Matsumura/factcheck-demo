// 開いた Playwright ページから本文らしきテキストを取り出し、文単位に分割する。

import type { Page } from "playwright";

/** ページの可視本文テキストを大まかに抽出する。 */
export async function extractBodyText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const skipTags = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "NAV",
      "FOOTER",
      "HEADER",
      "SVG",
      "IFRAME",
      "FORM",
    ]);
    const root =
      document.querySelector("article") ??
      document.querySelector("main") ??
      document.body;

    const chunks: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.textContent?.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const text = current.textContent?.trim();
      if (text) chunks.push(text);
    }
    return chunks.join("\n");
  });
}

/**
 * 日本語・英語混在テキストを文単位に分割する簡易実装。
 * 句点(。/.!?)や改行で区切り、短すぎる断片は捨てる。
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const rough = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？])/))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/));

  const sentences = rough
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 400);

  // 重複除去（同じ文が複数回出ることがある）
  return Array.from(new Set(sentences));
}
