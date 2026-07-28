import { runFactCheck } from "@/lib/pipeline";
import type { RunEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function iteratorToStream(iterator: AsyncGenerator<RunEvent>) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      if (value.type === "done" || value.type === "error") {
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export async function POST(request: Request) {
  let body: { claim?: unknown; manualUrls?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストボディが不正です" }, { status: 400 });
  }

  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim) {
    return Response.json({ error: "claim は必須です" }, { status: 400 });
  }
  if (claim.length > 500) {
    return Response.json(
      { error: "claim は500文字以内にしてください" },
      { status: 400 },
    );
  }

  const manualUrls = Array.isArray(body.manualUrls)
    ? body.manualUrls.filter((u): u is string => typeof u === "string").slice(0, 5)
    : [];

  const iterator = runFactCheck({ claim, manualUrls });
  const stream = iteratorToStream(iterator);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
