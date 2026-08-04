// AI検索サービスにあるファクトチェック機能を模したパイプライン本体。
// 主張の分解 → ソース探索 → 逐語引用の特定 → ハイライト付きスクショ撮影 →
// 二次 AI (vision) による証拠検証 → 総合判定、の一連の流れを
// AsyncGenerator<RunEvent> として発火しながら実行する。

import fs from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { chatJson, chatText, chatVisionRaw, parseJsonLoose } from "./llm";
import { rankBySimilarity } from "./embed";
import { newContext } from "./browser";
import { hybridSearch, harvestPdfLinks, type SearchHit } from "./search";
import { extractBodyText, splitSentences } from "./extract";
import { captureHighlight, captureFallback } from "./capture";
import { ensureRunDir, newRunId } from "./store";
import { assertPublicHttpUrl, guardPageRequests, UnsafeUrlError } from "./url-safety";
import { classifyAuthority, compareAuthorityTier, resolveOrgDomain, type AuthorityTier } from "./authority";
import { compareNumbers, extractNumbers, uniqueRawNumbers, type NumberMatch } from "./numbers";
import { extractPdfText, fetchPdfBytes, isPdfUrl, type PdfDoc } from "./pdf";
import type {
  ClaimKind,
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

// 通常の検索で確保するソース数(サブクレームあたり)。
const MAX_SOURCES_PER_SUBCLAIM = 4;
// 一次資料ランディングページから PDF リンクを収穫できた場合の追加予算。
const HARVEST_BUDGET_PER_SUBCLAIM = 2;
const TOP_SENTENCES_FOR_LLM = 10;
const STANCES = ["SUPPORT", "CONTRADICT", "UNRELATED"] as const;
const VERDICTS = ["TRUE", "FALSE", "PARTIALLY_TRUE", "UNVERIFIABLE"] as const;
const CLAIM_KINDS = ["NUMERIC", "EXISTENCE", "CAUSAL", "OPINION"] as const;

export async function* runFactCheck(
  input: PipelineInput,
): AsyncGenerator<RunEvent> {
  const runId = newRunId();
  const outDir = await ensureRunDir(runId);

  try {
    yield { type: "step", label: "主張を分解しています…" };
    const decomposeWarnings: string[] = [];
    const subClaims = await decomposeClaim(input.claim, decomposeWarnings);
    for (const w of decomposeWarnings) {
      yield { type: "step", label: `⚠ ${w}` };
    }
    yield { type: "subclaims", subClaims };

    const manualHits: SearchHit[] = (input.manualUrls ?? [])
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => ({ url: u, title: u, origin: "manual" as const }));

    const sources: SourcePage[] = [];
    const evidence: EvidenceItem[] = [];
    // 同じURLを複数サブクレーム・複数ラウンドで再取得しないための実行全体キャッシュ。
    // manualUrls は以前、サブクレームの数だけ重複取得されていた。
    const fetchedUrls = new Set<string>();

    const context = await newContext();
    try {
      for (const subClaim of subClaims) {
        if (subClaim.kind === "OPINION") {
          // 意見・提言・考察は事実検証になじまないため、ソース探索そのものを
          // スキップする(検証不能の量産と無駄な探索を避ける)。
          yield {
            type: "step",
            label: `「${subClaim.text}」は意見・考察と判断し、事実検証の対象から除外しました`,
          };
          continue;
        }

        yield {
          type: "step",
          label: `「${subClaim.text}」の根拠を探索しています…`,
        };

        const queries = buildQueries(subClaim);
        const searchHits: SearchHit[] = [];
        let usedFallback = false;
        let blockedByCaptcha = false;
        for (const query of queries.slice(0, 3)) {
          const page = await context.newPage();
          try {
            const result = await hybridSearch(page, query, 6);
            searchHits.push(...result.hits);
            usedFallback = usedFallback || result.usedFallback;
            blockedByCaptcha = blockedByCaptcha || result.blocked;
          } catch (e) {
            console.error(`[search] クエリ失敗: ${query}`, e);
          } finally {
            await page.close();
          }
        }
        if (usedFallback) {
          yield {
            type: "step",
            label: blockedByCaptcha
              ? "検索エンジンがボット判定を返したため Wikipedia で代替検索しました"
              : "検索エンジンが利用できないため Wikipedia で代替検索しました",
          };
        }

        // manualUrls は検索結果とは別枠で必ず含める
        // (以前は同じ配列に混ぜてから slice していたため、2件以上指定すると検索結果が
        //  全て締め出されるバグがあった)。
        const manualForThisClaim = manualHits.filter((h) => !fetchedUrls.has(h.url));
        const searchedUnique = dedupeByUrl(searchHits).filter(
          (h) => !manualHits.some((m) => m.url === h.url),
        );
        // 一次資料(go.jp 等)を優先して開く。取得できるページ数が有限なので、
        // 開く順序を権威性で並べ替えることが実質的に一番効く。
        searchedUnique.sort((a, b) => compareAuthorityTier(a.url, b.url));

        const toVisit: SearchHit[] = [
          ...manualForThisClaim,
          ...searchedUnique.slice(0, MAX_SOURCES_PER_SUBCLAIM),
        ];
        const visitBudget =
          manualForThisClaim.length + MAX_SOURCES_PER_SUBCLAIM + HARVEST_BUDGET_PER_SUBCLAIM;
        const harvestedHosts = new Set<string>();
        let visitedCount = 0;

        for (let i = 0; i < toVisit.length && visitedCount < visitBudget; i++) {
          const hit = toVisit[i];
          if (fetchedUrls.has(hit.url)) continue;

          const sourceId = crypto.randomUUID();
          const origin: SourcePage["origin"] = manualHits.some((m) => m.url === hit.url)
            ? "manual"
            : hit.origin;

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
          fetchedUrls.add(hit.url);
          visitedCount++;

          let fetched: FetchedSource | null = null;
          try {
            fetched = await fetchSource(context, safeUrl);
            const { kind, bodyText, sentences, pdfPageByText, page } = fetched;

            // 一次資料の公式ドメイン上の HTML ページなら、掲載されている PDF リンクを
            // 収穫して追加の探索対象に加える("site:" 演算子の代替。site: は Bing の
            // CAPTCHA を誘発することが実測で分かっている)。
            if (kind === "html" && page) {
              const orgDomain = resolveOrgDomain(subClaim.org);
              if (
                orgDomain &&
                safeUrl.hostname.endsWith(orgDomain) &&
                !harvestedHosts.has(safeUrl.hostname)
              ) {
                harvestedHosts.add(safeUrl.hostname);
                try {
                  const keywords = [subClaim.surveyName, subClaim.year].filter(
                    (s): s is string => Boolean(s),
                  );
                  const links = await harvestPdfLinks(page, keywords, HARVEST_BUDGET_PER_SUBCLAIM);
                  for (const link of links) {
                    if (!toVisit.some((h) => h.url === link.url) && !fetchedUrls.has(link.url)) {
                      toVisit.push(link);
                    }
                  }
                } catch (e) {
                  console.error(`[harvestPdfLinks] ${safeUrl.hostname}`, e);
                }
              }
            }

            if (sentences.length === 0) continue;

            const source: SourcePage = {
              id: sourceId,
              url: safeUrl.href,
              title: hit.title,
              origin,
              kind,
              authority: classifyAuthority(safeUrl.href),
              fetchedAt: new Date().toISOString(),
            };
            sources.push(source);
            yield { type: "source", source };

            // embedTexts は候補文全件を埋め込むため、大きめの topK を要求しても
            // 追加コストは無い(rankBySimilarity 内部で最後に slice するだけ)。
            // 数値ブーストの対象プールを広く取るために活用する。
            const claimNumberTokens = extractNumbers(subClaim.text);
            const rankedPool = await rankBySimilarity(
              subClaim.text,
              sentences,
              claimNumberTokens.length > 0
                ? Math.min(sentences.length, TOP_SENTENCES_FOR_LLM * 3)
                : TOP_SENTENCES_FOR_LLM,
            );
            const ranked = boostByNumberMatch(rankedPool, claimNumberTokens, TOP_SENTENCES_FOR_LLM);
            const candidateText = ranked
              .map((r, i) => `${i + 1}. ${r.text}`)
              .join("\n");

            const pick = await pickQuoteAndStance(subClaim.text, candidateText);
            const cleanedQuote = cleanQuote(pick.quote);
            const quote =
              cleanedQuote && bodyText.includes(cleanedQuote)
                ? cleanedQuote
                : null;
            const pdfPage = quote && pdfPageByText ? (pdfPageByText.get(quote) ?? null) : null;
            const numericMatch: NumberMatch = quote
              ? compareNumbers(claimNumberTokens, extractNumbers(quote))
              : "NONE";

            let clipFile: string | null = null;
            let highlightFound = false;
            let vision: VisionCheck | null = null;

            if (kind === "html" && page) {
              const baseName = sourceId.slice(0, 8);
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

              if (clipFile && quote) {
                try {
                  const buf = await fs.readFile(`${outDir}/${clipFile}`);
                  vision = await verifyWithVision(
                    subClaim.text,
                    quote,
                    buf.toString("base64"),
                  );
                } catch (e) {
                  console.error(`[vision] 画像読み込みに失敗: ${clipFile}`, e);
                  vision = null;
                }
              }
            }
            // PDF は DOM が無くハイライト注入・スクショ撮影ができないため、
            // clipShotPath / vision は null のまま(テキスト照合のみで判定する)。

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
              pdfPage,
              numericMatch,
            };
            evidence.push(evidenceItem);
            yield { type: "evidence", evidence: evidenceItem };
          } catch (e) {
            console.error(`[fetch] ソースを取得できませんでした: ${hit.url}`, e);
          } finally {
            await fetched?.page?.close();
          }
        }
      }
    } finally {
      await context.close();
    }

    yield { type: "step", label: "総合判定をまとめています…" };
    const verdictWarnings: string[] = [];
    const overallCore = await synthesizeVerdict(
      input.claim,
      subClaims,
      evidence,
      verdictWarnings,
    );

    // 意見・提言・因果予測(OPINION/CAUSAL)は事実として検証していないため、
    // 「検証済みの事実からどの程度妥当に導けるか」という別軸で評価する。
    const interpretiveSubClaims = subClaims.filter(
      (sc) => sc.kind === "OPINION" || sc.kind === "CAUSAL",
    );
    let interpretation: OverallVerdict["interpretation"] = null;
    if (interpretiveSubClaims.length > 0) {
      const factualSubClaims = subClaims.filter(
        (sc) => sc.kind === "NUMERIC" || sc.kind === "EXISTENCE",
      );
      interpretation = await assessInterpretation(
        factualSubClaims,
        overallCore.subClaimVerdicts,
        interpretiveSubClaims,
        verdictWarnings,
      );
    }

    const primarySources = sources
      .filter(
        (s): s is SourcePage & { authority: { tier: "A" | "B" } } =>
          s.authority.tier === "A" || s.authority.tier === "B",
      )
      .map((s) => ({ url: s.url, title: s.title, tier: s.authority.tier }));

    const overall: OverallVerdict = { ...overallCore, interpretation, primarySources };

    for (const w of verdictWarnings) {
      yield { type: "step", label: `⚠ ${w}` };
    }
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

// --- ソース取得ヘルパー(HTML / PDF 共通) ---

interface FetchedSource {
  kind: "html" | "pdf";
  bodyText: string;
  sentences: string[];
  /** PDF の場合のみ: 文 → 出現ページ番号(1始まり)。HTML の場合は null。 */
  pdfPageByText: Map<string, number> | null;
  /** HTML の場合のみ: スクショ撮影に使う開いたページ。PDF の場合は null(DOMが無いため)。 */
  page: Page | null;
}

function pdfSentencesWithPage(doc: PdfDoc): Array<{ text: string; page: number }> {
  const out: Array<{ text: string; page: number }> = [];
  doc.pages.forEach((pageText, idx) => {
    for (const s of splitSentences(pageText)) {
      out.push({ text: s, page: idx + 1 });
    }
  });
  return out;
}

async function extractAsPdf(url: string): Promise<FetchedSource> {
  const buf = await fetchPdfBytes(url);
  const doc = await extractPdfText(buf);
  const withPage = pdfSentencesWithPage(doc);
  const pdfPageByText = new Map<string, number>();
  for (const s of withPage) {
    if (!pdfPageByText.has(s.text)) pdfPageByText.set(s.text, s.page);
  }
  return {
    kind: "pdf",
    bodyText: doc.pages.join("\n"),
    sentences: withPage.map((s) => s.text),
    pdfPageByText,
    page: null,
  };
}

/**
 * URL の中身に応じて HTML ページとして開くか PDF として取得するかを切り替え、
 * 本文抽出結果を共通の形で返す。日本の公的統計・調査は一次資料が PDF であることが
 * 多く、これに対応しないと一次ソースに永久に届かない。
 */
async function fetchSource(context: BrowserContext, safeUrl: URL): Promise<FetchedSource> {
  if (isPdfUrl(safeUrl)) {
    return extractAsPdf(safeUrl.href);
  }

  const page = await context.newPage();
  await guardPageRequests(page);
  try {
    await page.goto(safeUrl.href, { waitUntil: "networkidle", timeout: 15_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 拡張子が .pdf でなくても実体が PDF で、ブラウザがダウンロード扱いにしてしまう
    // ケースがある(実測で "Download is starting" という例外文言になることを確認済み)。
    // その場合は PDF 経路にフォールバックする。
    if (msg.includes("Download is starting")) {
      await page.close();
      return extractAsPdf(safeUrl.href);
    }
    await page.close();
    throw e;
  }

  const bodyText = await extractBodyText(page);
  return {
    kind: "html",
    bodyText,
    sentences: splitSentences(bodyText),
    pdfPageByText: null,
    page,
  };
}

// --- LLM 呼び出しヘルパー ---

async function decomposeClaim(claim: string, warnings: string[]): Promise<SubClaim[]> {
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
            kind: { type: "string", enum: CLAIM_KINDS },
            org: { type: "string" },
            surveyName: { type: "string" },
            year: { type: "string" },
            searchQueries: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string" },
            },
          },
          required: ["text", "kind", "org", "surveyName", "year", "searchQueries"],
          additionalProperties: false,
        },
      },
    },
    required: ["subClaims"],
    additionalProperties: false,
  };

  try {
    const result = await chatJson<{
      subClaims: Array<{
        text: string;
        kind: string;
        org: string;
        surveyName: string;
        year: string;
        searchQueries: string[];
      }>;
    }>({
      system:
        "あなたはファクトチェックの準備を行うアシスタントです。与えられた主張を、独立して検証可能な最大3個のサブクレームに分解してください。単純な主張は1個のままで構いません。各サブクレームについて次を行ってください。(1) kind を NUMERIC(具体的な数値を含む)/EXISTENCE(事実・出来事の存在)/CAUSAL(因果関係・将来予測)/OPINION(意見・提言・考察)から1つ選ぶ。(2) 出典として言及されている組織名(org)・調査/報告書名(surveyName)・年度(year)を分かる範囲で抜き出す(不明なら空文字)。(3) Web検索に使える具体的な検索クエリを1〜2個作成する。検索クエリに site: や filetype: のような検索演算子は書かないこと。",
      user: `主張: 「${claim}」`,
      schema,
      schemaName: "decompose",
      maxTokens: 700,
    });
    if (result.subClaims?.length) {
      return result.subClaims.map((sc, i) => ({
        id: `sc-${i}`,
        text: sc.text,
        kind: (CLAIM_KINDS as readonly string[]).includes(sc.kind)
          ? (sc.kind as ClaimKind)
          : "EXISTENCE",
        numbers: uniqueRawNumbers(extractNumbers(sc.text)),
        org: sc.org || undefined,
        surveyName: sc.surveyName || undefined,
        year: sc.year || undefined,
        searchQueries: sc.searchQueries.length ? sc.searchQueries : [claim],
      }));
    }
  } catch (e) {
    console.error("[decomposeClaim] 主張の分解に失敗しました", e);
    warnings.push("主張の分解に失敗したため、そのまま1件として扱います");
  }
  return [
    {
      id: "sc-0",
      text: claim,
      kind: "EXISTENCE",
      numbers: uniqueRawNumbers(extractNumbers(claim)),
      searchQueries: [claim],
    },
  ];
}

