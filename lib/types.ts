// ファクトチェック・パイプライン全体で共有する型定義

export type Stance = "SUPPORT" | "CONTRADICT" | "UNRELATED";

export type Verdict = "TRUE" | "FALSE" | "PARTIALLY_TRUE" | "UNVERIFIABLE";

/**
 * 主張の種類。検証方法・判定基準を変えるために使う。
 * NUMERIC: 具体的な数値を含む主張(数値照合が有効)
 * EXISTENCE: ある事実・出来事の存在を主張するもの(従来通り逐語引用+スタンスで検証)
 * CAUSAL: 因果関係・将来予測を含む主張(前提事実の有無だけを確認)
 * OPINION: 意見・提言・考察(事実検証の対象外。解釈の評価に回す)
 */
export type ClaimKind = "NUMERIC" | "EXISTENCE" | "CAUSAL" | "OPINION";

export interface SubClaim {
  id: string;
  text: string;
  kind: ClaimKind;
  /** サブクレーム文から機械的に抽出した数値表現(例: "33.8%", "2025年")。数値照合に使う。 */
  numbers: string[];
  /** 出典として言及されている組織名(推定)。site: 相当のクエリ組み立てや一次資料の特定に使う。 */
  org?: string;
  /** 出典として言及されている調査・報告書名(推定)。 */
  surveyName?: string;
  /** 出典の年度(推定)。 */
  year?: string;
  searchQueries: string[];
}

export interface SourcePage {
  id: string;
  url: string;
  title: string;
  origin: "search" | "wikipedia" | "manual" | "primary";
  /** html: 通常のWebページ / pdf: PDF文書(本文抽出のみ。スクショ・vision検証は行わない) */
  kind: "html" | "pdf";
  /** ドメインから推定した出典の権威性(A: 一次資料 〜 D: その他)。lib/authority.ts で判定。 */
  authority: { tier: "A" | "B" | "C" | "D"; label: string };
  fetchedAt: string;
}

export interface EvidenceItem {
  id: string;
  subClaimId: string;
  source: SourcePage;
  /** 元テキストへの部分一致検証を通過した逐語引用。通らなければ null。 */
  quote: string | null;
  /** テキスト照合による判定（quote が null なら UNRELATED 扱い） */
  textStance: Stance;
  textReason: string;
  /** ハイライト付きスクリーンショットのクリップ画像。撮影/特定に失敗した場合 null。 */
  clipShotPath: string | null;
  /** 引用箇所をページ内で特定できたか */
  highlightFound: boolean;
  /** 二次 AI (vision) による検証結果。撮影できなかった場合は null。 */
  vision: VisionCheck | null;
  /** テキスト判定と vision 判定が食い違う場合に立つフラグ */
  conflicted: boolean;
  /** PDF ソースの場合、quote が見つかったページ番号(1始まり)。PDF以外は null。 */
  pdfPage: number | null;
  /**
   * 主張中の数値表現(例: "33.8%")と quote 中の数値を比較した結果。
   * 意味的類似度だけでは近い値の取り違え(33.8% vs 38.3% 等)を検出できないため、
   * 文字列としての数値照合で補強する。quote が無い場合は "NONE"。
   */
  numericMatch: "EXACT" | "CLOSE" | "MISMATCH" | "NONE";
}

export interface VisionCheck {
  stance: Stance;
  visibleText: string;
  confidence: number;
  note: string;
}

export interface SubClaimVerdict {
  subClaimId: string;
  verdict: Verdict;
  confidence: number;
  reason: string;
  contradictingSourceIds: string[];
}

export interface OverallVerdict {
  verdict: Verdict;
  confidence: number;
  summary: string;
  subClaimVerdicts: SubClaimVerdict[];
  /**
   * OPINION/CAUSAL に分類されたサブクレーム(意見・提言・因果予測)が、
   * 検証済みの事実からどの程度妥当に導けるかの評価。事実の真偽とは別軸。
   * 該当するサブクレームが無ければ null。
   */
  interpretation: {
    assessment: "COHERENT" | "PARTIALLY_COHERENT" | "UNSUPPORTED";
    note: string;
  } | null;
  /** 検証に使えた一次資料・業界団体資料(tier A/B)の一覧。 */
  primarySources: Array<{ url: string; title: string; tier: "A" | "B" }>;
}

export interface FactCheckReport {
  runId: string;
  claim: string;
  subClaims: SubClaim[];
  sources: SourcePage[];
  evidence: EvidenceItem[];
  overall: OverallVerdict | null;
}

// --- SSE イベント ---

export type RunEvent =
  | { type: "step"; label: string }
  | { type: "subclaims"; subClaims: SubClaim[] }
  | { type: "source"; source: SourcePage }
  | { type: "evidence"; evidence: EvidenceItem }
  | { type: "verdict"; overall: OverallVerdict }
  | { type: "done"; report: FactCheckReport }
  | { type: "error"; message: string };
