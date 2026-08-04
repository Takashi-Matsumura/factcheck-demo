// 出典の権威性判定。
// 1) 主張中の組織名から公式ドメインを推定する(検索クエリの組み立てと、一次資料
//    ランディングページの特定に使う)。
// 2) URL のドメインから信頼性 tier (A: 一次資料 〜 D: その他) を推定する
//    (探索順序の並べ替えと総合判定の材料に使う)。

export type AuthorityTier = "A" | "B" | "C" | "D";

export interface Authority {
  tier: AuthorityTier;
  label: string;
}

/** 主張中でよく使われる組織名 → 公式ドメインの対応表。全網羅は狙わず、
 *  国内の代表的な公的機関・業界団体だけを持つ。表にない組織は org を
 *  検索キーワードとして使うだけに留める。 */
const ORG_DOMAINS: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /IPA|情報処理推進機構/i, domain: "ipa.go.jp" },
  { pattern: /JUAS|日本情報システム・ユーザー協会|日本システムユーザー協会/i, domain: "juas.or.jp" },
  { pattern: /総務省/, domain: "soumu.go.jp" },
  { pattern: /経済産業省|経産省/, domain: "meti.go.jp" },
  { pattern: /デジタル庁/, domain: "digital.go.jp" },
  { pattern: /厚生労働省|厚労省/, domain: "mhlw.go.jp" },
  { pattern: /文部科学省|文科省/, domain: "mext.go.jp" },
  { pattern: /内閣府/, domain: "cao.go.jp" },
  { pattern: /金融庁/, domain: "fsa.go.jp" },
  { pattern: /e-Stat|政府統計/i, domain: "e-stat.go.jp" },
  { pattern: /日本銀行|日銀/, domain: "boj.or.jp" },
  { pattern: /経団連|日本経済団体連合会/, domain: "keidanren.or.jp" },
  { pattern: /JEITA|電子情報技術産業協会/i, domain: "jeita.or.jp" },
];

/** サブクレームから抽出した組織名らしき文字列から、公式ドメインを推定する。
 *  見つからなければ undefined を返す。 */
export function resolveOrgDomain(org: string | undefined): string | undefined {
  if (!org) return undefined;
  for (const { pattern, domain } of ORG_DOMAINS) {
    if (pattern.test(org)) return domain;
  }
  return undefined;
}

const TIER_A_SUFFIXES = [".go.jp", ".ac.jp", ".lg.jp"];
const TIER_A_HOSTS = new Set(["e-stat.go.jp"]);
const TIER_B_SUFFIX = ".or.jp";
const TIER_C_HOSTS = new Set([
  "www.nikkei.com",
  "www.asahi.com",
  "www.yomiuri.co.jp",
  "mainichi.jp",
  "www.jiji.com",
  "www.kyodo.co.jp",
  "www3.nhk.or.jp",
  "www.itmedia.co.jp",
  "www.publickey1.jp",
]);

const TIER_LABEL: Record<AuthorityTier, string> = {
  A: "一次資料",
  B: "業界団体・学会",
  C: "報道・専門メディア",
  D: "その他",
};

/**
 * URL のホスト名から出典の権威性 tier を推定する。厳密な格付けではなく、
 * 探索順序の並べ替えと総合判定の重みづけに使うための大まかな目安。
 */
export function classifyAuthority(rawUrl: string): Authority {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { tier: "D", label: TIER_LABEL.D };
  }
  if (host === "ja.wikipedia.org" || host.endsWith(".wikipedia.org")) {
    return { tier: "C", label: "百科事典(二次情報)" };
  }
  if (TIER_C_HOSTS.has(host)) {
    return { tier: "C", label: TIER_LABEL.C };
  }
  if (TIER_A_HOSTS.has(host) || TIER_A_SUFFIXES.some((s) => host.endsWith(s))) {
    return { tier: "A", label: TIER_LABEL.A };
  }
  if (host.endsWith(TIER_B_SUFFIX)) {
    return { tier: "B", label: TIER_LABEL.B };
  }
  return { tier: "D", label: TIER_LABEL.D };
}

const TIER_ORDER: Record<AuthorityTier, number> = { A: 0, B: 1, C: 2, D: 3 };

/** tier の高い(数字の小さい)順に並べるための比較関数。 */
export function compareAuthorityTier(a: string, b: string): number {
  return TIER_ORDER[classifyAuthority(a).tier] - TIER_ORDER[classifyAuthority(b).tier];
}