/**
 * サブクレームから機械的に検索クエリを組み立てる。LLM に site: / filetype: のような
 * 演算子つきクエリを直接書かせると構文を幻覚しがちなため、演算子の組み立ては
 * ここでコード側に一元化する。"site:" は Bing の CAPTCHA を誘発することが実測で
 * 分かっているため使わない。代わりに filetype:pdf は演算子として機能することが
 * 確認できている。
 */
function buildQueries(subClaim: SubClaim): string[] {
  const { org, surveyName, year } = subClaim;
  const queries: string[] = [];
  if (surveyName) {
    queries.push(normalizeQuery(`${org ?? ""} ${surveyName} ${year ?? ""} filetype:pdf`));
    queries.push(normalizeQuery(`${org ?? ""} ${surveyName} ${year ?? ""}`));
  }
  queries.push(...subClaim.searchQueries);
  return Array.from(new Set(queries.map(normalizeQuery).filter(Boolean)));
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ");
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
  } catch (e) {
    console.error("[pickQuoteAndStance] 引用抽出に失敗しました", e);
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
  let obj: Record<string, unknown>;
  try {
    obj = parseJsonLoose<Record<string, unknown>>(text, "parseVisionJson");
  } catch {
    return {
      stance: "UNRELATED",
      visibleText: "",
      confidence: 0,
      note: "応答を解析できませんでした",
    };
  }
  const stance: Stance = STANCES.includes(obj.stance as Stance)
    ? (obj.stance as Stance)
    : "UNRELATED";
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
}

