// AI検索サービスにあるファクトチェック機能を模したパイプライン本体。
// 主張の分解 → ソース探索 → 逐語引用の特定 → ハイライト付きスクショ撮影 →
// 二次 AI (vision) による証拠検証 → 総合判定、の一連の流れを
// AsyncGenerator<RunEvent> として発火しながら実行する。

import fs from "node:fs/promises";
import { chatJson, chatVisionRaw } from "./llm";
import { rankBySimilarity } from "./embed";
import { newContext } from "./browser";
import { hybridSearch, type SearchHit } from "./search";
import { extractBodyText, splitSentences } from "./extract";
import { captureHighlight, captureFallback } from "./capture";
import { ensureRunDir, newRunId } from "./store";
import { assertPublicHttpUrl, guardPageRequests, UnsafeUrlError } from "./url-safety";
import type {
  EvidenceItem,
  FactCheckReport,
  OverallVerdict,
  RunEvent,
  SourcePage,
  Stance,
  SubClaim,
  SubClaimVerdict,
  Verdict,
  VisionCheck,
} from "./types";

export interface PipelineInput {
  claim: string;
  manualUrls?: string[];
}

const MAX_SOURCES_PER_SUBCLAIM = 2;
const TOP_SENTENCES_FOR_LLM = 6;
const STANCES = ["SUPPORT", "CONTRADICT", "UNRELATED"] as const;
const VERDICTS = ["TRUE", "FALSE", "PARTIALLY_TRUE", "UNVERIFIABLE"] as const;

