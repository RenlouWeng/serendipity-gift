import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;

  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  const event =
    typeof payload.event === "string" && payload.event.trim()
      ? payload.event.trim()
      : "unknown";

  const record = {
    event,
    context: typeof payload.context === "string" ? payload.context : "",
    mode: typeof payload.mode === "string" ? payload.mode : "",
    createdAt: new Date().toISOString(),
    referer: request.headers.get("referer") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  };

  if (process.env.LEAD_WEBHOOK_URL) {
    try {
      await fetch(process.env.LEAD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch (error) {
      console.error("[lead] webhook forward failed", error);
    }
  } else {
    console.info("[lead]", record);
  }

  return Response.json({ ok: true });
}