/**
 * json_schema による構造化出力をまず試し、失敗したら schema 制約なしの自由記述で
 * 再試行して緩くパースする。12B クラスのモデルではスキーマが複雑・出力が長いと
 * GBNF 変換やトークン予算の都合で構造化出力そのものが壊れることがあるため、
 * その場合でも判定を諦めず、最後まで失敗したときだけ fallback 値を返す。
 * 呼び出し側は `failed` を見て、ユーザー向けの警告を出すかどうかを判断する。
 */
async function robustChatJson<T>(opts: {
  label: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
  /** schema 制約なしで再試行する際に、出力形式を明示するための一文 */
  jsonHint: string;
  coerce: (parsed: unknown) => T;
  fallback: T;
}): Promise<{ value: T; failed: boolean }> {
  const { label, system, user, schema, schemaName, maxTokens, jsonHint, coerce, fallback } = opts;
  try {
    const result = await chatJson<unknown>({ system, user, schema, schemaName, maxTokens });
    return { value: coerce(result), failed: false };
  } catch (e) {
    console.error(`[${label}] スキーマ制約付き呼び出しに失敗、フォールバックを試みます`, e);
  }
  try {
    const raw = await chatText({
      system: `${system}\n必ず次のJSON形式のみで出力してください（説明文や前置きは不要）: ${jsonHint}`,
      user,
      maxTokens,
    });
    return { value: coerce(parseJsonLoose<unknown>(raw, label)), failed: false };
  } catch (e) {
    console.error(`[${label}] フォールバック呼び出しにも失敗しました`, e);
    return { value: fallback, failed: true };
  }
}

