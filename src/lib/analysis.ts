import { load } from "cheerio";
import {
  DEFAULT_BUDGET_TIER,
  DEFAULT_OCCASION,
  getBudgetMeta,
  getOccasionMeta,
} from "./gift-config";
import {
  extractLinksFromCustomerInput,
  guessCompanyName,
  normalizeLinks,
  stripLinksFromCustomerInput,
} from "./customer-input";
import { resolveOpenAIConfig } from "./openai-config";
import type {
  AnalysisConfidence,
  AnalyzeResponse,
  BudgetTier,
  GiftIdeaWithReasoning,
  Occasion,
  ProcurementBrief,
  SourceSummary,
} from "./types";

type SourceKind = "website" | "instagram" | "facebook" | "linkedin" | "other";

interface PageSnapshot {
  url: string;
  title: string;
  description: string;
  headings: string;
  body: string;
  relatedUrls: string[];
}

interface FetchedSource {
  url: string;
  label?: string;
  kind: SourceKind;
  status: "used" | "unavailable";
  title?: string;
  evidence: string;
  content: string;
}

interface FallbackProfile {
  label: string;
  tone: string;
  summary_hint: string;
  keywords: string[];
  evidence_hint: string;
  gifts: Record<BudgetTier, [string, string, string]>;
  cautions: [string, string, string];
}

interface CustomerProfileContext {
  customer_summary: string;
  client_name: string;
  industry_signal: string;
  brand_tone: string;
  gift_signal: string;
  human_signal: string;
  human_clue_count: number;
  confidence: AnalysisConfidence;
  gaps: string[];
  evidence_highlights: string[];
  recipient_role: string;
  target_region: string;
  matched_profile: FallbackProfile;
}

const SOURCE_LIMIT = 5;
const FETCH_TIMEOUT_MS = 8_000;
const AI_TIMEOUT_MS = 45_000;
const MAX_SOURCE_CHARS = 2_200;
const DEFAULT_RECIPIENT_ROLE = "未指定";
const DEFAULT_TARGET_REGION = "未指定";
const MANUAL_SOURCE_URL = "manual://customer-input";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HUMAN_LABEL_KEYWORDS: Record<string, string[]> = {
  "理性克制": ["rational", "professional"],
  "热情外向": ["hospitality", "lifestyle"],
  "低调谨慎": ["professional", "responsible"],
  "讲究细节": ["design", "precision"],
  "审美敏感": ["design", "brand", "creative"],
  "务实直接": ["manufacturing", "supply chain"],
  "喜欢新鲜事物": ["creative", "innovation"],
  "重视效率": ["logistics", "automation"],
  咖啡: ["coffee", "hospitality"],
  运动: ["lifestyle", "outdoor"],
  旅行: ["travel", "mobility"],
  户外: ["outdoor", "sustainable"],
  设计: ["design", "creative", "brand"],
  科技产品: ["tech", "software", "engineering"],
  可持续: ["sustainable", "sustainability", "impact"],
  "书店 / 阅读": ["editorial", "lookbook", "visual"],
  "家庭 / 孩子": ["lifestyle", "hospitality"],
  宠物: ["lifestyle", "consumer"],
  新办公室: ["workspace", "design", "brand"],
  品牌升级: ["brand", "design", "campaign"],
};

const DECISION_SYSTEM_PROMPT = `
你是一个给中国外贸业务员使用的商务送礼决策助手。

你的目标不是展示分析能力，而是帮助业务员在特定场景下尽快做决定并执行。

输入会包含：
- 客户公开资料提炼出的画像
- 送礼场景
- 预算档位
- 收礼人角色
- 目标国家或地区
- 原始公开来源摘要
- 用户可选补充说明

输出必须是严格 json，不要输出 Markdown，不要输出代码块。
你必须返回一个有效的 json object。

你必须遵守：
- 只返回 1 个主推荐和 2 个备选。
- 主推荐优先考虑“现在就能送、容易执行、不会翻车”，不是追求最花哨。
- 礼物名称必须是现实里可以采购的具体品类，不能写成抽象创意概念。
- 礼物要可寄送、可携带、文化风险低、海关风险低。
- 避免常见套路礼物，如钢笔、茶叶、保温杯、U 盘、通用名片夹。
- 预算必须真实影响结果，不能只是文案说“适合这个预算”。
- 如果公开信息有限，要在 decision_summary 里明确说判断偏保守，但仍要给出可执行主推荐。
- 备选必须和主推荐有明显差异，不能只是同类礼物换个叫法。
- 如果提供了收礼人角色，要让礼物更适合该角色的接受习惯和内部审批逻辑。
- 如果提供了目标国家或地区，要优先规避当地清关、重量、文化表达上的常见风险。
- 如果提供了性格、爱好、最近聊天片段、业务员印象，你必须优先使用这些“人的线索”，不要只停留在公司层面的泛泛判断。
- 人的线索可以让礼物更像“为他挑的”，但仍要保持商务边界，不要过度私人化。

JSON 结构必须严格如下：
{
  "decision_summary": "string",
  "primary_recommendation": {
    "name": "string",
    "item_type": "string",
    "reason": "string",
    "why_now": "string",
    "budget_fit": "string",
    "target_unit_price": "string",
    "lead_time": "string",
    "customization_level": "string",
    "shipping_ease": "string",
    "sourcing_tip": "string",
    "approval_hint": "string",
    "caution": "string",
    "message_snippet": "string"
  },
  "procurement_brief": {
    "execution_mode": "string",
    "recommended_quantity": "string",
    "sample_plan": "string",
    "packaging_plan": "string",
    "branding_note": "string",
    "supplier_message": "string"
  },
  "backup_recommendations": [
    {
      "name": "string",
      "item_type": "string",
      "reason": "string",
      "why_now": "string",
      "budget_fit": "string",
      "target_unit_price": "string",
      "lead_time": "string",
      "customization_level": "string",
      "shipping_ease": "string",
      "sourcing_tip": "string",
      "approval_hint": "string",
      "caution": "string",
      "message_snippet": "string"
    }
  ],
  "follow_up_message": "string",
  "risk_notes": ["string"],
  "cta_message": "string"
}

额外要求：
- backup_recommendations 必须恰好 2 个
- risk_notes 需要 2 到 4 条
- message_snippet 是业务员可以复制给同事/老板确认的短说明
- procurement_brief 是业务员直接拿去和采购或供应商沟通的执行摘要
- follow_up_message 是业务员在当前送礼场景下可参考的中文跟进话术
- cta_message 长度不超过 24 个汉字
- target_unit_price 要写清单份建议价格区间
- lead_time 要写清现货和轻定制的大致交期
- customization_level 要明确是否建议刻字/定制包装
- shipping_ease 要直接说明寄送和清关难度
- sourcing_tip 要让业务员知道应该找哪类供应商而不是空泛描述
- approval_hint 要说明适合如何拿给老板或同事过目
- execution_mode 要明确是直接现货、轻定制，还是先打样再下单
- recommended_quantity 要给业务员一个首轮下单数量建议，不要写成模糊原则
- sample_plan 要说明先看现货图、先打样还是可以直接下单
- packaging_plan 要直接说外包装和说明卡该怎么做，避免太重太夸张
- branding_note 要明确是否建议打 logo、做腰封、放说明卡
- supplier_message 要写成可以直接发给采购/供应商的中文询价 brief
`.trim();

