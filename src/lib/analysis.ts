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
import { resolveOpenAIConfig, shouldSkipOpenAI } from "./openai-config";
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
  quality: "strong" | "weak";
}

interface FallbackProfile {
  label: string;
  tone: string;
  summary_hint: string;
  keywords: string[];
  evidence_hint: string;
  gifts: Record<BudgetTier, [FallbackGiftBlueprint, FallbackGiftBlueprint, FallbackGiftBlueprint]>;
  cautions: [string, string, string];
}

interface FallbackGiftBlueprint {
  name: string;
  item_type: string;
  components: [string, string, string?];
  anchor_tags: string[];
  unexpected_hook: string;
  novelty_hook: string;
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
  recipient_anchors: string[];
  recipient_role: string;
  target_region: string;
  matched_profile: FallbackProfile;
}

const SOURCE_LIMIT = 5;
const FETCH_TIMEOUT_MS = 8_000;
const AI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 18_000);
const MAX_SOURCE_CHARS = 2_200;
const AI_SOURCE_LIMIT = 3;
const AI_SOURCE_EVIDENCE_MAX_CHARS = 900;
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

function createGiftBlueprint(input: {
  name: string;
  itemType: string;
  components: [string, string, string?];
  anchorTags: string[];
  unexpectedHook: string;
  noveltyHook: string;
}): FallbackGiftBlueprint {
  return {
    name: input.name,
    item_type: input.itemType,
    components: input.components,
    anchor_tags: input.anchorTags,
    unexpected_hook: input.unexpectedHook,
    novelty_hook: input.noveltyHook,
  };
}