function coerceSubClaimJudgement(parsed: unknown): {
  verdict: Verdict;
  confidence: number;
  reason: string;
} {
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(o.verdict as Verdict) ? (o.verdict as Verdict) : "UNVERIFIABLE";
  const confidence = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0;
  const reason = typeof o.reason === "string" && o.reason ? o.reason : "判定理由を取得できませんでした";
  return { verdict, confidence, reason };
}

function coerceOverallJudgement(parsed: unknown): {
  verdict: Verdict;
  confidence: number;
  summary: string;
} {
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(o.verdict as Verdict) ? (o.verdict as Verdict) : "UNVERIFIABLE";
  const confidence = typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0;
  const summary =
    typeof o.summary === "string" && o.summary
      ? o.summary
      : "総合判定の生成に失敗しました。個別の根拠をご確認ください。";
  return { verdict, confidence, summary };
}

/** サブクレーム1件ぶんの根拠から判定を行う。総合判定より小さいスキーマにすることで、
 *  12B モデルでも壊れにくくし、1件の失敗が他のサブクレームに波及しないようにする。 */
async function judgeSubClaim(
  subClaim: SubClaim,
  items: EvidenceItem[],
  warnings: string[],
): Promise<{ verdict: Verdict; confidence: number; reason: string }> {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: VERDICTS },
      confidence: { type: "number" },
      reason: { type: "string" },
    },
    required: ["verdict", "confidence", "reason"],
    additionalProperties: false,
  };
  const lines = items.length
    ? items
        .map((e) => {
          const numericNote =
            e.numericMatch === "MISMATCH"
              ? " ※主張と異なる数値です"
              : e.numericMatch === "EXACT"
                ? " ※主張と同じ数値です"
                : "";
          return `- [${e.source.authority.tier}] [${e.textStance}] ${e.quote ?? "(根拠文なし)"} (出典: ${e.source.title})${numericNote}`;
        })
        .join("\n")
    : "- 根拠となる情報が見つかりませんでした";

  const { value, failed } = await robustChatJson<{
    verdict: Verdict;
    confidence: number;
    reason: string;
  }>({
    label: `judgeSubClaim:${subClaim.id}`,
    system:
      "あなたはファクトチェックの判定者です。与えられたサブクレームと根拠一覧をもとに、判定(TRUE/FALSE/PARTIALLY_TRUE/UNVERIFIABLE)を1つ選んでください。根拠が見つからない、または意見・未来予測など事実確認になじまない場合は UNVERIFIABLE としてください。行頭の[A]〜[D]は出典の権威性(A: 一次資料・公的機関、B: 業界団体、C: 報道、D: その他)を表し、Aに近いほど信頼できます。「主張と異なる数値です」という注記がある根拠は、その数値に関しては主張を支持しません。reason は40文字以内で簡潔に。",
    user: `サブクレーム: 「${subClaim.text}」\n\n根拠:\n${lines}`,
    schema,
    schemaName: "subclaim_verdict",
    maxTokens: 300,
    jsonHint:
      '{"verdict":"TRUE または FALSE または PARTIALLY_TRUE または UNVERIFIABLE","confidence":0から1の数値,"reason":"40文字以内の理由"}',
    coerce: coerceSubClaimJudgement,
    fallback: { verdict: "UNVERIFIABLE", confidence: 0, reason: "判定生成に失敗しました" },
  });
  if (failed) warnings.push(`「${subClaim.text}」の判定生成に失敗しました`);
  return { ...value, confidence: adjustConfidenceByAuthority(value.verdict, value.confidence, items) };
}