const FALLBACK_PROFILES: FallbackProfile[] = [
  {
    label: "品牌表达与专业感",
    tone: "表达克制、讲究专业形象和判断力",
    summary_hint: "更像一个在意品牌印象、合作体验和专业表达的客户。",
    keywords: [],
    evidence_hint: "当前公开信息有限，更适合走稳妥但有记忆点的商务礼物路线。",
    gifts: {
      "100_300_cny": [
        "品牌线索便携卡片礼套",
        "客户城市主题金属书签",
        "行业故事折页小册",
      ],
      "300_800_cny": [
        "客户线索定制桌面礼片",
        "客户城市线稿黄铜书挡",
        "独立出版主题小礼盒",
      ],
      "800_1500_cny": [
        "定制品牌语境桌面礼盒",
        "客户城市主题黄铜摆件",
        "行业故事册与桌面器物组合",
      ],
    },
    cautions: [
      "避免直接印客户 logo，容易像促销品。",
      "礼物最好轻巧、可放进行李，不要增加客户携带负担。",
      "在信息不足时不要送过于私人化的礼物。",
    ],
  },
  {
    label: "品牌与审美表达",
    tone: "很重视视觉、品牌语言和审美一致性",
    summary_hint: "公开资料显示对方明显重视品牌表达、设计细节和内容呈现。",
    keywords: [
      "design",
      "brand",
      "creative",
      "visual",
      "studio",
      "fashion",
      "lifestyle",
      "collection",
      "editorial",
      "lookbook",
      "campaign",
    ],
    evidence_hint: "更适合送能体现审美判断、材质感和观察力的礼物，而不是通用商务品。",
    gifts: {
      "100_300_cny": [
        "品牌色与材质小样礼套",
        "客户城市线稿金属书签",
        "独立视觉书票卡",
      ],
      "300_800_cny": [
        "品牌语言定制色票卡与材料样本盒",
        "客户总部城市线稿黄铜桌面摆件",
        "独立出版视觉期刊与策展书签礼套",
      ],
      "800_1500_cny": [
        "品牌语言定制材料礼盒",
        "客户总部城市黄铜摆件礼盒",
        "独立出版视觉期刊组合礼盒",
      ],
    },
    cautions: [
      "避免直接复用客户商标或做成像官方周边的样子。",
      "城市元素需要做得克制，不要变成旅游纪念品风格。",
      "刊物和设计物最好选英文内容或图像主导版本。",
    ],
  },
  {
    label: "技术、产品与工程感",
    tone: "内容表达偏理性、系统化、产品化",
    summary_hint: "对方更像强调系统、产品逻辑和工程感的客户。",
    keywords: [
      "software",
      "saas",
      "platform",
      "data",
      "cloud",
      "robot",
      "tech",
      "digital",
      "automation",
      "hardware",
      "engineering",
      "ai",
    ],
    evidence_hint: "更适合送带有结构感、工具感或系统思维隐喻的礼物。",
    gifts: {
      "100_300_cny": [
        "产品语言解构卡片礼套",
        "总部城市地形金属书签",
        "逻辑谜题折页套装",
      ],
      "300_800_cny": [
        "产品语言定制的机械解构桌面摆件",
        "总部城市地形纹理金属纸镇",
        "工程师向独立工具卡组或逻辑谜题礼盒",
      ],
      "800_1500_cny": [
        "产品语言定制机械桌面礼盒",
        "总部城市地形黄铜纸镇礼盒",
        "工程工具卡组与收纳盒组合",
      ],
    },
    cautions: [
      "避免送廉价的数码配件，看起来会像展会赠品。",
      "地形或地图元素要简洁，避免太像促销纪念品。",
      "谜题类礼物要选高级材质，避免显得幼稚。",
    ],
  },
  {
    label: "可持续与责任感表达",
    tone: "强调材料责任、长期主义和社会影响",
    summary_hint: "公开资料明显强调可持续、环保或责任感叙事。",
    keywords: [
      "sustainable",
      "sustainability",
      "recycle",
      "carbon",
      "climate",
      "eco",
      "ethical",
      "bcorp",
      "responsible",
      "impact",
    ],
    evidence_hint: "更适合送能把材料故事、责任感和长期主义做成具体体验的礼物。",
    gifts: {
      "100_300_cny": [
        "再生材料故事卡礼套",
        "植物纹理压印书签",
        "小众环保材料折页册",
      ],
      "300_800_cny": [
        "再生材料故事卡与工艺标本盒",
        "植物纹理压印桌面托盘",
        "小众可持续材料样本册",
      ],
      "800_1500_cny": [
        "再生材料样本礼盒",
        "植物纹理桌面托盘套装",
        "可持续材料样本册礼盒",
      ],
    },
    cautions: [
      "不要送看起来廉价的环保周边，容易削弱高级感。",
      "植物主题不宜过于园艺化，应保持商务审美。",
      "样本册要说明材料故事，否则会像普通色卡。",
    ],
  },
  {
    label: "制造、工艺与供应链能力",
    tone: "强调工艺、结构和稳定交付能力",
    summary_hint: "客户更像制造型、工艺型或供应链导向的品牌/公司。",
    keywords: [
      "manufacturing",
      "factory",
      "industrial",
      "machinery",
      "equipment",
      "precision",
      "supply chain",
      "components",
      "material",
      "fabrication",
      "tooling",
    ],
    evidence_hint: "更适合送有工艺感、结构感和材质触感的礼物。",
    gifts: {
      "100_300_cny": [
        "核心工艺剖面卡片礼套",
        "工业材质金属书签",
        "工艺演化折页册",
      ],
      "300_800_cny": [
        "核心工艺灵感的微型剖面摆件",
        "工业材质拼接名片托与说明卡",
        "工艺演化小册与材料触感套件",
      ],
      "800_1500_cny": [
        "核心工艺微型桌面礼盒",
        "工业材质拼接桌面摆件",
        "工艺演化册与材质套件礼盒",
      ],
    },
    cautions: [
      "不要做得像真实零件赠品，否则容易显得粗糙。",
      "材质拼接要控制重量，避免运输成本高。",
      "说明卡需要简明，不要写成技术说明书。",
    ],
  },
  {
    label: "饮食、咖啡与生活方式体验",
    tone: "重视氛围、体验和日常生活方式场景",
    summary_hint: "品牌或客户对体验感、门店氛围或生活方式表达较强。",
    keywords: [
      "coffee",
      "roastery",
      "cafe",
      "restaurant",
      "culinary",
      "kitchen",
      "flavor",
      "hospitality",
      "bakery",
      "beverage",
    ],
    evidence_hint: "更适合送带有文化感、空间感或日常仪式感的礼物。",
    gifts: {
      "100_300_cny": [
        "风味地图纸卡礼套",
        "门店城市插画书签",
        "饮食文化小册",
      ],
      "300_800_cny": [
        "风味地图灵感的桌面闻香卡礼套",
        "门店所在城市插画杯垫礼盒",
        "独立出版饮食文化小册与书票",
      ],
      "800_1500_cny": [
        "风味地图桌面礼盒",
        "门店城市插画桌面杯垫套装",
        "饮食文化册与空间礼物组合",
      ],
    },
    cautions: [
      "不要直接送食品或液体，国际运输不稳定。",
      "城市插画要做得成熟，避免太网红风。",
      "书册内容需偏文化视角，避免像菜谱赠品。",
    ],
  },
  {
    label: "出行、物流与全球流动性",
    tone: "关注路线、节点、效率和全球流动场景",
    summary_hint: "业务和品牌表达明显围绕物流、出行或全球流动展开。",
    keywords: [
      "travel",
      "aviation",
      "logistics",
      "shipping",
      "mobility",
      "route",
      "destination",
      "cargo",
      "freight",
      "fleet",
    ],
    evidence_hint: "更适合送路线、节点或全球流动隐喻较强的礼物。",
    gifts: {
      "100_300_cny": [
        "路线节点卡片礼套",
        "坐标主题金属书签",
        "独立地图折页册",
      ],
      "300_800_cny": [
        "路线图灵感的金属书挡或纸镇",
        "港口或城市坐标主题桌面礼片",
        "全球路线故事卡与独立地图册",
      ],
      "800_1500_cny": [
        "路线图桌面礼盒",
        "港口坐标黄铜摆件礼盒",
        "全球路线册与桌面器物组合",
      ],
    },
    cautions: [
      "路线元素不要过度复杂，否则会像宣传品。",
      "坐标礼片要控制尺寸，避免不方便携带。",
      "地图册优先选择视觉叙事强的版本，不要太学术。",
    ],
  },
];

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function detectSourceKind(url: string): SourceKind {
  const hostname = safeHostname(url);

  if (hostname.includes("instagram.com")) {
    return "instagram";
  }

  if (hostname.includes("facebook.com") || hostname.includes("fb.com")) {
    return "facebook";
  }

  if (hostname.includes("linkedin.com")) {
    return "linkedin";
  }

  if (hostname.includes(".")) {
    return "website";
  }

  return "other";
}