export async function* runFactCheck(
  input: PipelineInput,
): AsyncGenerator<RunEvent> {
  const runId = newRunId();
  const outDir = await ensureRunDir(runId);

  try {
    yield { type: "step", label: "主張を分解しています…" };
    const subClaims = await decomposeClaim(input.claim);
    yield { type: "subclaims", subClaims };

    const manualHits: SearchHit[] = (input.manualUrls ?? [])
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => ({ url: u, title: u }));

    const sources: SourcePage[] = [];
    const evidence: EvidenceItem[] = [];

    const context = await newContext();
    try {
      for (const subClaim of subClaims) {
        yield {
          type: "step",
          label: `「${subClaim.text}」の根拠を探索しています…`,
        };

        const hits: SearchHit[] = [...manualHits];
        let usedFallback = false;
        for (const query of subClaim.searchQueries.slice(0, 2)) {
          const page = await context.newPage();
          try {
            const result = await hybridSearch(page, query, 4);
            hits.push(...result.hits);
            usedFallback = usedFallback || result.usedFallback;
          } catch {
            // 個別クエリの失敗は無視して次のクエリ・ソースへ進む
          } finally {
            await page.close();
          }
        }
        if (usedFallback) {
          yield {
            type: "step",
            label: "検索エンジンが利用できないため Wikipedia で代替検索しました",
          };
        }

        const uniqueHits = dedupeByUrl(hits).slice(
          0,
          MAX_SOURCES_PER_SUBCLAIM,
        );

        for (const hit of uniqueHits) {
          const sourceId = crypto.randomUUID();
          const origin: SourcePage["origin"] = manualHits.some(
            (m) => m.url === hit.url,
          )
            ? "manual"
            : usedFallback
              ? "wikipedia"
              : "search";

          let safeUrl: URL;
          try {
            safeUrl = await assertPublicHttpUrl(hit.url);
          } catch (e) {
            const reason =
              e instanceof UnsafeUrlError ? e.message : "アクセスできないURLです";
            yield {
              type: "step",
              label: `${hit.title} はスキップしました（${reason}）`,
            };
            continue;
          }

          yield { type: "step", label: `${hit.title} を確認しています…` };

          const page = await context.newPage();
          try {
            // 初回URLだけでなく、リダイレクト先・サブリソースも含めて
            // 全リクエストを検証する(SSRF対策の多層防御)。
            await guardPageRequests(page);
            await page.goto(safeUrl.href, {
              waitUntil: "networkidle",
              timeout: 15_000,
            });
            const bodyText = await extractBodyText(page);
            const sentences = splitSentences(bodyText);
            if (sentences.length === 0) continue;

            const source: SourcePage = {
              id: sourceId,
              url: safeUrl.href,
              title: hit.title,
              origin,
              fetchedAt: new Date().toISOString(),
            };
            sources.push(source);
            yield { type: "source", source };

            const ranked = await rankBySimilarity(
              subClaim.text,
              sentences,
              TOP_SENTENCES_FOR_LLM,
            );
            const candidateText = ranked
              .map((r, i) => `${i + 1}. ${r.text}`)
              .join("\n");

            const pick = await pickQuoteAndStance(subClaim.text, candidateText);
            const cleanedQuote = cleanQuote(pick.quote);
            const quote =
              cleanedQuote && bodyText.includes(cleanedQuote)
                ? cleanedQuote
                : null;

            const baseName = sourceId.slice(0, 8);
            let clipFile: string | null = null;
            let highlightFound = false;

            if (quote) {
              const cap = await captureHighlight(page, quote, outDir, baseName);
              highlightFound = cap.found;
              clipFile = cap.clipFile;
              if (!cap.found) {
                const fb = await captureFallback(page, outDir, baseName);
                clipFile = fb.clipFile;
              }
            } else {
              const fb = await captureFallback(page, outDir, baseName);
              clipFile = fb.clipFile;
            }

            let vision: VisionCheck | null = null;
            if (clipFile && quote) {
              try {
                const buf = await fs.readFile(`${outDir}/${clipFile}`);
                vision = await verifyWithVision(
                  subClaim.text,
                  quote,
                  buf.toString("base64"),
                );
              } catch {
                vision = null;
              }
            }

            const textStance: Stance = quote ? pick.stance : "UNRELATED";
            const conflicted = Boolean(
              vision &&
                textStance !== "UNRELATED" &&
                vision.stance !== "UNRELATED" &&
                vision.stance !== textStance,
            );

            const evidenceItem: EvidenceItem = {
              id: crypto.randomUUID(),
              subClaimId: subClaim.id,
              source,
              quote,
              textStance,
              textReason: pick.reason,
              clipShotPath: clipFile ? `/api/shots/${runId}/${clipFile}` : null,
              highlightFound,
              vision,
              conflicted,
            };
            evidence.push(evidenceItem);
            yield { type: "evidence", evidence: evidenceItem };
          } catch {
            // このソースは取得できなかった。次のソースへ進む。
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await context.close();
    }

    yield { type: "step", label: "総合判定をまとめています…" };
    const overall = await synthesizeVerdict(input.claim, subClaims, evidence);
    yield { type: "verdict", overall };

    const report: FactCheckReport = {
      runId,
      claim: input.claim,
      subClaims,
      sources,
      evidence,
      overall,
    };
    yield { type: "done", report };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

// --- LLM 呼び出しヘルパー ---

async function decomposeClaim(claim: string): Promise<SubClaim[]> {
  const schema = {
    type: "object",
    properties: {
      subClaims: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            searchQueries: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string" },
            },
          },
          required: ["text", "searchQueries"],
          additionalProperties: false,
        },
      },
    },
    required: ["subClaims"],
    additionalProperties: false,
  };

  try {
    const result = await chatJson<{
      subClaims: Array<{ text: string; searchQueries: string[] }>;
    }>({
      system:
        "あなたはファクトチェックの準備を行うアシスタントです。与えられた主張を、独立して検証可能な最大3個のサブクレームに分解してください。単純な主張は1個のままで構いません。各サブクレームについて、Web検索に使える具体的な検索クエリを1〜2個作成してください。",
      user: `主張: 「${claim}」`,
      schema,
      schemaName: "decompose",
      maxTokens: 500,
    });
    if (result.subClaims?.length) {
      return result.subClaims.map((sc, i) => ({
        id: `sc-${i}`,
        text: sc.text,
        searchQueries: sc.searchQueries.length ? sc.searchQueries : [claim],
      }));
    }
  } catch {
    // フォールバックへ
  }
  return [{ id: "sc-0", text: claim, searchQueries: [claim] }];
}