/**
 * LLM の自己申告 confidence を、実際に判定を支持している根拠の出典 tier で補正する。
 * 一次資料(tier A)の裏付けがあれば少し引き上げ、tier D(その他)しか無ければ
 * 過信を防ぐために頭打ちにする。go.jp の一次資料も個人ブログも同格に扱っていた
 * 従来の問題への対応。
 */
function adjustConfidenceByAuthority(
  verdict: Verdict,
  confidence: number,
  items: EvidenceItem[],
): number {
  const agreeing = items.filter((e) => {
    if (verdict === "TRUE" || verdict === "PARTIALLY_TRUE") return e.textStance === "SUPPORT";
    if (verdict === "FALSE") return e.textStance === "CONTRADICT";
    return false;
  });
  if (agreeing.length === 0) return confidence;

  const tierOrder: AuthorityTier[] = ["A", "B", "C", "D"];
  let bestTier: AuthorityTier = "D";
  for (const e of agreeing) {
    if (tierOrder.indexOf(e.source.authority.tier) < tierOrder.indexOf(bestTier)) {
      bestTier = e.source.authority.tier;
    }
  }
  if (bestTier === "A") return Math.min(1, confidence + 0.15);
  if (bestTier === "D") return Math.min(confidence, 0.6);
  return confidence;
}