function findAboutLinks(html: string, currentUrl: string) {
  const $ = load(html);
  const baseUrl = new URL(currentUrl);
  const candidates = new Set<string>();
  const patterns =
    /about|company|story|team|mission|culture|who-we-are|our-story|about-us/i;

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = cleanText($(element).text());

    if (!href) {
      return;
    }

    try {
      const target = new URL(href, baseUrl);
      if (target.origin !== baseUrl.origin) {
        return;
      }

      if (patterns.test(target.pathname) || patterns.test(text)) {
        candidates.add(target.toString().replace(/\/$/, ""));
      }
    } catch {
      return;
    }
  });

  return [...candidates].slice(0, 1);
}

async function fetchPage(url: string, allowRelated = true): Promise<PageSnapshot> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  if (!contentType.includes("html") && !contentType.includes("text/plain")) {
    throw new Error("Unsupported content type");
  }

  if (contentType.includes("text/plain")) {
    return {
      url: response.url,
      title: safeHostname(response.url),
      description: "",
      headings: "",
      body: truncate(cleanText(raw), MAX_SOURCE_CHARS),
      relatedUrls: [],
    };
  }

  const $ = load(raw);
  $("script, style, noscript, svg, iframe").remove();

  const title = cleanText(
    $("meta[property='og:title']").attr("content") ??
      $("meta[name='twitter:title']").attr("content") ??
      $("title").first().text() ??
      safeHostname(response.url),
  );

  const description = cleanText(
    $("meta[name='description']").attr("content") ??
      $("meta[property='og:description']").attr("content") ??
      $("meta[name='twitter:description']").attr("content") ??
      "",
  );

  const headings = truncate(
    cleanText(
      $("h1, h2")
        .toArray()
        .map((element) => $(element).text())
        .join(" | "),
    ),
    320,
  );

  const body = truncate(
    cleanText(
      $("p, li")
        .toArray()
        .map((element) => $(element).text())
        .join(" "),
    ),
    MAX_SOURCE_CHARS,
  );

  return {
    url: response.url,
    title,
    description,
    headings,
    body,
    relatedUrls: allowRelated ? findAboutLinks(raw, response.url) : [],
  };
}

function pageToEvidence(page: PageSnapshot) {
  return truncate(
    [
      page.title && `Title: ${page.title}`,
      page.description && `Description: ${page.description}`,
      page.headings && `Headings: ${page.headings}`,
      page.body && `Extract: ${page.body}`,
    ]
      .filter(Boolean)
      .join("\n"),
    2_600,
  );
}

async function fetchSource(url: string): Promise<FetchedSource> {
  const kind = detectSourceKind(url);

  try {
    const primary = await fetchPage(url, kind === "website");
    const sections = [pageToEvidence(primary)];

    if (kind === "website" && primary.relatedUrls.length > 0) {
      try {
        const secondary = await fetchPage(primary.relatedUrls[0], false);
        sections.push(`About Page\n${pageToEvidence(secondary)}`);
      } catch {
        // Keep primary snapshot even if the secondary page is unavailable.
      }
    }

    const evidence = truncate(cleanText(sections.join("\n\n")), 2_800);

    return {
      url,
      kind,
      status: "used",
      title: primary.title,
      evidence,
      content: evidence,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "页面无法访问或内容受限";

    return {
      url,
      kind,
      status: "unavailable",
      evidence: `无法提取内容：${message}`,
      content: "",
    };
  }
}

function parseJsonObject(text: string) {
  const fenced = text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI 返回的不是有效 JSON");
  }

  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

async function callOpenAIJson(systemPrompt: string, payload: unknown) {
  const config = resolveOpenAIConfig();

  if (!config) {
    throw new Error("OpenAI config is missing");
  }

  const requestBody: Record<string, unknown> = {
    model: config.model,
    temperature: 0.55,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Return a valid json object only for this payload:\n${JSON.stringify(payload)}`,
      },
    ],
  };

  if (config.model.startsWith("gpt-5")) {
    requestBody.reasoning_effort =
      process.env.OPENAI_REASONING_EFFORT ?? "medium";
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    const details = truncate(cleanText(responseText), 320);

    throw new Error(
      details
        ? `OpenAI ${response.status}: ${details}`
        : `OpenAI ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string | Array<{ text?: string }> };
    }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => part.text ?? "").join("")
    : content ?? "";

  return parseJsonObject(text);
}

