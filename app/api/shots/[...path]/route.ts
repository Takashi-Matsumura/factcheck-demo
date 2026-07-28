import fs from "node:fs/promises";
import { resolveShotPath } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (path.length !== 2) {
    return new Response("Not Found", { status: 404 });
  }
  const [runId, file] = path;

  let absPath: string;
  try {
    absPath = resolveShotPath(runId, file);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const data = await fs.readFile(absPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