/** サブクレームごとの判定結果だけを材料に、主張全体の総合判定をまとめる。
 *  根拠の生テキストを再度渡さないことで、こちらもスキーマ・出力量を小さく保つ。 */
async function summarizeOverall(
  claim: string,
  subClaimVerdicts: SubClaimVerdict[],
  warnings: string[],
): Promise<{ verdict: Verdict; confidence: number; summary: string }> {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: VERDICTS },
      confidence: { type: "number" },
      summary: { type: "string" },
    },
    required: ["verdict", "confidence", "summary"],
    additionalProperties: false,
  };
  const lines = subClaimVerdicts
    .map((v, i) => `${i + 1}. [${v.verdict}] ${v.reason}`)
    .join("\n");

  const { value, failed } = await robustChatJson<{
    verdict: Verdict;
    confidence: number;
    summary: string;
  }>({
    label: "summarizeOverall",
    system:
      "あなたはファクトチェックの総合判定を行うアシスタントです。各サブクレームの判定結果をもとに、主張全体の総合判定(TRUE/FALSE/PARTIALLY_TRUE/UNVERIFIABLE)を1つにまとめてください。summary は80文字以内で簡潔に。",
    user: `主張: 「${claim}」\n\nサブクレームの判定:\n${lines}`,
    schema,
    schemaName: "overall_verdict",
    maxTokens: 400,
    jsonHint:
      '{"verdict":"TRUE または FALSE または PARTIALLY_TRUE または UNVERIFIABLE","confidence":0から1の数値,"summary":"80文字以内の要約"}',
    coerce: coerceOverallJudgement,
    fallback: {
      verdict: "UNVERIFIABLE",
      confidence: 0,
      summary: "総合判定の生成に失敗しました。個別の根拠をご確認ください。",
    },
  });
  if (failed) warnings.push("総合判定の生成に失敗しました");
  return value;
}