function pickProfile(sources: FetchedSource[]) {
  const haystack = sources
    .map((source) => source.content.toLowerCase())
    .join(" ");

  const scoredProfiles = FALLBACK_PROFILES.map((profile) => ({
    profile,
    score: profile.keywords.reduce(
      (sum, keyword) => sum + (haystack.includes(keyword.toLowerCase()) ? 1 : 0),
      0,
    ),
  })).sort((left, right) => right.score - left.score);

  return scoredProfiles[0]?.score
    ? scoredProfiles[0].profile
    : FALLBACK_PROFILES[0];
}

function normalizeRecipientRole(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? truncate(cleanText(trimmed), 36) : DEFAULT_RECIPIENT_ROLE;
}

function normalizeTargetRegion(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? truncate(cleanText(trimmed), 36) : DEFAULT_TARGET_REGION;
}

function normalizeHumanLabels(values?: string[], limit = 8) {
  return (values ?? [])
    .map((value) => cleanText(value))
    .filter(Boolean)
    .slice(0, limit);
}

function buildHumanSignalSummary(input: {
  personTraits: string[];
  personInterests: string[];
  recentChat?: string;
  personImpression?: string;
}) {
  const parts: string[] = [];

  if (input.personTraits.length > 0) {
    parts.push(`性格线索：${input.personTraits.join("、")}`);
  }

  if (input.personInterests.length > 0) {
    parts.push(`兴趣或最近在意：${input.personInterests.join("、")}`);
  }

  if (input.recentChat?.trim()) {
    parts.push(`最近聊过：${truncate(cleanText(input.recentChat), 90)}`);
  }

  if (input.personImpression?.trim()) {
    parts.push(`业务员印象：${truncate(cleanText(input.personImpression), 72)}`);
  }

  return truncate(parts.join("；"), 220);
}

function buildHumanKeywordHints(values: string[]) {
  return [...new Set(values.flatMap((value) => HUMAN_LABEL_KEYWORDS[value] ?? []))].slice(
    0,
    10,
  );
}

