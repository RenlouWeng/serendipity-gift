import type { NextRequest } from "next/server";
import {
  DEFAULT_BUDGET_TIER,
  DEFAULT_OCCASION,
  isBudgetTier,
  isOccasion,
} from "@/lib/gift-config";
import { createSerendipityAnalysis } from "@/lib/analysis";
import {
  extractLinksFromCustomerInput,
  normalizeLinks,
} from "@/lib/customer-input";
import type { AnalyzeRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_COUNT = 6;
const requestLog = new Map<string, number[]>();

function normalizeStringArray(value: unknown, limit = 8) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function getClientKey(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local"
  );
}

function isRateLimited(clientKey: string) {
  const now = Date.now();
  const timestamps = requestLog.get(clientKey) ?? [];
  const valid = timestamps.filter((value) => now - value < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_COUNT) {
    requestLog.set(clientKey, valid);
    return true;
  }

  valid.push(now);
  requestLog.set(clientKey, valid);
  return false;
}

export async function POST(request: NextRequest) {
  if (isRateLimited(getClientKey(request))) {
    return Response.json(
      { error: "请求有点频繁，请稍后再试。" },
      { status: 429 },
    );
  }

  let body: AnalyzeRequest;

  try {
    body = (await request.json()) as AnalyzeRequest;
  } catch {
    return Response.json({ error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  const customerInput =
    typeof body.customer_input === "string" && body.customer_input.trim()
      ? body.customer_input.trim()
      : undefined;
  const companyName =
    typeof body.company_name === "string" && body.company_name.trim()
      ? body.company_name.trim()
      : undefined;
  const rawLinks = Array.isArray(body.links) ? body.links : [];
  const links = normalizeLinks([
    ...rawLinks,
    ...extractLinksFromCustomerInput(customerInput ?? ""),
  ]);
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  const personTraits = normalizeStringArray(body.person_traits, 8);
  const personInterests = normalizeStringArray(body.person_interests, 8);
  const recentChat =
    typeof body.recent_chat === "string" && body.recent_chat.trim()
      ? body.recent_chat.trim()
      : undefined;
  const personImpression =
    typeof body.person_impression === "string" && body.person_impression.trim()
      ? body.person_impression.trim()
      : undefined;
  const recipientRole =
    typeof body.recipient_role === "string" && body.recipient_role.trim()
      ? body.recipient_role.trim()
      : undefined;
  const targetRegion =
    typeof body.target_region === "string" && body.target_region.trim()
      ? body.target_region.trim()
      : undefined;
  const occasion =
    body.occasion === undefined
      ? DEFAULT_OCCASION
      : typeof body.occasion === "string" && isOccasion(body.occasion)
        ? body.occasion
        : null;
  const budgetTier =
    body.budget_tier === undefined
      ? DEFAULT_BUDGET_TIER
      : typeof body.budget_tier === "string" && isBudgetTier(body.budget_tier)
        ? body.budget_tier
        : null;

  if (links.length === 0 && !customerInput && !companyName) {
    return Response.json(
      { error: "请至少提供公司名、官网、邮箱域名、社媒链接中的任意一种信息。" },
      { status: 400 },
    );
  }

  if (links.length > 5) {
    return Response.json(
      { error: "首版最多分析 5 个链接。" },
      { status: 400 },
    );
  }

  if (!occasion) {
    return Response.json({ error: "送礼场景无效。" }, { status: 400 });
  }

  if (!budgetTier) {
    return Response.json({ error: "预算档位无效。" }, { status: 400 });
  }

  try {
    const result = await createSerendipityAnalysis({
      customerInput,
      companyName,
      links,
      occasion,
      budgetTier,
      recipientRole,
      targetRegion,
      note,
      personTraits,
      personInterests,
      recentChat,
      personImpression,
    });
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "生成礼物建议时发生未知错误";
    const status = /请至少|公开内容暂时无法分析/.test(message) ? 422 : 500;

    return Response.json({ error: message }, { status });
  }
}
