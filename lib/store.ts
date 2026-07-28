// 実行 (run) ごとのスクリーンショット保存先の管理。
// 保存先は .data/runs/<runId>/ 配下（.gitignore 済み、public/ には置かない）。

import fs from "node:fs/promises";
import path from "node:path";

const DATA_ROOT = path.join(process.cwd(), ".data", "runs");

/** runId として許可する形式（crypto.randomUUID() の出力） */
export const RUN_ID_PATTERN = /^[a-f0-9-]{36}$/;
/** 保存されるスクリーンショットのファイル名パターン */
export const SHOT_FILENAME_PATTERN = /^[a-zA-Z0-9_-]+\.png$/;

export function newRunId(): string {
  return crypto.randomUUID();
}

export function runDir(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`不正な runId: ${runId}`);
  }
  return path.join(DATA_ROOT, runId);
}

export async function ensureRunDir(runId: string): Promise<string> {
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * /api/shots/[runId]/[file] からの配信用にパスを検証して絶対パスへ解決する。
 * パストラバーサル対策として、両方の断片を厳格な正規表現で検証したうえで、
 * 解決後のパスが DATA_ROOT 配下であることも二重に確認する。
 */
export function resolveShotPath(runId: string, file: string): string {
  if (!RUN_ID_PATTERN.test(runId) || !SHOT_FILENAME_PATTERN.test(file)) {
    throw new Error("不正なパスです");
  }
  const resolved = path.resolve(DATA_ROOT, runId, file);
  const rootResolved = path.resolve(DATA_ROOT);
  if (!resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("不正なパスです");
  }
  return resolved;
}