function buildManualSource(input: {
  customerInput?: string;
  companyName?: string;
  recipientRole: string;
  targetRegion: string;
  note?: string;
  personTraits: string[];
  personInterests: string[];
  recentChat?: string;
  personImpression?: string;
}) {
  const freeform = stripLinksFromCustomerInput(input.customerInput ?? "");
  const humanKeywordHints = buildHumanKeywordHints([
    ...input.personTraits,
    ...input.personInterests,
  ]);
  const sections = [
    input.companyName ? `Client Name: ${input.companyName}` : "",
    freeform ? `Manual Notes: ${truncate(cleanText(freeform), 700)}` : "",
    input.recipientRole !== DEFAULT_RECIPIENT_ROLE
      ? `Recipient Role: ${input.recipientRole}`
      : "Recipient Role: not specified",
    input.targetRegion !== DEFAULT_TARGET_REGION
      ? `Target Region: ${input.targetRegion}`
      : "Target Region: not specified",
    input.note?.trim() ? `Operator Note: ${truncate(cleanText(input.note), 240)}` : "",
    input.personTraits.length > 0
      ? `Recipient Traits: ${input.personTraits.join(", ")}`
      : "",
    input.personInterests.length > 0
      ? `Recipient Interests: ${input.personInterests.join(", ")}`
      : "",
    humanKeywordHints.length > 0
      ? `Recipient Signal Keywords: ${humanKeywordHints.join(", ")}`
      : "",
    input.recentChat?.trim()
      ? `Recent Chat: ${truncate(cleanText(input.recentChat), 420)}`
      : "",
    input.personImpression?.trim()
      ? `Seller Impression: ${truncate(cleanText(input.personImpression), 220)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!sections) {
    return null;
  }

  return {
    url: MANUAL_SOURCE_URL,
    label: "用户输入",
    kind: "other" as const,
    status: "used" as const,
    title: input.companyName || "用户输入",
    evidence: sections,
    content: sections,
  };
}

function buildEvidenceHighlights(input: {
  sources: FetchedSource[];
  matchedProfile: FallbackProfile;
  recipientRole: string;
  targetRegion: string;
  humanSignal: string;
  gaps: string[];
}) {
  const highlights: string[] = [];
  const publicSources = input.sources.filter(
    (source) => source.url !== MANUAL_SOURCE_URL && source.status === "used",
  );
  const titles = publicSources
    .map((source) => source.title)
    .filter((title): title is string => Boolean(title))
    .slice(0, 2);

  if (titles.length > 0) {
    highlights.push(`公开线索主要来自 ${titles.join(" / ")}。`);
  } else {
    highlights.push("这次没有抓到足够公开页面，主要靠你手动输入的信息做保守判断。");
  }

  highlights.push(
    `系统先把客户归到「${input.matchedProfile.label}」路线，所以主推荐会优先选择低文化风险、容易解释的商务品类。`,
  );

  if (input.humanSignal) {
    highlights.push(`这次还用了你补的人的线索：${input.humanSignal}`);
  }

  if (input.recipientRole !== DEFAULT_RECIPIENT_ROLE) {
    highlights.push(
      `收礼人先按「${input.recipientRole}」处理，结果会更偏向该角色容易接受、内部也更容易过审批的礼物。`,
    );
  }

  if (input.targetRegion !== DEFAULT_TARGET_REGION) {
    highlights.push(
      `目标地区先按「${input.targetRegion}」处理，默认规避液体、食品、电池和过重货物。`,
    );
  }

  if (input.gaps.length > 0) {
    highlights.push(input.gaps[0]);
  }

  return highlights.slice(0, 4);
}

function buildCustomerProfileContext(
  sources: FetchedSource[],
  occasion: Occasion,
  recipientRole: string,
  targetRegion: string,
  personTraits: string[],
  personInterests: string[],
  recentChat?: string,
  personImpression?: string,
  note?: string,
): CustomerProfileContext {
  const matchedProfile = pickProfile(sources);
  const titles = sources
    .map((source) => source.title)
    .filter((title): title is string => Boolean(title))
    .slice(0, 2);
  const unavailableCount = sources.filter(
    (source) => source.status === "unavailable",
  ).length;
  const usedKinds = new Set(sources.map((source) => source.kind));
  const manualSource = sources.find((source) => source.url === MANUAL_SOURCE_URL);
  const publicSourceCount = sources.filter(
    (source) => source.url !== MANUAL_SOURCE_URL && source.status === "used",
  ).length;
  const humanSignal = buildHumanSignalSummary({
    personTraits,
    personInterests,
    recentChat,
    personImpression,
  });
  const humanClueCount = [
    personTraits.length > 0,
    personInterests.length > 0,
    Boolean(recentChat?.trim()),
    Boolean(personImpression?.trim()),
  ].filter(Boolean).length;
  const clientName =
    titles[0] ??
    manualSource?.title ??
    safeHostname(sources[0]?.url ?? "the client");
  const occasionMeta = getOccasionMeta(occasion);
  const noteText = note?.trim()
    ? ` 并结合你的补充“${truncate(cleanText(note), 44)}”。`
    : "";
  const confidence: AnalysisConfidence =
    (publicSourceCount >= 2 && unavailableCount === 0) ||
    (publicSourceCount >= 1 && humanClueCount >= 2 && unavailableCount === 0)
      ? "high"
      : publicSourceCount >= 1 || humanClueCount >= 1 || unavailableCount > 0
        ? "medium"
        : "low";
  const gaps: string[] = [];

  if (publicSourceCount === 0) {
    gaps.push("这次没有抓到官网或公开页面，主要依据你手动输入的信息，建议只做轻量、低风险版本。");
  }

  if (publicSourceCount > 0 && !usedKinds.has("instagram") && !usedKinds.has("facebook")) {
    gaps.push("本次主要依据官网或公开页面，缺少更强的社媒生活化线索。");
  }

  if (publicSourceCount <= 1) {
    gaps.push("可直接判断客户兴趣和个人偏好的线索较少。");
  }

  if (humanClueCount === 0) {
    gaps.push("如果补 1 条最近聊过的话、性格标签或你的主观印象，礼物会更像为他挑的，不会只停留在公司层面。");
  }

  if (unavailableCount > 0) {
    gaps.push("部分链接无法访问，判断更偏保守。");
  }

  if (recipientRole === DEFAULT_RECIPIENT_ROLE) {
    gaps.push("未指定收礼人角色，当前按通用商务联系人处理，不建议做太个人化的礼物。");
  }

  if (targetRegion === DEFAULT_TARGET_REGION) {
    gaps.push("未指定目标地区，当前按常见欧美商务寄送约束处理。");
  }

  const referenceText =
    titles.length > 0 ? `当前主要参考 ${titles.join(" / ")}。` : "";
  const roleText =
    recipientRole === DEFAULT_RECIPIENT_ROLE
      ? " 收礼人角色未指定，先按通用商务联系人处理。"
      : ` 收礼人先按“${recipientRole}”处理。`;
  const regionText =
    targetRegion === DEFAULT_TARGET_REGION
      ? " 目标地区未指定，先按常见欧美商务寄送约束处理。"
      : ` 目标地区先按“${targetRegion}”考虑。`;
  const humanText = humanSignal
    ? ` 你还补了人的线索：${humanSignal}。`
    : "";
  const evidenceHighlights = buildEvidenceHighlights({
    sources,
    matchedProfile,
    recipientRole,
    targetRegion,
    humanSignal,
    gaps,
  });

  return {
    customer_summary: truncate(
      `${clientName} ${matchedProfile.summary_hint} 品牌语气整体偏${matchedProfile.tone}。${referenceText}${roleText}${regionText}${humanText} 对于 ${occasionMeta.label} 这个场景，更适合送轻巧、能看出做过功课、又不显得套路的礼物。${noteText}`.trim(),
      320,
    ),
    client_name: clientName,
    industry_signal: matchedProfile.label,
    brand_tone: matchedProfile.tone,
    gift_signal: matchedProfile.evidence_hint,
    human_signal: humanSignal,
    human_clue_count: humanClueCount,
    confidence,
    gaps,
    evidence_highlights: evidenceHighlights,
    recipient_role: recipientRole,
    target_region: targetRegion,
    matched_profile: matchedProfile,
  };
}

function sanitizeGiftDecision(raw: unknown): GiftIdeaWithReasoning | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const fields = [
    "name",
    "item_type",
    "reason",
    "why_now",
    "budget_fit",
    "target_unit_price",
    "lead_time",
    "customization_level",
    "shipping_ease",
    "sourcing_tip",
    "approval_hint",
    "caution",
    "message_snippet",
  ] as const;
  const output = {} as Record<(typeof fields)[number], string>;

  for (const field of fields) {
    const value = item[field];

    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    output[field] = truncate(
      cleanText(value),
      field === "message_snippet" ? 150 : 180,
    );
  }

  return output as GiftIdeaWithReasoning;
}

function sanitizeProcurementBrief(raw: unknown): ProcurementBrief | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const fields = [
    "execution_mode",
    "recommended_quantity",
    "sample_plan",
    "packaging_plan",
    "branding_note",
    "supplier_message",
  ] as const;
  const output = {} as Record<(typeof fields)[number], string>;

  for (const field of fields) {
    const value = item[field];

    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    output[field] = truncate(
      cleanText(value),
      field === "supplier_message" ? 220 : 120,
    );
  }

  return output as ProcurementBrief;
}

function isGiftDecision(
  value: GiftIdeaWithReasoning | null,
): value is GiftIdeaWithReasoning {
  return value !== null;
}

function sanitizeDecisionPayload(
  payload: unknown,
  profile: CustomerProfileContext,
): AnalyzeResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("AI 返回结构不正确");
  }

  const value = payload as Record<string, unknown>;
  const decisionSummary =
    typeof value.decision_summary === "string"
      ? truncate(cleanText(value.decision_summary), 240)
      : "";
  const primaryRecommendation = sanitizeGiftDecision(
    value.primary_recommendation,
  );
  const procurementBrief = sanitizeProcurementBrief(value.procurement_brief);
  const backupRecommendations = Array.isArray(value.backup_recommendations)
    ? value.backup_recommendations.map(sanitizeGiftDecision).filter(isGiftDecision)
    : [];
  const followUpMessage =
    typeof value.follow_up_message === "string"
      ? truncate(cleanText(value.follow_up_message), 260)
      : "";
  const riskNotes = Array.isArray(value.risk_notes)
    ? value.risk_notes
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => truncate(cleanText(item), 120))
        .slice(0, 4)
    : [];
  const ctaMessage =
    typeof value.cta_message === "string"
      ? truncate(cleanText(value.cta_message), 24)
      : "想再细化一版礼物建议，可以加我微信";

  if (
    !decisionSummary ||
    !primaryRecommendation ||
    !procurementBrief ||
    backupRecommendations.length !== 2 ||
    !followUpMessage ||
    riskNotes.length < 2
  ) {
    throw new Error("AI 返回内容不完整");
  }

  return {
    customer_summary: profile.customer_summary,
    decision_summary: decisionSummary,
    analysis_confidence: profile.confidence,
    analysis_gaps: profile.gaps.slice(0, 3),
    evidence_highlights: profile.evidence_highlights,
    recipient_role: profile.recipient_role,
    target_region: profile.target_region,
    primary_recommendation: primaryRecommendation,
    procurement_brief: procurementBrief,
    backup_recommendations: backupRecommendations,
    follow_up_message: followUpMessage,
    risk_notes: riskNotes,
    source_summary: [],
    cta_message: ctaMessage,
    mode: "ai",
  };
}

async function generateDecisionWithOpenAI(input: {
  profile: CustomerProfileContext;
  sources: FetchedSource[];
  occasion: Occasion;
  budgetTier: BudgetTier;
  note?: string;
}) {
  const occasionMeta = getOccasionMeta(input.occasion);
  const budgetMeta = getBudgetMeta(input.budgetTier);

  return sanitizeDecisionPayload(
    await callOpenAIJson(DECISION_SYSTEM_PROMPT, {
      customer_profile: {
        customer_summary: input.profile.customer_summary,
        industry_signal: input.profile.industry_signal,
        brand_tone: input.profile.brand_tone,
        gift_signal: input.profile.gift_signal,
        human_signal: input.profile.human_signal,
        human_clue_count: input.profile.human_clue_count,
        confidence: input.profile.confidence,
        gaps: input.profile.gaps,
        evidence_highlights: input.profile.evidence_highlights,
        recipient_role: input.profile.recipient_role,
        target_region: input.profile.target_region,
      },
      occasion: {
        value: input.occasion,
        label: occasionMeta.label,
        hint: occasionMeta.hint,
        decision_goal: occasionMeta.decision_goal,
        timing_note: occasionMeta.timing_note,
      },
      budget: {
        value: input.budgetTier,
        label: budgetMeta.label,
        hint: budgetMeta.hint,
        price_band: budgetMeta.price_band,
      },
      note: input.note?.trim() || "",
      sources: input.sources.map((source) => ({
        url: source.url,
        kind: source.kind,
        evidence: source.evidence,
      })),
    }),
    input.profile,
  );
}

function inferGiftItemType(name: string) {
  if (/托盘|收纳/.test(name)) {
    return "桌面收纳类";
  }

  if (/书签/.test(name)) {
    return "金属书签类";
  }

  if (/笔记本|纸卡|小册|期刊|地图册|书票/.test(name)) {
    return "纸品 / 出版物类";
  }

  if (/纸镇|书挡|摆件|礼片/.test(name)) {
    return "桌面摆件类";
  }

  if (/礼盒|礼套|套装|卡组|样本盒|样本册/.test(name)) {
    return "轻量礼盒类";
  }

  return "轻量商务礼品";
}

function fallbackTargetUnitPrice(
  budgetTier: BudgetTier,
  position: 0 | 1 | 2,
) {
  if (budgetTier === "100_300_cny") {
    return position === 0 ? "单份建议 180-260 元" : "单份建议 120-240 元";
  }

  if (budgetTier === "800_1500_cny") {
    return position === 0 ? "单份建议 900-1280 元" : "单份建议 820-1180 元";
  }

  return position === 0 ? "单份建议 380-680 元" : "单份建议 320-620 元";
}

function fallbackLeadTime(name: string) {
  if (/书签|笔记本|纸卡|小册|期刊|地图册/.test(name)) {
    return "现货通常 2-5 天；轻定制 5-7 天";
  }

  if (/纸镇|书挡|摆件|黄铜/.test(name)) {
    return "现货通常 5-8 天；轻定制 7-12 天";
  }

  if (/礼盒|礼套|样本盒|样本册|套装/.test(name)) {
    return "现货组套 3-6 天；轻定制 6-10 天";
  }

  return "现货通常 3-6 天；轻定制 6-9 天";
}

function fallbackCustomizationLevel(name: string) {
  if (/黄铜|纸镇|书挡|摆件/.test(name)) {
    return "低到中，尽量不要刻客户 logo，只保留简洁说明卡";
  }

  return "低，优先现货或轻包装，不建议重定制";
}

function fallbackShippingEase(name: string, targetRegion: string) {
  const regionText =
    targetRegion === DEFAULT_TARGET_REGION ? "常见欧美市场" : targetRegion;

  if (/黄铜|纸镇|书挡|摆件/.test(name)) {
    return `中，重量略高；寄往 ${regionText} 时要控制尺寸和包装。`;
  }

  if (/纸卡|笔记本|小册|期刊|书签/.test(name)) {
    return `高，轻巧且清关风险低；寄往 ${regionText} 更稳。`;
  }

  return `中到高，优先选无液体、无电池、无木质检疫争议的版本寄往 ${regionText}。`;
}

function fallbackSourcingTip(name: string) {
  if (/笔记本|小册|期刊|书票|纸卡/.test(name)) {
    return "优先找设计文具、独立出版物或成熟纸品供应商，不要临时拼凑套装。";
  }

  if (/黄铜|纸镇|书挡|摆件/.test(name)) {
    return "优先找有现货的小型桌面器物供应商，确认重量、包装和打样周期。";
  }

  if (/托盘|收纳/.test(name)) {
    return "优先找办公器物或家居设计品牌的现货款，别自己开发结构。";
  }

  return "优先找有现货、可直接小批量下单的成熟供应商，不要从零开模。";
}

function fallbackApprovalHint(
  recipientRole: string,
  budgetTier: BudgetTier,
) {
  const budgetText = getBudgetMeta(budgetTier).label;

  if (recipientRole.includes("采购")) {
    return `给内部确认时重点强调 ${budgetText} 内、低运输风险、可快速下单。`;
  }

  if (recipientRole.includes("品牌") || recipientRole.includes("市场")) {
    return `给内部确认时重点强调审美一致、表达克制、不会像展会赠品。`;
  }

  if (recipientRole.includes("老板") || recipientRole.includes("创始")) {
    return `给内部确认时重点强调体面但不过重，能体现你做过功课且预算可控。`;
  }

  return `给老板或同事确认时重点强调 ${budgetText} 内、轻巧、好寄送、不过度私人化。`;
}

function fallbackExecutionMode(
  profile: CustomerProfileContext,
  name: string,
  budgetTier: BudgetTier,
) {
  if (profile.confidence === "low") {
    return "只走现货保守版，不建议先做重定制或复杂礼盒。";
  }

  if (/黄铜|纸镇|书挡|摆件|礼盒/.test(name) || budgetTier === "800_1500_cny") {
    return "先确认现货或基础款，再决定是否做 1 套轻定制样。";
  }

  if (profile.confidence === "medium") {
    return "优先现货加轻包装版本，先把可执行性和交期定住。";
  }

  return "可直接按现货或轻定制版本同步推进，不必先做复杂打样。";
}

function fallbackRecommendedQuantity(
  occasion: Occasion,
  budgetTier: BudgetTier,
) {
  if (occasion === "trade_show_follow_up") {
    if (budgetTier === "100_300_cny") {
      return "首轮先做 3-5 份，优先给展会后最值得跟进的客户。";
    }

    if (budgetTier === "800_1500_cny") {
      return "首轮先做 1-2 份，只给最重点客户，不要铺开。";
    }

    return "首轮先做 2-3 份，留一份备用，先跑重点客户。";
  }

  if (budgetTier === "100_300_cny") {
    return "先做 2 份，1 份正式使用，1 份备用或防止运输损耗。";
  }

  return "先做 1-2 份即可，不建议为了稳妥一次下太多。";
}

function fallbackSamplePlan(
  profile: CustomerProfileContext,
  name: string,
) {
  if (/书签|纸卡|小册|期刊|书票/.test(name) && profile.confidence === "high") {
    return "先看现货实拍、尺寸和包装图，确认无误后可直接下单。";
  }

  if (profile.confidence === "low" || /黄铜|纸镇|书挡|摆件|礼盒/.test(name)) {
    return "先拿现货图或做 1 套轻定制样，再确认是否批量。";
  }

  return "先看现货图，必要时补 1 套轻包装样，不建议走完整开发流程。";
}

function fallbackPackagingPlan(
  occasion: Occasion,
  budgetTier: BudgetTier,
) {
  const base =
    budgetTier === "800_1500_cny"
      ? "简洁硬盒加说明卡即可，重点是质感，不是做厚重礼箱。"
      : "单品加说明卡或薄礼盒即可，不要做体积大、运输成本高的包装。";

  if (occasion === "client_visit") {
    return `${base} 还要保证客户当天方便带走。`;
  }

  if (occasion === "trade_show_follow_up") {
    return `${base} 包装优先考虑快递稳定和防压。`;
  }

  return `${base} 包装风格保持克制，避免第一次见面就显得太重。`;
}

function fallbackBrandingNote(recipientRole: string) {
  if (recipientRole.includes("品牌") || recipientRole.includes("市场")) {
    return "不建议直接打客户 logo，可做克制腰封或说明卡，重点放在理由解释上。";
  }

  return "默认不要打客户 logo，最多保留说明卡或外贴签，避免像促销赠品。";
}

function buildFallbackProcurementBrief(input: {
  primary: GiftIdeaWithReasoning;
  profile: CustomerProfileContext;
  occasion: Occasion;
  budgetTier: BudgetTier;
}): ProcurementBrief {
  const executionMode = fallbackExecutionMode(
    input.profile,
    input.primary.name,
    input.budgetTier,
  );
  const recommendedQuantity = fallbackRecommendedQuantity(
    input.occasion,
    input.budgetTier,
  );
  const samplePlan = fallbackSamplePlan(input.profile, input.primary.name);
  const packagingPlan = fallbackPackagingPlan(input.occasion, input.budgetTier);
  const brandingNote = fallbackBrandingNote(input.profile.recipient_role);
  const supplierMessage = truncate(
    [
      `先按「${input.primary.name}」询价。`,
      `单价先按 ${input.primary.target_unit_price} 控制。`,
      input.primary.lead_time,
      `执行方式：${executionMode}`,
      `数量：${recommendedQuantity}`,
      `包装：${packagingPlan}`,
      `品牌处理：${brandingNote}`,
      `供应商方向：${input.primary.sourcing_tip}`,
    ].join(" "),
    220,
  );

  return {
    execution_mode: executionMode,
    recommended_quantity: recommendedQuantity,
    sample_plan: samplePlan,
    packaging_plan: packagingPlan,
    branding_note: brandingNote,
    supplier_message: supplierMessage,
  };
}

function buildFallbackGift(
  name: string,
  position: 0 | 1 | 2,
  profile: CustomerProfileContext,
  occasion: Occasion,
  budgetTier: BudgetTier,
): GiftIdeaWithReasoning {
  const occasionMeta = getOccasionMeta(occasion);
  const budgetMeta = getBudgetMeta(budgetTier);

  return {
    name,
    item_type: inferGiftItemType(name),
    reason:
      position === 0
        ? `它最贴合客户当前呈现出的“${profile.industry_signal}”特征，也最容易让对方感受到你做过功课。`
        : `它仍然围绕客户的“${profile.industry_signal}”线索展开，但角度和主推荐明显不同，适合作为备选。`,
    why_now:
      position === 0
        ? `${occasionMeta.label}这个时点最怕套路和过重，这类礼物更容易自然延续前一次接触的记忆。`
        : `如果你不想走主推荐的路线，这个方向在${occasionMeta.label}里依然成立，而且不容易显得用力过猛。`,
    budget_fit:
      position === 0
        ? `${budgetMeta.label}更适合做“看得出判断力但不会太重”的礼物，这个选择和当前预算带匹配度最高。`
        : `${budgetMeta.label}下它依然能成立，但更适合你想保留一点差异化时使用。`,
    target_unit_price: fallbackTargetUnitPrice(budgetTier, position),
    lead_time: fallbackLeadTime(name),
    customization_level: fallbackCustomizationLevel(name),
    shipping_ease: fallbackShippingEase(name, profile.target_region),
    sourcing_tip: fallbackSourcingTip(name),
    approval_hint: fallbackApprovalHint(profile.recipient_role, budgetTier),
    caution: profile.matched_profile.cautions[position],
    message_snippet:
      position === 0
        ? `如果只先定一个礼物，我会优先选「${name}」，因为它和客户目前的品牌/业务表达最贴近，而且适合现在这个时机。`
        : `如果主推荐不方便落地，可以改成「${name}」，方向仍然贴合客户，但表达方式会更克制一些。`,
  };
}

function buildFallbackFollowUpMessage(
  occasion: Occasion,
  primaryName: string,
  industrySignal: string,
) {
  if (occasion === "first_visit") {
    return `可以这样沟通：下周正式拜访前，我一直在想带什么小礼物更合适。后来想到「${primaryName}」这个方向，不会太重，但能更贴近你们现在的品牌表达，也比较符合 ${industrySignal} 这类线索。`;
  }

  if (occasion === "client_visit") {
    return `可以这样沟通：知道你们这次要来访，我想准备一个不夸张但有记忆点的小礼物。后来想到「${primaryName}」这个方向，方便带走，也更贴近你们现在的品牌表达和 ${industrySignal} 这类线索。`;
  }

  return `可以这样跟进：展会上和您聊完后，我一直在想什么小礼物会更贴近你们现在的品牌表达。后来我想到「${primaryName}」这个方向，不重，但比较有记忆点，也更符合 ${industrySignal} 这类线索。`;
}

function buildFallbackAnalysis(input: {
  profile: CustomerProfileContext;
  sourceSummary: SourceSummary[];
  occasion: Occasion;
  budgetTier: BudgetTier;
}): AnalyzeResponse {
  const occasionMeta = getOccasionMeta(input.occasion);
  const budgetMeta = getBudgetMeta(input.budgetTier);
  const giftNames = input.profile.matched_profile.gifts[input.budgetTier];
  const primary = buildFallbackGift(
    giftNames[0],
    0,
    input.profile,
    input.occasion,
    input.budgetTier,
  );
  const procurementBrief = buildFallbackProcurementBrief({
    primary,
    profile: input.profile,
    occasion: input.occasion,
    budgetTier: input.budgetTier,
  });
  const backups = [
    buildFallbackGift(
      giftNames[1],
      1,
      input.profile,
      input.occasion,
      input.budgetTier,
    ),
    buildFallbackGift(
      giftNames[2],
      2,
      input.profile,
      input.occasion,
      input.budgetTier,
    ),
  ];
  const conservativeNote =
    input.profile.gaps.length > 0
      ? "本次公开信息有限，所以主推荐偏保守，但执行风险更低。"
      : "主推荐优先考虑好执行、好寄送和当前场景下的实际落地性。";

  return {
    customer_summary: input.profile.customer_summary,
    decision_summary: truncate(
      `如果只先定一个礼物，优先选「${primary.name}」。它最贴近客户当前呈现出的“${input.profile.industry_signal}”线索，也更适合 ${occasionMeta.label} 这个时机。${conservativeNote}`,
      240,
    ),
    analysis_confidence: input.profile.confidence,
    analysis_gaps: input.profile.gaps.slice(0, 3),
    evidence_highlights: input.profile.evidence_highlights,
    recipient_role: input.profile.recipient_role,
    target_region: input.profile.target_region,
    primary_recommendation: primary,
    procurement_brief: procurementBrief,
    backup_recommendations: backups,
    follow_up_message: truncate(
      buildFallbackFollowUpMessage(
        input.occasion,
        primary.name,
        input.profile.industry_signal,
      ),
      260,
    ),
    risk_notes: [
      occasionMeta.timing_note,
      `${budgetMeta.label}：${budgetMeta.hint}`,
      input.profile.matched_profile.cautions[0],
      ...(input.profile.gaps.length > 0 ? [input.profile.gaps[0]] : []),
    ].slice(0, 4),
    source_summary: input.sourceSummary,
    cta_message: "想再细化一版礼物建议，可以加我微信",
    mode: "fallback",
  };
}

export async function createSerendipityAnalysis(input: {
  customerInput?: string;
  companyName?: string;
  links?: string[];
  occasion?: Occasion;
  budgetTier?: BudgetTier;
  recipientRole?: string;
  targetRegion?: string;
  note?: string;
  personTraits?: string[];
  personInterests?: string[];
  recentChat?: string;
  personImpression?: string;
}): Promise<AnalyzeResponse> {
  const customerInput = input.customerInput?.trim() ?? "";
  const links = normalizeLinks(
    [
      ...(input.links ?? []),
      ...extractLinksFromCustomerInput(customerInput, SOURCE_LIMIT),
    ],
    SOURCE_LIMIT,
  );
  const occasion = input.occasion ?? DEFAULT_OCCASION;
  const budgetTier = input.budgetTier ?? DEFAULT_BUDGET_TIER;
  const recipientRole = normalizeRecipientRole(input.recipientRole);
  const targetRegion = normalizeTargetRegion(input.targetRegion);
  const personTraits = normalizeHumanLabels(input.personTraits);
  const personInterests = normalizeHumanLabels(input.personInterests);
  const recentChat = input.recentChat?.trim()
    ? truncate(cleanText(input.recentChat), 420)
    : undefined;
  const personImpression = input.personImpression?.trim()
    ? truncate(cleanText(input.personImpression), 220)
    : undefined;
  const companyName = truncate(
    cleanText(input.companyName?.trim() || guessCompanyName(customerInput, links) || ""),
    80,
  );

  if (links.length === 0 && !customerInput && !companyName) {
    throw new Error("请至少提供公司名、官网、邮箱域名、社媒链接中的任意一种信息");
  }

  const fetchedSources =
    links.length > 0 ? await Promise.all(links.map((link) => fetchSource(link))) : [];
  const manualSource = buildManualSource({
    customerInput,
    companyName,
    recipientRole,
    targetRegion,
    note: input.note,
    personTraits,
    personInterests,
    recentChat,
    personImpression,
  });
  const sourceSummary: SourceSummary[] = [
    ...fetchedSources.map((source) => ({
      url: source.url,
      label: source.label,
      status: source.status,
      evidence: truncate(source.evidence, 180),
    })),
    ...(manualSource
      ? [
          {
            url: manualSource.url,
            label: manualSource.label,
            status: manualSource.status,
            evidence: truncate(manualSource.evidence, 180),
          },
        ]
      : []),
  ];
  const usableSources = fetchedSources.filter(
    (source) => source.status === "used" && source.content.trim().length > 0,
  );

  if (manualSource) {
    usableSources.push(manualSource);
  }

  if (usableSources.length === 0) {
    throw new Error("这些信息暂时无法分析，请优先提供官网首页、邮箱域名或 LinkedIn 链接");
  }

  const profile = buildCustomerProfileContext(
    usableSources,
    occasion,
    recipientRole,
    targetRegion,
    personTraits,
    personInterests,
    recentChat,
    personImpression,
    input.note,
  );

  try {
    const aiResult = await generateDecisionWithOpenAI({
      profile,
      sources: usableSources,
      occasion,
      budgetTier,
      note: input.note,
    });

    return {
      ...aiResult,
      source_summary: sourceSummary,
      mode: "ai",
    };
  } catch (error) {
    if (!resolveOpenAIConfig()) {
      throw new Error(
        "服务暂未配置 AI 能力，请在 Vercel 项目环境变量中设置 OPENAI_API_KEY 后再试。",
      );
    }

    console.error("[analyze] falling back to heuristic mode", error);

    return buildFallbackAnalysis({
      profile,
      sourceSummary,
      occasion,
      budgetTier,
    });
  }
}