interface QuotePick {
  quote: string;
  stance: Stance;
  reason: string;
}

async function pickQuoteAndStance(
  subClaimText: string,
  candidateText: string,
): Promise<QuotePick> {
  const schema = {
    type: "object",
    properties: {
      quote: { type: "string" },
      stance: { type: "string", enum: STANCES },
      reason: { type: "string" },
    },
    required: ["quote", "stance", "reason"],
    additionalProperties: false,
  };
  try {
    const result = await chatJson<QuotePick>({
      system:
        "あなたはファクトチェックの根拠抽出を行うアシスタントです。候補文の中から、主張を最もよく支持または否定する文を1つだけ選び、quote へコピーしてください。文の本体は一字一句変えないこと（要約・言い換え・改行の追加は禁止）。ただし候補リストの先頭にある「1. 」等の番号・箇条書き記号は quote に含めないこと。関連する候補がなければ quote は空文字とし、stance は UNRELATED としてください。reason は40文字以内で簡潔に。",
      user: `主張: 「${subClaimText}」\n\n候補文:\n${candidateText}`,
      schema,
      schemaName: "quote_pick",
      maxTokens: 300,
    });
    return result;
  } catch {
    return { quote: "", stance: "UNRELATED", reason: "抽出に失敗しました" };
  }
}