async function synthesizeVerdict(
  claim: string,
  subClaims: SubClaim[],
  evidence: EvidenceItem[],
  warnings: string[],
): Promise<Omit<OverallVerdict, "interpretation" | "primarySources">> {
  const subClaimVerdicts: SubClaimVerdict[] = [];
  for (const sc of subClaims) {
    // OPINION は事実検証の対象外(ソース探索自体を行っていない)。総合判定の
    // 事実ロールアップから外し、後段の interpretation 評価に回す。
    if (sc.kind === "OPINION") continue;
    const items = evidence.filter((e) => e.subClaimId === sc.id);
    const judged = await judgeSubClaim(sc, items, warnings);
    subClaimVerdicts.push({
      subClaimId: sc.id,
      verdict: judged.verdict,
      confidence: judged.confidence,
      reason: judged.reason,
      contradictingSourceIds: items
        .filter((e) => e.textStance === "CONTRADICT")
        .map((e) => e.source.id),
    });
  }

  const overall = await summarizeOverall(claim, subClaimVerdicts, warnings);
  return {
    verdict: overall.verdict,
    confidence: overall.confidence,
    summary: overall.summary,
    subClaimVerdicts,
  };
}

const INTERPRETATION_ASSESSMENTS = ["COHERENT", "PARTIALLY_COHERENT", "UNSUPPORTED"] as const;

function coerceInterpretation(parsed: unknown): {
  assessment: "COHERENT" | "PARTIALLY_COHERENT" | "UNSUPPORTED";
  note: string;
} {
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const assessment = (INTERPRETATION_ASSESSMENTS as readonly string[]).includes(
    o.assessment as string,
  )
    ? (o.assessment as "COHERENT" | "PARTIALLY_COHERENT" | "UNSUPPORTED")
    : "UNSUPPORTED";
  const note = typeof o.note === "string" && o.note ? o.note : "評価を取得できませんでした";
  return { assessment, note };
}