const DECISION_SYSTEM_PROMPT = `
你是一个给中国外贸业务员使用的商务送礼决策助手。

你的目标不是展示分析能力，而是帮助业务员在特定场景下尽快做决定并执行。

你这次必须严格按 serendipity 逻辑来生成礼物。这里的 serendipity 不是“猎奇”，而是同时满足：
- Relevant：和这个客户的公司、岗位、当前业务语境或人的线索真的相关
- Unexpected：不是客户一眼就会觉得“又是常规商务礼物”的东西
- Novelty：对客户来说有一点新鲜感，但又不至于冒犯、太私人或太难解释

最终主推荐必须先经过这三个维度，再加一道商务可执行性判断：
- Business Fit：预算、寄送、审批、定制、交期都讲得通

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
- 主推荐不能只因为安全就胜出。它必须同时证明自己为什么 relevant、unexpected、novel，然后才因为 business fit 成为最终答案。
- 主推荐优先考虑“现在就能送、容易执行、不会翻车”，但不能退化成普通目录货。
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
- 如果信息不足，允许 unexpected 和 novelty 做得更克制，但不能不解释。
- 你要优先寻找“对方会觉得你观察到了什么”的切入点，而不是“什么礼物最体面”。

JSON 结构必须严格如下：
{
  "decision_summary": "string",
  "primary_recommendation": {
    "name": "string",
    "item_type": "string",
    "gift_components": ["string"],
    "reason": "string",
    "why_relevant": "string",
    "why_unexpected": "string",
    "why_novel": "string",
    "business_fit": "string",
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
      "gift_components": ["string"],
      "reason": "string",
      "why_relevant": "string",
      "why_unexpected": "string",
      "why_novel": "string",
      "business_fit": "string",
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
- why_relevant 要说明它和客户/岗位/人的线索具体对应在哪里，不能只说“比较适合”
- why_unexpected 要解释它为什么不是套模板的常规礼物，但仍然商务安全
- why_novel 要解释它对对方可能的新鲜感来自哪里，不能写空话
- business_fit 要把审批、预算、寄送、交期或定制上的现实可执行性说清楚
- gift_components 要写成这份礼物实际由哪几个部分组成，优先 2 到 4 个组件
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
        createGiftBlueprint({
          name: "品牌主题金属书签礼套",
          itemType: "金属书签类",
          components: ["金属书签", "品牌观察说明卡", "薄信封套"],
          anchorTags: ["品牌感", "专业表达", "轻量不出错"],
          unexpectedHook: "不是常见目录式赠品，而是把客户当下的品牌表达压缩成一个很轻的小物件。",
          noveltyHook: "新鲜感来自它像你做过一轮品牌观察，而不是随手买了一个通用品。",
        }),
        createGiftBlueprint({
          name: "压纹便携卡包礼套",
          itemType: "轻量商务礼品",
          components: ["压纹便携卡包", "品牌故事卡", "薄包装盒"],
          anchorTags: ["专业感", "日常会用", "不夸张"],
          unexpectedHook: "比通用名片夹更克制，也不会像促销品。",
          noveltyHook: "新鲜感来自材质和压纹细节，而不是靠大面积定制制造存在感。",
        }),
        createGiftBlueprint({
          name: "独立设计纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["独立设计纸品", "短说明卡", "薄外封"],
          anchorTags: ["表达感", "专业判断", "轻巧好带"],
          unexpectedHook: "比一般商务文具更有观察感，但又不跨到过于私人。",
          noveltyHook: "新鲜感来自内容与纸张选择，而不是礼盒体积。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "黄铜桌面名片托礼盒",
          itemType: "桌面摆件类",
          components: ["黄铜名片托", "品牌观察说明卡", "轻礼盒"],
          anchorTags: ["桌面使用场景", "专业感", "来访可带走"],
          unexpectedHook: "它比通用办公礼更有克制的质感，但不会重到像摆阔。",
          noveltyHook: "新鲜感来自桌面使用场景和你对客户职业身份的匹配判断。",
        }),
        createGiftBlueprint({
          name: "石材桌面纸镇礼套",
          itemType: "桌面摆件类",
          components: ["石材纸镇", "定制外卡", "简洁内托"],
          anchorTags: ["稳定感", "克制", "办公场景"],
          unexpectedHook: "它不是常规目录货，更像一个被认真挑过的桌面器物。",
          noveltyHook: "新鲜感来自材质触感和桌面留存感，而不是 logo 定制。",
        }),
        createGiftBlueprint({
          name: "独立设计文具礼盒",
          itemType: "轻量礼盒类",
          components: ["设计文具单品", "短说明卡", "礼盒外封"],
          anchorTags: ["专业表达", "轻礼盒", "易审批"],
          unexpectedHook: "比普通文具更像一种审美判断，而不是行政采购。",
          noveltyHook: "新鲜感来自组合方式和说明逻辑，不是堆数量。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "黄铜桌面器物礼盒",
          itemType: "轻量礼盒类",
          components: ["黄铜桌面器物", "品牌观察卡", "硬盒"],
          anchorTags: ["高质感", "判断力", "克制高级"],
          unexpectedHook: "它会让人感觉你在挑一件会留在桌上的物件，而不是一次性礼物。",
          noveltyHook: "新鲜感来自器物感和留存感，比高价但没记忆点的礼盒更有效。",
        }),
        createGiftBlueprint({
          name: "皮质卡包与桌面托盘套装",
          itemType: "轻量礼盒类",
          components: ["皮质卡包", "桌面托盘", "说明卡"],
          anchorTags: ["日常使用", "专业场景", "高级但不夸张"],
          unexpectedHook: "它不是典型成套商务赠品，而是偏向个人工作场景的组合。",
          noveltyHook: "新鲜感来自两个小件之间的使用关系，而不是单个高客单品。",
        }),
        createGiftBlueprint({
          name: "设计文具与出版物组合礼盒",
          itemType: "轻量礼盒类",
          components: ["设计文具", "小型出版物", "礼盒外封"],
          anchorTags: ["内容感", "审美感", "表达层次"],
          unexpectedHook: "它不靠价格压人，而是靠内容和表达层次被记住。",
          noveltyHook: "新鲜感来自器物和内容的并置，比纯摆件更有故事。",
        }),
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
        createGiftBlueprint({
          name: "品牌色金属书签礼套",
          itemType: "金属书签类",
          components: ["品牌色书签", "纸卡", "薄封套"],
          anchorTags: ["颜色敏感", "审美表达", "轻礼"],
          unexpectedHook: "它不是常规书签，而是把客户品牌语气转成了一个克制的小礼物。",
          noveltyHook: "新鲜感来自颜色和材质的呼应，而不是大面积品牌化。",
        }),
        createGiftBlueprint({
          name: "材质样片卡套",
          itemType: "纸品 / 出版物类",
          components: ["材质样片卡", "说明小卡", "收纳卡套"],
          anchorTags: ["材质敏感", "观察力", "低调"],
          unexpectedHook: "它更像是在回应对方对材质和细节的敏感，而不是送一个通用品。",
          noveltyHook: "新鲜感来自触感体验和观察逻辑，容易让对方觉得你做了功课。",
        }),
        createGiftBlueprint({
          name: "独立视觉纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["独立视觉纸品", "短说明卡", "薄外封"],
          anchorTags: ["内容感", "视觉语言", "不俗气"],
          unexpectedHook: "它比普通设计文具更像一个明确的审美判断。",
          noveltyHook: "新鲜感来自内容选择，而不是礼物本身的贵重感。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "材质样片礼盒",
          itemType: "轻量礼盒类",
          components: ["材质样片组", "说明卡", "轻礼盒"],
          anchorTags: ["材质", "陈列", "审美判断"],
          unexpectedHook: "它不是典型商务礼物，而是明显回应了对方对材质和陈列语言的关注。",
          noveltyHook: "新鲜感来自可触摸的材质体验，比抽象地讲设计更有效。",
        }),
        createGiftBlueprint({
          name: "黄铜桌面摆件礼套",
          itemType: "桌面摆件类",
          components: ["黄铜摆件", "城市主题外卡", "薄礼盒"],
          anchorTags: ["桌面陈列", "材质感", "低调高级"],
          unexpectedHook: "它不是旅游纪念品式的城市元素，而是克制地借城市语境做了一点连接。",
          noveltyHook: "新鲜感来自材质和陈列场景，比纯出版物更有停留感。",
        }),
        createGiftBlueprint({
          name: "独立设计出版物礼盒",
          itemType: "轻量礼盒类",
          components: ["设计出版物", "短说明卡", "礼盒外封"],
          anchorTags: ["阅读感", "内容感", "审美判断"],
          unexpectedHook: "它不会显得像展会礼盒，更像你真的理解对方在意内容和语气。",
          noveltyHook: "新鲜感来自内容本身，而不是只靠器物堆砌高级感。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "材质样片与黄铜桌面器物礼盒",
          itemType: "轻量礼盒类",
          components: ["材质样片组", "黄铜桌面器物", "说明卡"],
          anchorTags: ["材质敏感", "陈列", "高级但克制"],
          unexpectedHook: "它不是纯摆件，也不是纯样本，而是把审美和触感体验做成一个组合。",
          noveltyHook: "新鲜感来自‘可触摸的材质判断 + 可留存的桌面器物’这对组合。",
        }),
        createGiftBlueprint({
          name: "黄铜摆件与出版物组合礼盒",
          itemType: "轻量礼盒类",
          components: ["黄铜摆件", "小型出版物", "礼盒外封"],
          anchorTags: ["内容", "器物", "表达层次"],
          unexpectedHook: "它不只是摆件，更像你在替对方组合一个有语气的桌面场景。",
          noveltyHook: "新鲜感来自内容和器物之间的关系，而不是单件高价。",
        }),
        createGiftBlueprint({
          name: "高质感设计文具礼盒",
          itemType: "轻量礼盒类",
          components: ["设计文具单品", "说明卡", "礼盒外封"],
          anchorTags: ["日常使用", "设计感", "易落地"],
          unexpectedHook: "它比一般文具礼盒更克制，能保留一点设计判断，但不过度用力。",
          noveltyHook: "新鲜感来自细节和搭配，而不是夸张包装。",
        }),
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
        createGiftBlueprint({
          name: "极简金属书签礼套",
          itemType: "金属书签类",
          components: ["极简金属书签", "逻辑卡片", "薄封套"],
          anchorTags: ["理性", "结构感", "轻量"],
          unexpectedHook: "它不是通用办公用品，而是更像回应对方理性和系统化表达的小物件。",
          noveltyHook: "新鲜感来自结构感和信息感，而不是夸张包装。",
        }),
        createGiftBlueprint({
          name: "便携工具感纸品套装",
          itemType: "纸品 / 出版物类",
          components: ["工具感纸品", "说明卡", "薄外封"],
          anchorTags: ["效率", "工具感", "低风险"],
          unexpectedHook: "它避开了数码配件那种廉价感，转而用纸品表达工具性。",
          noveltyHook: "新鲜感来自使用语境，而不是把礼物做成科技周边。",
        }),
        createGiftBlueprint({
          name: "结构线稿桌面小卡套",
          itemType: "轻量商务礼品",
          components: ["结构线稿卡套", "短说明卡", "轻包装"],
          anchorTags: ["结构感", "工程感", "轻巧"],
          unexpectedHook: "它不重，也不俗，但能让对方感到你有意识地回应了工程和结构线索。",
          noveltyHook: "新鲜感来自图形逻辑和桌面场景的结合。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "金属桌面纸镇礼套",
          itemType: "桌面摆件类",
          components: ["金属纸镇", "结构说明卡", "简洁包装"],
          anchorTags: ["桌面使用", "理性", "稳定感"],
          unexpectedHook: "它不是普通摆件，而是借桌面器物回应对方的理性和结构偏好。",
          noveltyHook: "新鲜感来自手感和长期留桌的使用场景。",
        }),
        createGiftBlueprint({
          name: "极简桌面摆件礼套",
          itemType: "桌面摆件类",
          components: ["极简摆件", "工程风包装卡", "薄礼盒"],
          anchorTags: ["极简", "工程感", "商务安全"],
          unexpectedHook: "它比传统商务礼物更有态度，但不会像创意礼物那样失控。",
          noveltyHook: "新鲜感来自极简器物和工程语气之间的连接。",
        }),
        createGiftBlueprint({
          name: "逻辑谜题桌面礼盒",
          itemType: "轻量礼盒类",
          components: ["逻辑谜题件", "说明卡", "礼盒外封"],
          anchorTags: ["互动感", "理性趣味", "记忆点"],
          unexpectedHook: "它会让对方觉得你不是在送礼品目录，而是在送一个能被记住的思路。",
          noveltyHook: "新鲜感来自一点点可参与感，但仍然保持商务边界。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "黄铜纸镇与工具感礼盒",
          itemType: "轻量礼盒类",
          components: ["黄铜纸镇", "工具感说明卡", "硬盒"],
          anchorTags: ["高质感", "理性", "器物感"],
          unexpectedHook: "它不是廉价科技风周边，而是把理性气质落到一个能留桌的器物上。",
          noveltyHook: "新鲜感来自金属器物和工具感叙事的结合。",
        }),
        createGiftBlueprint({
          name: "桌面摆件与逻辑卡组礼盒",
          itemType: "轻量礼盒类",
          components: ["桌面摆件", "逻辑卡组", "礼盒外封"],
          anchorTags: ["内容", "桌面场景", "结构感"],
          unexpectedHook: "它比单独摆件多了一层内容关系，更像专门为这个人搭过。",
          noveltyHook: "新鲜感来自器物和卡组之间的组合感。",
        }),
        createGiftBlueprint({
          name: "工程风桌面器物套装",
          itemType: "轻量礼盒类",
          components: ["桌面器物", "结构说明卡", "套装包装"],
          anchorTags: ["工程感", "克制", "高可执行"],
          unexpectedHook: "它不会像技术周边那样俗，却能让工程背景的人感到被理解。",
          noveltyHook: "新鲜感来自工程语气被翻译成日常器物。",
        }),
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
        createGiftBlueprint({
          name: "再生材质金属书签礼套",
          itemType: "金属书签类",
          components: ["再生材质书签", "材料故事卡", "薄封套"],
          anchorTags: ["责任感", "长期主义", "轻量"],
          unexpectedHook: "它不是泛环保周边，而是把可持续材料做成一个克制的小物件。",
          noveltyHook: "新鲜感来自材料故事本身，而不是口号。",
        }),
        createGiftBlueprint({
          name: "环保材质样片卡套",
          itemType: "纸品 / 出版物类",
          components: ["环保材质样片卡", "说明卡", "卡套"],
          anchorTags: ["材料关注", "触感体验", "观察力"],
          unexpectedHook: "它不是在喊环保，而是在让对方摸到你为什么选它。",
          noveltyHook: "新鲜感来自可触摸的材料体验，比一般理念类礼物更具体。",
        }),
        createGiftBlueprint({
          name: "可持续主题纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["主题纸品", "短说明卡", "薄外封"],
          anchorTags: ["克制表达", "低风险", "易传播"],
          unexpectedHook: "它比普通纸品多了一层理念回应，但又不显得 preachy。",
          noveltyHook: "新鲜感来自你把理念压缩成可留存的小内容。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "环保材质样片礼盒",
          itemType: "轻量礼盒类",
          components: ["环保材质样片", "材料故事卡", "轻礼盒"],
          anchorTags: ["材料判断", "Buyer 友好", "好解释"],
          unexpectedHook: "它不像常规商务礼盒，更像你在回应对方最近关心的材料判断。",
          noveltyHook: "新鲜感来自‘你真的注意到我在看什么材料’这层感觉。",
        }),
        createGiftBlueprint({
          name: "再生材质桌面托盘礼套",
          itemType: "桌面收纳类",
          components: ["再生材质托盘", "说明卡", "简洁包装"],
          anchorTags: ["桌面场景", "责任感", "日常可用"],
          unexpectedHook: "它不是廉价环保周边，而是一个能日常使用的克制器物。",
          noveltyHook: "新鲜感来自责任感被做成可用物件，而不是概念说明。",
        }),
        createGiftBlueprint({
          name: "可持续材料展示册礼盒",
          itemType: "轻量礼盒类",
          components: ["材料展示册", "短说明卡", "礼盒外封"],
          anchorTags: ["内容感", "材料导向", "可传播"],
          unexpectedHook: "它比纯样片更完整，也比纯摆件更贴近对方当下关注点。",
          noveltyHook: "新鲜感来自把材料故事讲成了一个完整的小组合。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "再生材质桌面器物礼盒",
          itemType: "轻量礼盒类",
          components: ["再生材质器物", "说明卡", "硬盒"],
          anchorTags: ["高级感", "责任感", "桌面留存"],
          unexpectedHook: "它不是把环保做廉价，而是把责任感做得有质感。",
          noveltyHook: "新鲜感来自对方会发现‘可持续’也可以不说教。",
        }),
        createGiftBlueprint({
          name: "材质样片与托盘组合礼盒",
          itemType: "轻量礼盒类",
          components: ["材质样片", "桌面托盘", "说明卡"],
          anchorTags: ["触感", "使用场景", "组合感"],
          unexpectedHook: "它比单独器物或单独样片都更像一套认真搭过的礼物。",
          noveltyHook: "新鲜感来自样片和器物之间形成的完整体验。",
        }),
        createGiftBlueprint({
          name: "可持续材料展示礼盒",
          itemType: "轻量礼盒类",
          components: ["材料展示件", "说明册", "礼盒外封"],
          anchorTags: ["内容表达", "理念落地", "易沟通"],
          unexpectedHook: "它让对方看到的不是环保话术，而是具体材料判断。",
          noveltyHook: "新鲜感来自理念被翻译成可以打开、触摸、解释的礼物。",
        }),
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
        createGiftBlueprint({
          name: "工业风金属书签礼套",
          itemType: "金属书签类",
          components: ["工业风书签", "工艺卡", "薄封套"],
          anchorTags: ["工艺感", "结构感", "轻礼"],
          unexpectedHook: "它不是粗糙工业零件，而是把工艺感做得克制可送。",
          noveltyHook: "新鲜感来自工艺语气被压缩成一个精致的小件。",
        }),
        createGiftBlueprint({
          name: "材质触感样片卡套",
          itemType: "纸品 / 出版物类",
          components: ["材质触感卡", "说明卡", "卡套"],
          anchorTags: ["材料判断", "触感", "专业线索"],
          unexpectedHook: "它不是普通色卡，而是直接回应对方对工艺和材质的敏感。",
          noveltyHook: "新鲜感来自可上手的触感，而不是概念文案。",
        }),
        createGiftBlueprint({
          name: "工艺说明纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["工艺纸品", "说明卡", "薄外封"],
          anchorTags: ["内容感", "工艺叙事", "低风险"],
          unexpectedHook: "它比普通文具更像对制造背景的一次回应。",
          noveltyHook: "新鲜感来自工艺被做成可留存的小内容。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "工业材质名片托礼套",
          itemType: "桌面摆件类",
          components: ["工业材质名片托", "说明卡", "简洁包装"],
          anchorTags: ["桌面使用", "工艺感", "专业场景"],
          unexpectedHook: "它不是粗犷工业件，而是有控制感的专业桌面器物。",
          noveltyHook: "新鲜感来自材质和职业场景之间的贴合。",
        }),
        createGiftBlueprint({
          name: "金属桌面摆件工艺礼套",
          itemType: "桌面摆件类",
          components: ["金属摆件", "工艺故事卡", "薄礼盒"],
          anchorTags: ["结构感", "工艺故事", "克制"],
          unexpectedHook: "它不靠 logo 和包装堆价值，而是靠工艺语境建立记忆点。",
          noveltyHook: "新鲜感来自一个小器物背后的工艺解释。",
        }),
        createGiftBlueprint({
          name: "材料触感礼盒",
          itemType: "轻量礼盒类",
          components: ["材料触感件", "说明卡", "礼盒外封"],
          anchorTags: ["材质", "触感", "Buyer 友好"],
          unexpectedHook: "它更像给懂制造的人看的礼物，不是给大众看的商务套盒。",
          noveltyHook: "新鲜感来自可触摸的材料表达。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "工业材质桌面器物礼盒",
          itemType: "轻量礼盒类",
          components: ["工业材质器物", "说明卡", "硬盒"],
          anchorTags: ["器物感", "工艺感", "高质感"],
          unexpectedHook: "它比常规礼盒更像一个会被懂工艺的人留下来的物件。",
          noveltyHook: "新鲜感来自工艺能力被转译成桌面器物，而不是零件隐喻。",
        }),
        createGiftBlueprint({
          name: "金属摆件与材质卡组合礼盒",
          itemType: "轻量礼盒类",
          components: ["金属摆件", "材质卡", "礼盒外封"],
          anchorTags: ["组合感", "内容层次", "触感"],
          unexpectedHook: "它不是单一器物，而是把工艺观察和触感组合到一起。",
          noveltyHook: "新鲜感来自器物和材质卡形成的完整理解链条。",
        }),
        createGiftBlueprint({
          name: "工艺主题桌面礼盒",
          itemType: "轻量礼盒类",
          components: ["桌面器物", "工艺说明卡", "礼盒外封"],
          anchorTags: ["稳定交付", "结构感", "专业感"],
          unexpectedHook: "它不会像技术说明书，也不会像零件纪念品，更容易被高级客户接受。",
          noveltyHook: "新鲜感来自工艺主题被做成了可日用的桌面礼。",
        }),
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
        createGiftBlueprint({
          name: "城市主题杯垫礼套",
          itemType: "轻量商务礼品",
          components: ["城市主题杯垫", "短故事卡", "薄封套"],
          anchorTags: ["空间感", "生活方式", "轻量"],
          unexpectedHook: "它不是直接送食品，而是用空间和生活方式语言去回应对方。",
          noveltyHook: "新鲜感来自把饮食文化翻译成日常桌面小物。",
        }),
        createGiftBlueprint({
          name: "插画金属书签礼套",
          itemType: "金属书签类",
          components: ["插画书签", "故事卡", "薄封套"],
          anchorTags: ["文化感", "内容感", "好带"],
          unexpectedHook: "它比普通文创小物更克制，能传达你观察到对方的品牌氛围。",
          noveltyHook: "新鲜感来自插画和故事语气，而不是网红感。",
        }),
        createGiftBlueprint({
          name: "饮食文化纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["文化纸品", "短说明卡", "薄外封"],
          anchorTags: ["内容", "文化", "不送食品"],
          unexpectedHook: "它避开了食品运输风险，但仍然保留了生活方式语境。",
          noveltyHook: "新鲜感来自文化内容，而不是食物本身。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "城市主题杯垫礼盒",
          itemType: "轻量礼盒类",
          components: ["城市主题杯垫", "短故事卡", "礼盒外封"],
          anchorTags: ["空间", "日常使用", "轻礼盒"],
          unexpectedHook: "它不是旅游纪念品式城市元素，而是用空间语气做连接。",
          noveltyHook: "新鲜感来自日常使用场景，比摆设更自然。",
        }),
        createGiftBlueprint({
          name: "桌面闻香卡礼盒",
          itemType: "轻量礼盒类",
          components: ["闻香卡", "说明卡", "轻礼盒"],
          anchorTags: ["氛围感", "体验", "不送液体"],
          unexpectedHook: "它避开了香氛液体类风险，却保留了一点气味和空间联想。",
          noveltyHook: "新鲜感来自体验感，而不是物件贵重感。",
        }),
        createGiftBlueprint({
          name: "饮食文化出版物礼盒",
          itemType: "轻量礼盒类",
          components: ["文化出版物", "短说明卡", "礼盒外封"],
          anchorTags: ["内容感", "生活方式", "克制"],
          unexpectedHook: "它不直接送食品，但仍然回应了对方的生活方式文化语境。",
          noveltyHook: "新鲜感来自内容本身，比常规器物更容易引发交流。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "城市主题桌面杯垫礼盒",
          itemType: "轻量礼盒类",
          components: ["桌面杯垫", "城市主题卡", "硬盒"],
          anchorTags: ["空间体验", "日常使用", "低调"],
          unexpectedHook: "它不会像餐饮周边，却保留了生活方式品牌的空间感。",
          noveltyHook: "新鲜感来自城市叙事和桌面器物的结合。",
        }),
        createGiftBlueprint({
          name: "闻香卡与桌面托盘组合礼盒",
          itemType: "轻量礼盒类",
          components: ["闻香卡", "桌面托盘", "说明卡"],
          anchorTags: ["空间", "体验", "组合感"],
          unexpectedHook: "它不是单一器物，而是把空间体验和日常放置场景结合起来。",
          noveltyHook: "新鲜感来自嗅觉联想和桌面使用的双重体验。",
        }),
        createGiftBlueprint({
          name: "饮食文化与器物组合礼盒",
          itemType: "轻量礼盒类",
          components: ["文化出版物", "小型器物", "礼盒外封"],
          anchorTags: ["内容", "器物", "生活方式"],
          unexpectedHook: "它会让人觉得你理解的是对方品牌氛围，而不只是产品类别。",
          noveltyHook: "新鲜感来自文化内容和器物并置后的故事感。",
        }),
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
        createGiftBlueprint({
          name: "坐标主题金属书签礼套",
          itemType: "金属书签类",
          components: ["坐标主题书签", "路线卡片", "薄封套"],
          anchorTags: ["坐标", "流动性", "轻巧"],
          unexpectedHook: "它不是交通行业周边，而是把路线感压成了一个克制的小礼物。",
          noveltyHook: "新鲜感来自坐标和路线隐喻，而不是直白运输元素。",
        }),
        createGiftBlueprint({
          name: "地图折页纸品礼套",
          itemType: "纸品 / 出版物类",
          components: ["地图折页", "短说明卡", "薄外封"],
          anchorTags: ["全球流动", "内容感", "低风险"],
          unexpectedHook: "它不走宣传册路线，而是借地图语言做一层更轻的连接。",
          noveltyHook: "新鲜感来自路线叙事，而不是品牌定制。",
        }),
        createGiftBlueprint({
          name: "路线主题桌面小卡套",
          itemType: "轻量商务礼品",
          components: ["路线主题卡套", "说明卡", "轻包装"],
          anchorTags: ["效率", "路线感", "桌面使用"],
          unexpectedHook: "它比常规办公品多了一层流动性语义，但仍然很轻。",
          noveltyHook: "新鲜感来自路线主题被放进日常桌面场景。",
        }),
      ],
      "300_800_cny": [
        createGiftBlueprint({
          name: "坐标主题桌面纸镇",
          itemType: "桌面摆件类",
          components: ["坐标纸镇", "说明卡", "简洁包装"],
          anchorTags: ["桌面留存", "全球流动", "专业感"],
          unexpectedHook: "它不是物流宣传品，而是把坐标感做成一个能长期留桌的小器物。",
          noveltyHook: "新鲜感来自坐标和使用场景之间的连接。",
        }),
        createGiftBlueprint({
          name: "地图主题桌面摆件礼套",
          itemType: "桌面摆件类",
          components: ["地图主题摆件", "说明卡", "薄礼盒"],
          anchorTags: ["路线", "空间感", "记忆点"],
          unexpectedHook: "它不是复杂地图装饰，而是借地图语言做一个可解释的桌面物件。",
          noveltyHook: "新鲜感来自路线感被转成器物，而不是图案堆砌。",
        }),
        createGiftBlueprint({
          name: "地图出版物礼盒",
          itemType: "轻量礼盒类",
          components: ["地图出版物", "短说明卡", "礼盒外封"],
          anchorTags: ["内容", "流动性", "易传播"],
          unexpectedHook: "它比纯摆件更有内容深度，也比普通书册更有送礼感。",
          noveltyHook: "新鲜感来自内容叙事，而不是纪念品逻辑。",
        }),
      ],
      "800_1500_cny": [
        createGiftBlueprint({
          name: "坐标主题黄铜摆件礼盒",
          itemType: "轻量礼盒类",
          components: ["黄铜摆件", "坐标卡", "硬盒"],
          anchorTags: ["高级感", "坐标隐喻", "桌面留存"],
          unexpectedHook: "它不是行业周边，而是更克制地回应全球流动这个语境。",
          noveltyHook: "新鲜感来自黄铜器物和坐标隐喻的叠加。",
        }),
        createGiftBlueprint({
          name: "地图桌面器物礼盒",
          itemType: "轻量礼盒类",
          components: ["桌面器物", "地图说明卡", "礼盒外封"],
          anchorTags: ["路线", "器物感", "商务安全"],
          unexpectedHook: "它比普通桌面礼更多一层路线感，但不会像营销礼。",
          noveltyHook: "新鲜感来自内容语境和桌面器物的组合。",
        }),
        createGiftBlueprint({
          name: "路线主题出版物组合礼盒",
          itemType: "轻量礼盒类",
          components: ["路线主题出版物", "短说明卡", "礼盒外封"],
          anchorTags: ["内容层次", "全球流动", "对话感"],
          unexpectedHook: "它不是单纯器物，而是更像一个会引发对话的礼物。",
          noveltyHook: "新鲜感来自路线叙事被做成可阅读的组合。",
        }),
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
    const quality = assessSourceQuality({
      url,
      kind,
      title: primary.title,
      evidence,
    });

    return {
      url,
      kind,
      status: "used",
      title: primary.title,
      evidence,
      content: evidence,
      quality,
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
      quality: "weak",
    };
  }
}

function assessSourceQuality(input: {
  url: string;
  kind: SourceKind;
  title: string;
  evidence: string;
}): "strong" | "weak" {
  const hostname = safeHostname(input.url);
  const pathname = (() => {
    try {
      return new URL(input.url).pathname.toLowerCase();
    } catch {
      return "/";
    }
  })();
  const title = input.title.toLowerCase();
  const evidence = input.evidence.toLowerCase();

  if (input.kind === "linkedin") {
    const genericLinkedin =
      pathname === "/" ||
      pathname === "" ||
      /^\/(company\/)?$/.test(pathname) ||
      title.includes("领英企业服务") ||
      title === "linkedin";

    return genericLinkedin ? "weak" : "strong";
  }

  if (input.kind === "facebook" || input.kind === "instagram") {
    if (
      pathname === "/" ||
      title === hostname ||
      evidence.includes("log in") ||
      evidence.includes("signup")
    ) {
      return "weak";
    }
  }

  if (hostname.includes("linkedin.com") && title.includes("领英企业服务")) {
    return "weak";
  }

  if (evidence.length < 120) {
    return "weak";
  }

  return "strong";
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

  if (!config || shouldSkipOpenAI(config)) {
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

function isFastFallbackError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes("error code: 1010") ||
    message.includes("openai 403") ||
    message.includes("connect timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("the operation was aborted due to timeout")
  );
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

function buildRecipientAnchors(input: {
  matchedProfile: FallbackProfile;
  recipientRole: string;
  targetRegion: string;
  personTraits: string[];
  personInterests: string[];
  recentChat?: string;
  personImpression?: string;
}) {
  const anchors: string[] = [];

  anchors.push(`客户主线先按「${input.matchedProfile.label}」理解。`);

  if (input.recipientRole !== DEFAULT_RECIPIENT_ROLE) {
    anchors.push(`收礼人角色是「${input.recipientRole}」。`);
  }

  if (input.personTraits.length > 0) {
    anchors.push(`人物气质更偏「${input.personTraits.slice(0, 2).join(" / ")}」。`);
  }

  if (input.personInterests.length > 0) {
    anchors.push(`对方最近可能会对「${input.personInterests.slice(0, 2).join(" / ")}」有感觉。`);
  }

  if (input.recentChat?.trim()) {
    anchors.push(`最近聊过的点是「${truncate(cleanText(input.recentChat), 38)}」。`);
  }

  if (input.personImpression?.trim()) {
    anchors.push(`你的主观印象是「${truncate(cleanText(input.personImpression), 34)}」。`);
  }

  if (input.targetRegion !== DEFAULT_TARGET_REGION) {
    anchors.push(`寄送和文化边界按「${input.targetRegion}」来收。`);
  }

  return anchors.slice(0, 5);
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
    quality: "strong" as const,
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
    (source) =>
      source.url !== MANUAL_SOURCE_URL &&
      source.status === "used" &&
      source.quality === "strong",
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
  const strongPublicSources = sources.filter(
    (source) =>
      source.url !== MANUAL_SOURCE_URL &&
      source.status === "used" &&
      source.quality === "strong",
  );
  const weakPublicSources = sources.filter(
    (source) =>
      source.url !== MANUAL_SOURCE_URL &&
      source.status === "used" &&
      source.quality === "weak",
  );
  const titles = sources
    .map((source) => source.title)
    .filter((title): title is string => Boolean(title))
    .slice(0, 2);
  const unavailableCount = sources.filter(
    (source) => source.status === "unavailable",
  ).length;
  const usedKinds = new Set(sources.map((source) => source.kind));
  const manualSource = sources.find((source) => source.url === MANUAL_SOURCE_URL);
  const publicSourceCount = strongPublicSources.length;
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
    (publicSourceCount >= 2 &&
      unavailableCount === 0 &&
      weakPublicSources.length === 0) ||
    (publicSourceCount >= 1 &&
      humanClueCount >= 2 &&
      unavailableCount === 0 &&
      weakPublicSources.length === 0)
      ? "high"
      : publicSourceCount >= 1 ||
          humanClueCount >= 1 ||
          unavailableCount > 0 ||
          weakPublicSources.length > 0
        ? "medium"
        : "low";
  const gaps: string[] = [];

  if (publicSourceCount === 0) {
    gaps.push("这次没有抓到官网或公开页面，主要依据你手动输入的信息，建议只做轻量、低风险版本。");
  }

  if (publicSourceCount > 0 && !usedKinds.has("instagram") && !usedKinds.has("facebook")) {
    gaps.push("本次主要依据官网或公开页面，缺少更强的社媒生活化线索。");
  }

  if (weakPublicSources.length > 0) {
    gaps.push("有些社媒或公开链接虽然能打开，但没拿到足够有效内容，这一版判断不能过度自信。");
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
  const recipientAnchors = buildRecipientAnchors({
    matchedProfile,
    recipientRole,
    targetRegion,
    personTraits,
    personInterests,
    recentChat,
    personImpression,
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
    recipient_anchors: recipientAnchors,
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
  const giftComponents = Array.isArray(item.gift_components)
    ? item.gift_components
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => truncate(cleanText(value), 60))
        .slice(0, 4)
    : [];
  const fields = [
    "name",
    "item_type",
    "reason",
    "why_relevant",
    "why_unexpected",
    "why_novel",
    "business_fit",
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

  return {
    ...(output as GiftIdeaWithReasoning),
    gift_components: giftComponents,
  };
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
    recipient_anchors: profile.recipient_anchors,
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
  const compactSources = input.sources.slice(0, AI_SOURCE_LIMIT).map((source) => ({
    url: source.url,
    kind: source.kind,
    evidence: truncate(source.evidence, AI_SOURCE_EVIDENCE_MAX_CHARS),
  }));

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
        recipient_anchors: input.profile.recipient_anchors,
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
      sources: compactSources,
    }),
    input.profile,
  );
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
  blueprint: FallbackGiftBlueprint,
  position: 0 | 1 | 2,
  profile: CustomerProfileContext,
  occasion: Occasion,
  budgetTier: BudgetTier,
): GiftIdeaWithReasoning {
  const occasionMeta = getOccasionMeta(occasion);
  const budgetMeta = getBudgetMeta(budgetTier);
  const roleText =
    profile.recipient_role === DEFAULT_RECIPIENT_ROLE
      ? "当前这版主要按通用商务联系人来理解"
      : `这次重点按「${profile.recipient_role}」这个角色来理解`;
  const humanText = profile.human_signal
    ? `同时结合了人的线索：${profile.human_signal}`
    : "目前缺少更强的人物线索，所以个人化程度做得更克制";
  const anchorText =
    profile.recipient_anchors.length > 0
      ? profile.recipient_anchors.slice(0, 2).join(" ")
      : `客户当前更偏「${profile.industry_signal}」这条线。`;
  const unexpectedAngle =
    position === 0
      ? blueprint.unexpected_hook
      : `它避开了和主推荐同一套路，换了一个不同的表达角度。${blueprint.unexpected_hook}`;
  const noveltyAngle = blueprint.novelty_hook;
  const businessFit =
    profile.confidence === "low"
      ? `虽然这版判断偏保守，但它仍然比常规纪念品更有针对性，而且在 ${budgetMeta.label}、寄送和审批上更容易落地。`
      : `${roleText}。${humanText}。在 ${budgetMeta.label}、交期、寄送和内部解释上，这套组合更容易执行。`;

  return {
    name: blueprint.name,
    item_type: blueprint.item_type,
    gift_components: blueprint.components.filter(
      (component): component is string => Boolean(component),
    ),
    reason:
      position === 0
        ? `它最贴合客户当前呈现出的“${profile.industry_signal}”特征，而且礼物不是单个品类，而是一套更像为这个客户拼出来的组合。`
        : `它仍然围绕客户的“${profile.industry_signal}”线索展开，但组合方式和主推荐明显不同，适合作为备选。`,
    why_relevant:
      position === 0
        ? `${roleText}，它和客户当前呈现出的「${profile.industry_signal}」最贴近。${anchorText} ${humanText}。`
        : `它依然和客户当前的「${profile.industry_signal}」相关，不是脱离客户画像硬凑出来的备选。${anchorText}`,
    why_unexpected: unexpectedAngle,
    why_novel: noveltyAngle,
    business_fit: businessFit,
    why_now:
      position === 0
        ? `${occasionMeta.label}这个时点最怕套路和过重，这类礼物更容易自然延续前一次接触的记忆。`
        : `如果你不想走主推荐的路线，这个方向在${occasionMeta.label}里依然成立，而且不容易显得用力过猛。`,
    budget_fit:
      position === 0
        ? `${budgetMeta.label}更适合做“看得出判断力但不会太重”的组合礼物，这个选择和当前预算带匹配度最高。`
        : `${budgetMeta.label}下它依然能成立，但更适合你想保留一点差异化时使用。`,
    target_unit_price: fallbackTargetUnitPrice(budgetTier, position),
    lead_time: fallbackLeadTime(blueprint.name),
    customization_level: fallbackCustomizationLevel(blueprint.name),
    shipping_ease: fallbackShippingEase(blueprint.name, profile.target_region),
    sourcing_tip: fallbackSourcingTip(blueprint.name),
    approval_hint: fallbackApprovalHint(profile.recipient_role, budgetTier),
    caution: profile.matched_profile.cautions[position],
    message_snippet:
      position === 0
        ? `如果只先定一个礼物，我会优先选「${blueprint.name}」，因为它不是单一品类，而是一套更贴合客户当下表达和这个时机的组合。`
        : `如果主推荐不方便落地，可以改成「${blueprint.name}」，方向仍然贴合客户，但表达方式会更克制一些。`,
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
  const giftBlueprints = input.profile.matched_profile.gifts[input.budgetTier];
  const primary = buildFallbackGift(
    giftBlueprints[0],
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
      giftBlueprints[1],
      1,
      input.profile,
      input.occasion,
      input.budgetTier,
    ),
    buildFallbackGift(
      giftBlueprints[2],
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
      `如果只先定一个礼物，优先选「${primary.name}」。它和客户当前呈现出的“${input.profile.industry_signal}”线索最相关，不是常规目录货，同时还能保留一点新鲜感；再加上它在 ${occasionMeta.label} 这个时机更容易解释和执行，所以这版先推它。${conservativeNote}`,
      240,
    ),
    analysis_confidence: input.profile.confidence,
    analysis_gaps: input.profile.gaps.slice(0, 3),
    evidence_highlights: input.profile.evidence_highlights,
    recipient_anchors: input.profile.recipient_anchors,
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
    (source) =>
      source.status === "used" &&
      source.content.trim().length > 0 &&
      source.quality === "strong",
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
    const openAIConfig = resolveOpenAIConfig();

    if (shouldSkipOpenAI(openAIConfig)) {
      return buildFallbackAnalysis({
        profile,
        sourceSummary,
        occasion,
        budgetTier,
      });
    }

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

    if (isFastFallbackError(error)) {
      console.warn("[analyze] AI unavailable, switched to fallback quickly");
    } else {
      console.error("[analyze] falling back to heuristic mode", error);
    }

    return buildFallbackAnalysis({
      profile,
      sourceSummary,
      occasion,
      budgetTier,
    });
  }
}