function cleanQuote(raw: string): string {
  return raw
    .trim()
    // 候補リストの番号 ("1. " 等) をモデルが誤ってコピーすることがあるため除去
    .replace(/^\d+[.．)、]\s*/, "")
    .replace(/^[「『"'\s]+/, "")
    .replace(/[」』"'\s]+$/, "")
    .trim();
}

async function verifyWithVision(
  subClaimText: string,
  quote: string,
  imageBase64: string,
): Promise<VisionCheck> {
  // ここが「二次AIによるスクリーンショット検証」に相当する部分。
  // テキスト照合(pickQuoteAndStance)とは独立に、画像だけを見て主張との関係を
  // 判定させる。quote はハイライト箇所を示す手がかりとして渡すだけで、
  // 判定基準はあくまで主張そのものに置く（quote との一致だけを見ると、
  // ハイライトが機能した時点で常に SUPPORT になってしまい検証の意味がなくなるため）。
  const prompt = `この画像は、ある主張を検証するために撮影したWebページのスクリーンショットです。黄色くハイライトされた箇所が、根拠の候補としてテキスト解析で見つかった部分です（参考: 「${quote}」）。

検証したい主張: 「${subClaimText}」

画像に写っている内容（ハイライト部分とその前後の文脈）を実際に読み取り、テキスト解析の結果には頼らず、あなた自身の読み取りに基づいて、その内容がこの主張を支持するか・否定するか・無関係かを判定してください。必ず次のJSON形式のみで出力してください（説明文や前置きは不要）:
{"stance":"SUPPORT または CONTRADICT または UNRELATED","visibleText":"実際に画像から読み取れた、判定の根拠となる文字列","confidence":0から1の数値,"note":"一言コメント（40文字以内）"}`;

  try {
    const raw = await chatVisionRaw({ prompt, imageDataUrl: imageBase64 });
    return parseVisionJson(raw);
  } catch {
    return {
      stance: "UNRELATED",
      visibleText: "",
      confidence: 0,
      note: "vision モデルの呼び出しに失敗しました",
    };
  }
}

function parseVisionJson(text: string): VisionCheck {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      stance: "UNRELATED",
      visibleText: "",
      confidence: 0,
      note: "応答を解析できませんでした",
    };
  }
  try {
    const obj = JSON.parse(match[0]);
    const stance: Stance = STANCES.includes(obj.stance) ? obj.stance : "UNRELATED";
    return {
      stance,
      visibleText:
        typeof obj.visibleText === "string" ? obj.visibleText.slice(0, 300) : "",
      confidence:
        typeof obj.confidence === "number"
          ? Math.max(0, Math.min(1, obj.confidence))
          : 0.5,
      note: typeof obj.note === "string" ? obj.note.slice(0, 200) : "",
    };
  } catch {
    return {
      stance: "UNRELATED",
      visibleText: "",
      confidence: 0,
      note: "応答を解析できませんでした",
    };
  }
}

async function synthesizeVerdict(
  claim: string,
  subClaims: SubClaim[],
  evidence: EvidenceItem[],
): Promise<OverallVerdict> {
  const idEnum = subClaims.map((sc) => sc.id);
  const schema = {
    type: "object",
    properties: {
      subClaimVerdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subClaimId: { type: "string", enum: idEnum },
            verdict: { type: "string", enum: VERDICTS },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
          required: ["subClaimId", "verdict", "confidence", "reason"],
          additionalProperties: false,
        },
      },
      verdict: { type: "string", enum: VERDICTS },
      confidence: { type: "number" },
      summary: { type: "string" },
    },
    required: ["subClaimVerdicts", "verdict", "confidence", "summary"],
    additionalProperties: false,
  };

  const evidenceSummary = subClaims
    .map((sc) => {
      const items = evidence.filter((e) => e.subClaimId === sc.id);
      const lines = items.length
        ? items
            .map(
              (e) =>
                `  - [${e.textStance}] ${e.quote ?? "(根拠文なし)"} (出典: ${e.source.title})`,
            )
            .join("\n")
        : "  - 根拠となる情報が見つかりませんでした";
      return `${sc.id}: ${sc.text}\n${lines}`;
    })
    .join("\n\n");

  try {
    const result = await chatJson<{
      subClaimVerdicts: Array<{
        subClaimId: string;
        verdict: Verdict;
        confidence: number;
        reason: string;
      }>;
      verdict: Verdict;
      confidence: number;
      summary: string;
    }>({
      system:
        "あなたはファクトチェックの最終判定を行うアシスタントです。各サブクレームの根拠一覧をもとに、サブクレームごとの判定(TRUE/FALSE/PARTIALLY_TRUE/UNVERIFIABLE)と、主張全体の総合判定を行ってください。根拠が見つからない、または意見・未来予測など事実確認になじまない場合は UNVERIFIABLE としてください。summary は80文字以内で簡潔に。",
      user: `主張: 「${claim}」\n\n${evidenceSummary}`,
      schema,
      schemaName: "verdict",
      maxTokens: 600,
    });

    const subClaimVerdicts: SubClaimVerdict[] = result.subClaimVerdicts.map(
      (v) => ({
        subClaimId: v.subClaimId,
        verdict: v.verdict,
        confidence: Math.max(0, Math.min(1, v.confidence)),
        reason: v.reason,
        contradictingSourceIds: evidence
          .filter((e) => e.subClaimId === v.subClaimId && e.textStance === "CONTRADICT")
          .map((e) => e.source.id),
      }),
    );

    return {
      verdict: result.verdict,
      confidence: Math.max(0, Math.min(1, result.confidence)),
      summary: result.summary,
      subClaimVerdicts,
    };
  } catch {
    return {
      verdict: "UNVERIFIABLE",
      confidence: 0,
      summary: "総合判定の生成に失敗しました。個別の根拠をご確認ください。",
      subClaimVerdicts: subClaims.map((sc) => ({
        subClaimId: sc.id,
        verdict: "UNVERIFIABLE",
        confidence: 0,
        reason: "判定生成に失敗しました",
        contradictingSourceIds: [],
      })),
    };
  }
}

function dedupeByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
  }
  return out;
}
