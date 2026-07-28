"use client";

import { useState } from "react";

export function ClaimForm({
  running,
  onSubmit,
}: {
  running: boolean;
  onSubmit: (claim: string, manualUrls: string[]) => void;
}) {
  const [claim, setClaim] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [showUrls, setShowUrls] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = claim.trim();
    if (!trimmed || running) return;
    const manualUrls = urlsText
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);
    onSubmit(trimmed, manualUrls);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        value={claim}
        onChange={(e) => setClaim(e.target.value)}
        placeholder="検証したい主張を入力してください（例: 富士山の標高は3776mである）"
        rows={3}
        maxLength={500}
        disabled={running}
        className="w-full resize-none rounded-xl border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
      />

      <button
        type="button"
        onClick={() => setShowUrls((v) => !v)}
        className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        {showUrls ? "参照URLの指定を隠す" : "参照URLを直接指定する（任意）"}
      </button>

      {showUrls && (
        <textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder={"検証に使ってほしいURLを1行に1つずつ入力（任意）"}
          rows={2}
          disabled={running}
          className="w-full resize-none rounded-xl border border-zinc-300 bg-white p-3 text-xs outline-none focus:border-zinc-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
        />
      )}

      <button
        type="submit"
        disabled={running || !claim.trim()}
        className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {running ? "ファクトチェック実行中…" : "ファクトチェックを実行"}
      </button>
    </form>
  );
}
