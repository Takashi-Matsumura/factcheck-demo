import type { EvidenceItem } from "@/lib/types";
import { StanceBadge } from "./VerdictBadge";
import { ShotLightbox } from "./ShotLightbox";

export function EvidenceCard({ evidence }: { evidence: EvidenceItem }) {
  const {
    source,
    quote,
    textStance,
    textReason,
    vision,
    clipShotPath,
    highlightFound,
    conflicted,
    pdfPage,
    numericMatch,
  } = evidence;
  const isPdf = source.kind === "pdf";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <a
          href={isPdf && pdfPage ? `${source.url}#page=${pdfPage}` : source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600 dark:text-zinc-100 dark:decoration-zinc-600"
        >
          {source.title}
        </a>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <AuthorityBadge authority={source.authority} />
          {isPdf && (
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
              PDF{pdfPage ? ` p.${pdfPage}` : ""}
            </span>
          )}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {originLabel(source.origin)}
          </span>
        </div>
      </div>

      {conflicted && (
        <p className="mt-2 rounded-md bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
          ⚠️ 要確認: テキスト照合と画像検証(二次AI)の判定が食い違っています
        </p>
      )}

      {clipShotPath ? (
        <div className="mt-3">
          <ShotLightbox src={clipShotPath} alt={`${source.title} のスクリーンショット`} />
          {!highlightFound && (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              ※ 引用箇所をページ内で特定できなかったため、ページ全体の表示を撮影しています
            </p>
          )}
        </div>
      ) : (
        isPdf && (
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            ※ PDF文書のため、スクリーンショットは撮影していません(テキスト照合のみで判定しています)
          </p>
        )
      )}

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap items-start gap-2">
          <span className="mt-0.5 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
            テキスト照合
          </span>
          <StanceBadge stance={textStance} />
          <NumericMatchBadge match={numericMatch} />
        </div>
        {quote ? (
          <blockquote className="border-l-2 border-zinc-300 pl-3 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
            &ldquo;{quote}&rdquo;
          </blockquote>
        ) : (
          <p className="text-zinc-500 dark:text-zinc-400">根拠となる引用文は見つかりませんでした</p>
        )}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{textReason}</p>

        {vision && (
          <div className="mt-2 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                二次AI検証(画像)
              </span>
              <StanceBadge stance={vision.stance} />
              <span className="text-xs text-zinc-400">
                信頼度 {Math.round(vision.confidence * 100)}%
              </span>
            </div>
            {vision.visibleText && (
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                画像から読み取れた内容: {vision.visibleText}
              </p>
            )}
            {vision.note && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{vision.note}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const AUTHORITY_STYLE: Record<EvidenceItem["source"]["authority"]["tier"], string> = {
  A: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  B: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  C: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  D: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

function AuthorityBadge({ authority }: { authority: EvidenceItem["source"]["authority"] }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${AUTHORITY_STYLE[authority.tier]}`}
      title={`出典の権威性: ${authority.label}`}
    >
      {authority.label}
    </span>
  );
}

function NumericMatchBadge({ match }: { match: EvidenceItem["numericMatch"] }) {
  if (match === "NONE") return null;
  const style: Record<Exclude<EvidenceItem["numericMatch"], "NONE">, { label: string; className: string }> = {
    EXACT: {
      label: "数値一致",
      className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    },
    CLOSE: {
      label: "数値ほぼ一致",
      className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    },
    MISMATCH: {
      label: "数値不一致",
      className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    },
  };
  const s = style[match];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}

function originLabel(origin: EvidenceItem["source"]["origin"]) {
  switch (origin) {
    case "manual":
      return "指定URL";
    case "wikipedia":
      return "Wikipedia";
    case "search":
      return "検索";
    case "primary":
      return "一次資料";
  }
}
