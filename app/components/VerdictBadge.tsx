import type { Stance, Verdict } from "@/lib/types";

const VERDICT_STYLE: Record<Verdict, { label: string; className: string }> = {
  TRUE: {
    label: "正しい",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  FALSE: {
    label: "誤り",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  PARTIALLY_TRUE: {
    label: "一部正しい",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  UNVERIFIABLE: {
    label: "判断できない",
    className:
      "bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-300",
  },
};

const STANCE_STYLE: Record<Stance, { label: string; className: string }> = {
  SUPPORT: {
    label: "支持",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  CONTRADICT: {
    label: "否定",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  UNRELATED: {
    label: "無関係",
    className:
      "bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-300",
  },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${s.className}`}
    >
      {s.label}
    </span>
  );
}

export function StanceBadge({ stance }: { stance: Stance }) {
  const s = STANCE_STYLE[stance];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}
