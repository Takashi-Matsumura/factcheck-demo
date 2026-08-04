// llama.cpp (llama-server) の OpenAI 互換エンドポイントへの薄いクライアント。
// 常駐しているローカルモデル群:
//   8080 gemma-4-12b-it   … 分解 / 引用抽出 / 総合判定（テキスト専用）
//   8081 gemma-3-4b-it    … スクリーンショットの二次検証（vision 対応）
//   8082 bge-m3           … 埋め込み（lib/embed.ts が使用）

export const REASONER_PORT = 8080;
export const VISION_PORT = 8081;

const REASONER_MODEL = "gemma-4-12b-it-Q4_K_M.gguf";
const VISION_MODEL = "gemma-3-4b-it-q4_0.gguf";

interface ChatJsonOptions {
  port?: number;
  model?: string;
  system?: string;
  user: string;
  /** JSON Schema (strict) */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

function baseUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

async function postChat(
  port: number,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ content: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `llama-server ${port} returned ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`llama-server ${port}: unexpected response shape`);
    }
    return { content };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 推論モデル (gemma-4-12b) に JSON Schema 制約付きで問い合わせ、
 * パース済みオブジェクトを返す。
 */
export async function chatJson<T>({
  port = REASONER_PORT,
  model = REASONER_MODEL,
  system,
  user,
  schema,
  schemaName,
  maxTokens = 400,
  temperature = 0.1,
  timeoutMs = 120_000,
}: ChatJsonOptions): Promise<T> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const { content } = await postChat(
    port,
    {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // このモデルは既定で chain-of-thought (reasoning_content) を出力し、
      // 短い max_tokens だとそこで予算を使い切って肝心の JSON が空になる。
      // 構造化出力ではそもそも思考過程は不要なので明示的に無効化する。
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    },
    timeoutMs,
  );
  return parseJsonLoose<T>(content, "chatJson");
}

/**
 * JSON.parse をまず試し、失敗したら文字列内の最初の `{` から最後の `}` までを
 * 貪欲に取り出して再度パースする。reasoning の前置きテキストが混ざった場合などの
 * 保険で、構造化出力(json_schema)が効かなかった場合のフォールバック呼び出しでも使う。
 */
export function parseJsonLoose<T>(content: string, label = "parseJsonLoose"): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    // フォールスルーして緩い抽出を試みる
  }
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // フォールスルーして最終的に throw する
    }
  }
  throw new Error(`${label}: モデル出力が JSON として解釈できません: ${content.slice(0, 300)}`);
}

interface ChatTextOptions {
  port?: number;
  model?: string;
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * response_format による構造化出力を使わない自由記述の問い合わせ。
 * json_schema 制約が(スキーマの複雑さ等で)機能しなかった場合のフォールバック用。
 */
export async function chatText({
  port = REASONER_PORT,
  model = REASONER_MODEL,
  system,
  user,
  maxTokens = 400,
  temperature = 0.1,
  timeoutMs = 120_000,
}: ChatTextOptions): Promise<string> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const { content } = await postChat(
    port,
    {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    },
    timeoutMs,
  );
  return content;
}

interface ChatVisionOptions {
  port?: number;
  model?: string;
  prompt: string;
  /** data:image/png;base64,... 形式、または生の base64 文字列 */
  imageDataUrl: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * vision モデル (gemma-3-4b) に画像 + プロンプトを送り、テキスト応答を返す。
 * 構造化出力は現行 chat_template_caps 上サポート対象外の組み合わせがあるため、
 * ここでは自由記述を受け取り、呼び出し側で軽量パースする。
 */
export async function chatVisionRaw({
  port = VISION_PORT,
  model = VISION_MODEL,
  prompt,
  imageDataUrl,
  maxTokens = 250,
  timeoutMs = 60_000,
}: ChatVisionOptions): Promise<string> {
  const url = imageDataUrl.startsWith("data:")
    ? imageDataUrl
    : `data:image/png;base64,${imageDataUrl}`;
  const { content } = await postChat(
    port,
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    },
    timeoutMs,
  );
  return content;
}
