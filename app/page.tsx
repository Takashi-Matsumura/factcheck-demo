"use client";

import { useRef, useState } from "react";
import type { EvidenceItem, OverallVerdict, RunEvent, SubClaim } from "@/lib/types";
import { ClaimForm } from "./components/ClaimForm";
import { RunTimeline } from "./components/RunTimeline";
import { EvidenceCard } from "./components/EvidenceCard";
import { VerdictBadge } from "./components/VerdictBadge";

interface UIState {
  status: "idle" | "running" | "done" | "error";
  claim: string;
  steps: string[];
  subClaims: SubClaim[];
  evidence: EvidenceItem[];
  overall: OverallVerdict | null;
  error: string | null;
}

const INITIAL_STATE: UIState = {
  status: "idle",
  claim: "",
  steps: [],
  subClaims: [],
  evidence: [],
  overall: null,
  error: null,
};

export default function Home() {
  const [state, setState] = useState<UIState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  function applyEvent(event: RunEvent) {
    setState((s) => {
      switch (event.type) {
        case "step":
          return { ...s, steps: [...s.steps, event.label] };
        case "subclaims":
          return { ...s, subClaims: event.subClaims };
        case "source":
          return s;
        case "evidence":
          return { ...s, evidence: [...s.evidence, event.evidence] };
        case "verdict":
          return { ...s, overall: event.overall };
        case "done":
          return { ...s, status: "done" };
        case "error":
          return { ...s, status: "error", error: event.message };
        default:
          return s;
      }
    });
  }

  async function handleSubmit(claim: string, manualUrls: string[]) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...INITIAL_STATE, status: "running", claim });

    try {
      const res = await fetch("/api/factcheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim, manualUrls }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `サーバーエラー (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex = buffer.indexOf("\n\n");
        while (sepIndex !== -1) {
          const chunk = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            const event: RunEvent = JSON.parse(line.slice("data: ".length));
            applyEvent(event);
          }
          sepIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setState((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  const running = state.status === "running";

  return (
    <div className="flex min-h-full flex-col items-center bg-zinc-50 dark:bg-black">
      <main className="w-full max-w-3xl flex-1 px-4 py-10 sm:px-8">
        <header className="mb-6 space-y-1.5">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            ローカルLLMファクトチェック・デモ
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            AI検索サービスにあるファクトチェック機能を参考に、主張の分解・根拠探索・ハイライト付きスクリーンショット撮影・二次AIによる画像検証を、すべてローカルの llama.cpp（gemma-4-12b / gemma-3-4b vision）だけで実行します。
          </p>
        </header>

        <ClaimForm running={running} onSubmit={handleSubmit} />

        {state.error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            エラー: {state.error}
          </p>
        )}

        {state.steps.length > 0 && (
          <div className="mt-6">
            <RunTimeline steps={state.steps} running={running} />
          </div>
        )}

        {state.overall && (
          <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                総合判定
              </h2>
              <VerdictBadge verdict={state.overall.verdict} />
              <span className="text-xs text-zinc-400">
                信頼度 {Math.round(state.overall.confidence * 100)}%
              </span>
            </div>
            <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              {state.overall.summary}
            </p>
          </section>
        )}

        <div className="mt-8 space-y-8">
          {state.subClaims.map((sc) => {
            const items = state.evidence.filter((e) => e.subClaimId === sc.id);
            const subVerdict = state.overall?.subClaimVerdicts.find(
              (v) => v.subClaimId === sc.id,
            );
            return (
              <section key={sc.id}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                    {sc.text}
                  </h3>
                  {subVerdict && <VerdictBadge verdict={subVerdict.verdict} />}
                </div>
                {items.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {running ? "根拠を探索中です…" : "根拠となるソースが見つかりませんでした"}
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {items.map((e) => (
                      <EvidenceCard key={e.id} evidence={e} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