/**
 * OPINION/CAUSAL に分類されたサブクレーム(意見・提言・因果予測)が、検証済みの
 * 事実からどの程度妥当に導けるかを評価する。事実の真偽自体はここでは再判定しない
 * (それは judgeSubClaim の役割)。Gemini の回答例が「これはファクトではなく
 * データから導いた考察」と切り分けていたのに倣った、総合判定とは独立の軸。
 */
async function assessInterpretation(
  factualSubClaims: SubClaim[],
  factualVerdicts: SubClaimVerdict[],
  interpretiveSubClaims: SubClaim[],
  warnings: string[],
): Promise<{ assessment: "COHERENT" | "PARTIALLY_COHERENT" | "UNSUPPORTED"; note: string }> {
  const factLines = factualSubClaims.length
    ? factualSubClaims
        .map((sc) => {
          const v = factualVerdicts.find((fv) => fv.subClaimId === sc.id);
          return `- [${v?.verdict ?? "UNVERIFIABLE"}] ${sc.text}`;
        })
        .join("\n")
    : "- (事実として検証されたサブクレームはありません)";
  const opinionLines = interpretiveSubClaims.map((sc) => `- ${sc.text}`).join("\n");

  const schema = {
    type: "object",
    properties: {
      assessment: { type: "string", enum: INTERPRETATION_ASSESSMENTS },
      note: { type: "string" },
    },
    required: ["assessment", "note"],
    additionalProperties: false,
  };

  const { value, failed } = await robustChatJson<{
    assessment: "COHERENT" | "PARTIALLY_COHERENT" | "UNSUPPORTED";
    note: string;
  }>({
    label: "assessInterpretation",
    system:
      "あなたはファクトチェックにおける論理整合性の評価者です。以下は検証済みの事実です。事実の真偽は再判定しないでください。次の考察・提言・予測が、これらの事実からどの程度妥当に導けるかだけを評価してください。assessment は COHERENT(事実から妥当に導ける)/PARTIALLY_COHERENT(一部は妥当だが飛躍がある)/UNSUPPORTED(事実からは支持されない、または前提事実が確認できない)のいずれか。note は80文字以内で簡潔に。",
    user: `検証済みの事実:\n${factLines}\n\n考察・提言:\n${opinionLines}`,
    schema,
    schemaName: "interpretation",
    maxTokens: 400,
    jsonHint:
      '{"assessment":"COHERENT または PARTIALLY_COHERENT または UNSUPPORTED","note":"80文字以内のコメント"}',
    coerce: coerceInterpretation,
    fallback: { assessment: "UNSUPPORTED", note: "解釈の評価に失敗しました" },
  });
  if (failed) warnings.push("解釈・提言の評価に失敗しました");
  return value;
}

/**
 * 意味的類似度(cosine)だけでは「33.8%」と「38.3%」のような数値の取り違えを
 * 区別できない。候補文に含まれる数値が主張の数値と一致/近似する場合にスコアを
 * 押し上げ、topK 件に混ざりやすくする。claimNumberTokens が空の場合は cosine の
 * 順序をそのまま保つ(全候補の boost が一律 0 になるため)。
 */
function boostByNumberMatch<T extends { text: string; score: number }>(
  ranked: T[],
  claimNumberTokens: ReturnType<typeof extractNumbers>,
  topK: number,
): T[] {
  const BOOST_WEIGHT = 0.3;
  const MATCH_BOOST: Record<NumberMatch, number> = {
    EXACT: 1,
    CLOSE: 0.5,
    MISMATCH: 0,
    NONE: 0,
  };
  return ranked
    .map((r) => {
      const match = compareNumbers(claimNumberTokens, extractNumbers(r.text));
      const boosted = r.score * (1 - BOOST_WEIGHT) + MATCH_BOOST[match] * BOOST_WEIGHT;
      return { item: r, boosted };
    })
    .sort((a, b) => b.boosted - a.boosted)
    .slice(0, topK)
    .map((x) => x.item);
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
