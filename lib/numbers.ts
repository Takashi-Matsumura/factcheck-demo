// 主張・候補文に含まれる数値表現の抽出・正規化・比較。
// 埋め込みによる意味的類似度だけでは「33.8%」と「38.3%」のような取り違えを
// 区別できないため、数値の一致/不一致を機械的に検証する材料として使う。

export type NumberUnit = "percent" | "year" | "count" | "other";

export interface NumberToken {
  /** 元のテキストでの表記 (例: "33.8%", "約4割", "2025年") */
  raw: string;
  /** percent は 0-100 スケールに正規化した値。比較に使う。 */
  value: number;
  unit: NumberUnit;
}

const PATTERNS: Array<{
  re: RegExp;
  toToken: (m: RegExpExecArray) => NumberToken;
}> = [
  {
    // 33.8% / 33.8％ / 33.8 パーセント
    re: /(\d+(?:\.\d+)?)\s*(?:[%％]|パーセント)/g,
    toToken: (m) => ({ raw: m[0], value: parseFloat(m[1]), unit: "percent" }),
  },
  {
    // 4割 / 4割強 / 4割弱 / 約4割 (1割 = 10%)
    re: /(\d+(?:\.\d+)?)\s*割(?:強|弱)?/g,
    toToken: (m) => ({ raw: m[0], value: parseFloat(m[1]) * 10, unit: "percent" }),
  },
  {
    // 2025年 / 2025年度
    re: /((?:19|20)\d{2})\s*年度?/g,
    toToken: (m) => ({ raw: m[0], value: parseFloat(m[1]), unit: "year" }),
  },
  {
    // 1,234件 / 1234人 / 500社 / 12回答
    re: /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:件|人|社|団体|回答)/g,
    toToken: (m) => ({
      raw: m[0],
      value: parseFloat(m[1].replace(/,/g, "")),
      unit: "count",
    }),
  },
];

/**
 * テキストから数値表現を抽出する。パーセント・割合系は 0-100 スケールに正規化するため、
 * 「33.8%」と「4割弱」のような表記違いをまたいだ比較もできる。
 */
export function extractNumbers(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const { re, toToken } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      tokens.push(toToken(m));
    }
  }
  return tokens;
}

/** 数値表現一覧から、UI表示・LLMへの参考情報用に重複を除いた raw 表記だけを取り出す。 */
export function uniqueRawNumbers(tokens: NumberToken[]): string[] {
  return Array.from(new Set(tokens.map((t) => t.raw)));
}

// パーセント同士は多少の丸め誤差を許容する。年・件数は完全一致のみ「一致」とみなす。
const TOLERANCE: Record<NumberUnit, number> = {
  percent: 0.5,
  year: 0,
  count: 0,
  other: 0,
};

export type NumberMatch = "EXACT" | "CLOSE" | "MISMATCH" | "NONE";

// EXACT より緩く、丸め・年度のずれなど「近いが同一ではない」とみなす許容幅。
const CLOSE_TOLERANCE: Record<NumberUnit, number> = {
  percent: 3, // ポイント差
  year: 1, // 年度境界のずれ
  count: 0, // 完全一致以外は MISMATCH 扱い(単位が粗いため CLOSE を設けない)
  other: 0,
};

/**
 * 主張側の数値集合(claimNumbers)と候補文側の数値集合(textNumbers)を比較する。
 * - claimNumbers が空なら NONE (この文には照合すべき数値主張がない)
 * - 同じ単位でほぼ同じ値が1つでもあれば EXACT
 * - 同じ単位で近い値なら CLOSE (丸め・年度のずれ程度)
 * - 同じ単位の数値はあるが値が離れているなら MISMATCH (要注意 — 似た文脈で違う数値)
 * - 同じ単位の数値が textNumbers 側に無ければ NONE
 */
export function compareNumbers(
  claimNumbers: NumberToken[],
  textNumbers: NumberToken[],
): NumberMatch {
  if (claimNumbers.length === 0) return "NONE";

  let sawSameUnit = false;
  let bestIsClose = false;
  for (const c of claimNumbers) {
    for (const t of textNumbers) {
      if (c.unit !== t.unit) continue;
      sawSameUnit = true;
      const diff = Math.abs(c.value - t.value);
      if (diff <= (TOLERANCE[c.unit] ?? 0)) return "EXACT";
      if (diff <= (CLOSE_TOLERANCE[c.unit] ?? 0)) bestIsClose = true;
    }
  }
  if (bestIsClose) return "CLOSE";
  return sawSameUnit ? "MISMATCH" : "NONE";
}
