// ファクトチェック・パイプライン全体で共有する型定義

export type Stance = "SUPPORT" | "CONTRADICT" | "UNRELATED";

export type Verdict = "TRUE" | "FALSE" | "PARTIALLY_TRUE" | "UNVERIFIABLE";

export interface SubClaim {
  id: string;
  text: string;
  searchQueries: string[];
}

export interface SourcePage {
  id: string;
  url: string;
  title: string;
  origin: "search" | "wikipedia" | "manual";
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
