// bge-m3 (port 8082) による埋め込み。根拠候補文のランキングに使用する。

const EMBED_PORT = 8082;
const EMBED_MODEL = "bbvch-ai/bge-m3-GGUF";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`http://127.0.0.1:${EMBED_PORT}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`embeddings server returned ${res.status}`);
  }
  const data = await res.json();
  return (data.data as Array<{ embedding: number[]; index: number }>)
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * query に最も近い候補を上位 topK 件、類似度降順で返す。
 */
export async function rankBySimilarity(
  query: string,
  candidates: string[],
  topK: number,
): Promise<Array<{ text: string; score: number; index: number }>> {
  if (candidates.length === 0) return [];
  const [queryEmbedding, ...candidateEmbeddings] = await embedTexts([
    query,
    ...candidates,
  ]);
  return candidates
    .map((text, index) => ({
      text,
      index,
      score: cosineSimilarity(queryEmbedding, candidateEmbeddings[index]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
