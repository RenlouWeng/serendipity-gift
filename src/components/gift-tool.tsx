"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  BUDGET_META,
  DEFAULT_BUDGET_TIER,
  DEFAULT_OCCASION,
  OCCASION_META,
} from "@/lib/gift-config";
import { siteConfig } from "@/lib/site";
import { extractLinksFromCustomerInput } from "@/lib/customer-input";
import type {
  AnalysisConfidence,
  AnalyzeResponse,
  BudgetTier,
  Occasion,
  SourceSummary,
} from "@/lib/types";

const sampleCustomerInput = [
  "Patagonia",
  "https://www.patagonia.com/",
  "https://www.patagonia.com/our-footprint/",
  "buyer@patagonia.com",
].join("\n");

const inputExamples = [
  {
    title: "公司名 + 官网",
    lines: ["Patagonia", "https://www.patagonia.com/"],
  },
  {
    title: "名片 / 邮箱签名",
    lines: [
      "John Miller | Senior Buyer",
      "Patagonia",
      "john.miller@patagonia.com",
    ],
  },
  {
    title: "聊天碎片 + 链接",
    lines: [
      "他说最近在看环保材料，不喜欢太花哨的礼物",
      "https://www.linkedin.com/company/patagonia",
    ],
  },
] as const;

const quickRefinePresets = [
  {
    label: "更保守",
    note: "更保守一点，优先现货、低文化风险、低清关风险。",
  },
  {
    label: "更容易审批",
    note: "优先更容易给老板审批通过的版本，预算说明和理由都要更稳。",
  },
  {
    label: "更轻更好寄",
    note: "优先更轻、更好寄送的版本，避免重货和复杂包装。",
  },
  {
    label: "偏设计感",
    note: "礼物可以更有设计感，但不要太私人，也不要像艺术品。",
  },
  {
    label: "不要定制",
    note: "不要做 logo 或重定制，优先成熟现货版本。",
  },
  {
    label: "不要食品",
    note: "不要食品、液体、电池类礼物，寄送风险要低。",
  },
] as const;

const personalityOptions = [
  "理性克制",
  "热情外向",
  "低调谨慎",
  "讲究细节",
  "审美敏感",
  "务实直接",
  "喜欢新鲜事物",
  "重视效率",
] as const;

const interestOptions = [
  "咖啡",
  "运动",
  "旅行",
  "户外",
  "设计",
  "科技产品",
  "可持续",
  "书店 / 阅读",
  "家庭 / 孩子",
  "宠物",
  "新办公室",
  "品牌升级",
] as const;

const roleOptions = [
  "未指定",
  "创始人 / 老板",
  "采购 / Buyer",
  "品牌 / 市场",
  "产品 / 工程",
  "销售 / BD",
] as const;

const occasionOptions = Object.entries(OCCASION_META) as Array<
  [Occasion, (typeof OCCASION_META)[Occasion]]
>;
const budgetOptions = Object.entries(BUDGET_META) as Array<
  [BudgetTier, (typeof BUDGET_META)[BudgetTier]]
>;
type OccasionMeta = (typeof OCCASION_META)[Occasion];

function statusLabel(status: "used" | "unavailable") {
  return status === "used" ? "已使用" : "未取到";
}

function sourceLabel(source: SourceSummary) {
  if (source.label) {
    return source.label;
  }

  if (source.url.startsWith("manual://")) {
    return "用户输入";
  }

  return source.url;
}

type SignalTone = "good" | "warn" | "risk" | "idle";
type FocusTarget = "customer" | "role" | "region" | "note" | "human";

interface InputSignal {
  label: string;
  value: string;
  hint: string;
  tone: SignalTone;
  actionLabel?: string;
  actionTarget?: FocusTarget;
}

interface ResultActionCard {
  title: string;
  body: string;
  copyText: string;
  event: string;
  successMessage: string;
}

function getSignalToneClass(tone: SignalTone) {
  if (tone === "good") {
    return "border-[rgba(48,71,61,0.16)] bg-[rgba(48,71,61,0.08)]";
  }

  if (tone === "warn") {
    return "border-[rgba(170,111,58,0.16)] bg-[rgba(170,111,58,0.08)]";
  }

  if (tone === "risk") {
    return "border-[rgba(164,73,46,0.16)] bg-[rgba(214,132,104,0.10)]";
  }

  return "border-black/8 bg-white/82";
}

function buildInputSignals(
  customerInput: string,
  links: string[],
  recipientRole: string,
  targetRegion: string,
  humanClueCount: number,
): InputSignal[] {
  const hasInput = customerInput.trim().length > 0;
  const roleReady = recipientRole !== "未指定";
  const regionReady = targetRegion.trim().length > 0;

  if (!hasInput) {
    return [
      {
        label: "现在能不能跑",
        value: "先贴信息",
        hint: "先贴公司名、官网、名片文字或聊天碎片中的任意一种，系统就能先出第一版。",
        tone: "idle",
        actionLabel: "去输入",
        actionTarget: "customer",
      },
      {
        label: "最值得补的一项",
        value: "收礼人角色",
        hint: "如果你知道对方是老板、Buyer 还是市场，这一项最能明显改变礼物方向。",
        tone: "idle",
        actionLabel: "补角色",
        actionTarget: "role",
      },
      {
        label: "这版适合怎么推进",
        value: "先轻量判断",
        hint: "第一版先拿主推荐，不要一开始就试图把所有信息填满。",
        tone: "idle",
      },
    ];
  }

  const linkSignal: InputSignal =
    links.length >= 2
      ? {
          label: "现在能不能跑",
          value: "可以直接跑",
          hint: `已识别 ${links.length} 个公开链接，这版已经足够先定主礼物。`,
          tone: "good",
        }
      : links.length === 1
        ? {
            label: "现在能不能跑",
            value: "可以先跑",
            hint: "已经能跑。若再补 1 个官网或社媒链接，建议会更稳。",
            tone: "warn",
            actionLabel: "补链接",
            actionTarget: "customer",
          }
        : {
            label: "现在能不能跑",
            value: "能跑但偏保守",
            hint: "当前没有识别到公开链接，会先按公司文字或聊天信息给你一个保守版。",
            tone: "risk",
            actionLabel: "补链接",
            actionTarget: "customer",
          };

  const roleSignal: InputSignal = roleReady
    ? {
        label: "最值得补的一项",
        value: "角色已明确",
        hint: `已按「${recipientRole}」来收窄礼物方向。`,
        tone: "good",
      }
    : {
        label: "最值得补的一项",
        value: "补收礼人角色",
        hint: "这项最值钱。不填的话，只能按通用商务联系人先判断。",
        tone: "warn",
        actionLabel: "补角色",
        actionTarget: "role",
      };

  let actionSignal: InputSignal;

  if (links.length >= 1 && roleReady && regionReady) {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "直接推进主推荐",
      hint: "这版已经适合先定主礼物，再去问价、交期和样品。",
      tone: "good",
    };
  } else if (links.length >= 1 && roleReady) {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "先跑，再补地区",
      hint: "礼物方向已经能收窄，地区主要影响寄送和文化/清关风险。",
      tone: "warn",
      actionLabel: "补地区",
      actionTarget: "region",
    };
  } else if (links.length >= 1 && regionReady) {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "先跑，再补角色",
      hint: "寄送约束已经够用，但个性化还不够，先拿保守主推荐。",
      tone: "warn",
      actionLabel: "补角色",
      actionTarget: "role",
    };
  } else if (humanClueCount >= 1) {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "先跑，再补公开链接",
      hint: "你已经给了人的线索，这能拉开差异；如果再补一个官网或社媒链接，会更稳。",
      tone: "warn",
      actionLabel: "补链接",
      actionTarget: "customer",
    };
  } else if (links.length >= 1) {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "先轻量推进",
      hint: "这版更适合现货、轻包装、低定制的安全版本。",
      tone: "warn",
    };
  } else {
    actionSignal = {
      label: "这版适合怎么推进",
      value: "保守跑",
      hint: "建议先拿一个低风险版本，别直接押高客单、重定制或强文化表达的礼物。",
      tone: "risk",
    };
  }

  return [linkSignal, roleSignal, actionSignal];
}

function buildPrimarySummary(result: AnalyzeResponse) {
  const primary = result.primary_recommendation;

  return [
    `主推荐：${primary.name}`,
    `品类：${primary.item_type}`,
    primary.gift_components.length > 0
      ? `礼物组成：${primary.gift_components.join(" + ")}`
      : "",
    `建议价格：${primary.target_unit_price}`,
    `交期：${primary.lead_time}`,
    `定制建议：${primary.customization_level}`,
    `寄送判断：${primary.shipping_ease}`,
    `采购建议：${primary.sourcing_tip}`,
    `审批提醒：${primary.approval_hint}`,
    `为什么选它：${primary.reason}`,
    `相关性：${primary.why_relevant}`,
    `意外感：${primary.why_unexpected}`,
    `新鲜感：${primary.why_novel}`,
    `商务可执行性：${primary.business_fit}`,
    `风险提醒：${primary.caution}`,
  ].join("\n");
}

function buildProcurementSummary(result: AnalyzeResponse) {
  const primary = result.primary_recommendation;
  const brief = result.procurement_brief;

  return [
    `礼物：${primary.name}`,
    `品类：${primary.item_type}`,
    `目标单价：${primary.target_unit_price}`,
    `执行方式：${brief.execution_mode}`,
    `建议数量：${brief.recommended_quantity}`,
    `打样建议：${brief.sample_plan}`,
    `包装建议：${brief.packaging_plan}`,
    `品牌处理：${brief.branding_note}`,
    `交期：${primary.lead_time}`,
    `供应商方向：${primary.sourcing_tip}`,
    `询价话术：${brief.supplier_message}`,
  ].join("\n");
}

function appendUniqueNote(base: string, addition: string) {
  const cleanBase = base.trim();
  const cleanAddition = addition.trim();

  if (!cleanAddition) {
    return cleanBase;
  }

  if (cleanBase.includes(cleanAddition)) {
    return cleanBase;
  }

  return cleanBase ? `${cleanBase}；${cleanAddition}` : cleanAddition;
}

function getConfidenceMeta(confidence: AnalysisConfidence) {
  if (confidence === "high") {
    return {
      label: "可直接执行",
      hint: "公开线索够用，先按主推荐推进，不要再回到多个方案里犹豫。",
      toneClass:
        "border-[rgba(48,71,61,0.18)] bg-[rgba(48,71,61,0.08)] text-[var(--sage)]",
    };
  }

  if (confidence === "medium") {
    return {
      label: "先轻量执行",
      hint: "可以先做，但更适合现货、轻包装、低定制版本。",
      toneClass:
        "border-[rgba(170,111,58,0.18)] bg-[rgba(170,111,58,0.08)] text-[var(--accent-strong)]",
    };
  }

  return {
    label: "只做保守版本",
    hint: "如果今天必须推进，就选轻巧、低文化风险、低清关风险的版本，别押太重。",
    toneClass:
      "border-[rgba(164,73,46,0.18)] bg-[rgba(214,132,104,0.10)] text-[#7e3f23]",
  };
}

function followUpLabel(occasion: Occasion) {
  if (occasion === "first_visit") {
    return "拜访前沟通话术";
  }

  if (occasion === "client_visit") {
    return "来访接待话术";
  }

  return "展会后跟进话术";
}

function displayValue(value: string, fallback = "未指定") {
  return value.trim() ? value : fallback;
}

function buildExecutionChecklist(
  result: AnalyzeResponse,
  occasionMeta: OccasionMeta,
) {
  const primary = result.primary_recommendation;
  const brief = result.procurement_brief;

  return [
    {
      title: "先把品类定掉",
      body:
        result.analysis_confidence === "high"
          ? `直接先按「${primary.name}」推进，不要回到多个方案里重选。${primary.approval_hint}`
          : `先按「${primary.name}」做轻量版本，别上来就做重定制。${primary.approval_hint}`,
    },
    {
      title: "把采购 brief 发出去",
      body: `数量先按 ${brief.recommended_quantity}。${brief.sample_plan} ${primary.sourcing_tip} ${primary.lead_time}`,
    },
    {
      title: "把包装和寄送一起定掉",
      body: `${brief.packaging_plan} ${primary.shipping_ease} ${occasionMeta.timing_note}`,
    },
  ];
}

function buildBackupSummary(result: AnalyzeResponse) {
  return result.backup_recommendations
    .map((gift, index) =>
      [
        `备选 ${index + 1}：${gift.name}`,
        `品类：${gift.item_type}`,
        gift.gift_components.length > 0
          ? `礼物组成：${gift.gift_components.join(" + ")}`
          : "",
        `建议价格：${gift.target_unit_price}`,
        `交期：${gift.lead_time}`,
        `为什么备选：${gift.reason}`,
        `相关性：${gift.why_relevant}`,
        `意外感：${gift.why_unexpected}`,
        `新鲜感：${gift.why_novel}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function buildResultActionCards(result: AnalyzeResponse, occasion: Occasion) {
  return [
    {
      title: "给老板一句话",
      body: result.primary_recommendation.message_snippet,
      copyText: result.primary_recommendation.message_snippet,
      event: "copy_message_snippet_secondary",
      successMessage: "给老板的一句话已复制。",
    },
    {
      title: followUpLabel(occasion),
      body: result.follow_up_message,
      copyText: result.follow_up_message,
      event: "copy_follow_up_message",
      successMessage: "场景话术已复制。",
    },
    {
      title: "发给采购 / 供应商",
      body: result.procurement_brief.supplier_message,
      copyText: buildProcurementSummary(result),
      event: "copy_procurement_brief",
      successMessage: "采购 brief 已复制。",
    },
  ] satisfies ResultActionCard[];
}

export function GiftTool() {
  const customerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const targetRegionRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const recentChatRef = useRef<HTMLTextAreaElement | null>(null);
  const roleButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const advancedSectionRef = useRef<HTMLDivElement | null>(null);
  const humanSectionRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const [customerInput, setCustomerInput] = useState("");
  const [note, setNote] = useState("");
  const [personTraits, setPersonTraits] = useState<string[]>([]);
  const [personInterests, setPersonInterests] = useState<string[]>([]);
  const [recentChat, setRecentChat] = useState("");
  const [personImpression, setPersonImpression] = useState("");
  const [recipientRole, setRecipientRole] = useState<(typeof roleOptions)[number]>(
    "未指定",
  );
  const [targetRegion, setTargetRegion] = useState("");
  const [occasion, setOccasion] = useState<Occasion>(DEFAULT_OCCASION);
  const [budgetTier, setBudgetTier] = useState<BudgetTier>(DEFAULT_BUDGET_TIER);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resultContext, setResultContext] = useState<{
    occasion: Occasion;
    budgetTier: BudgetTier;
  } | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showInputExamples, setShowInputExamples] = useState(false);

  const extractedLinks = useMemo(
    () => extractLinksFromCustomerInput(customerInput),
    [customerInput],
  );
  const humanClueCount = useMemo(
    () =>
      [
        personTraits.length > 0,
        personInterests.length > 0,
        Boolean(recentChat.trim()),
        Boolean(personImpression.trim()),
      ].filter(Boolean).length,
    [personTraits, personInterests, recentChat, personImpression],
  );
  const inputSignals = useMemo(
    () =>
      buildInputSignals(
        customerInput,
        extractedLinks,
        recipientRole,
        targetRegion,
        humanClueCount,
      ),
    [customerInput, extractedLinks, recipientRole, targetRegion, humanClueCount],
  );
  const primarySummary = useMemo(
    () => (result ? buildPrimarySummary(result) : ""),
    [result],
  );
  const backupSummary = useMemo(
    () => (result ? buildBackupSummary(result) : ""),
    [result],
  );
  const occasionMeta = OCCASION_META[occasion];
  const budgetMeta = BUDGET_META[budgetTier];
  const resultOccasionMeta = OCCASION_META[resultContext?.occasion ?? occasion];
  const resultBudgetMeta = BUDGET_META[resultContext?.budgetTier ?? budgetTier];
  const resultConfidenceMeta = result
    ? getConfidenceMeta(result.analysis_confidence)
    : null;
  const executionChecklist = useMemo(
    () => (result ? buildExecutionChecklist(result, resultOccasionMeta) : []),
    [result, resultOccasionMeta],
  );
  const resultActionCards = useMemo(
    () =>
      result
        ? buildResultActionCards(result, resultContext?.occasion ?? occasion)
        : [],
    [result, resultContext, occasion],
  );
  const advancedCount = useMemo(
    () =>
      [
        recipientRole !== "未指定",
        Boolean(targetRegion.trim()),
        Boolean(note.trim()),
        occasion !== DEFAULT_OCCASION,
        budgetTier !== DEFAULT_BUDGET_TIER,
      ].filter(Boolean).length,
    [recipientRole, targetRegion, note, occasion, budgetTier],
  );

  useEffect(() => {
    if (result) {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  async function trackEvent(event: string, context: string) {
    try {
      await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event,
          context,
          mode: result?.mode ?? "pre_result",
        }),
      });
    } catch {
      // Ignore tracking failures. They should never block the core flow.
    }
  }

  function showCopyFeedback(message: string) {
    setCopyFeedback(message);

    window.setTimeout(() => {
      setCopyFeedback((current) => (current === message ? null : current));
    }, 2400);
  }

  async function handleCopy(text: string, event: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showCopyFeedback(successMessage);
      await trackEvent(event, "result_copy");
    } catch {
      showCopyFeedback("当前环境无法自动复制，请手动复制。");
    }
  }

  function focusTarget(target: FocusTarget) {
    if (target === "customer") {
      customerInputRef.current?.focus();
      return;
    }

    if (target === "role") {
      roleButtonRefs.current[1]?.focus();
      return;
    }

    if (target === "region") {
      targetRegionRef.current?.focus();
      return;
    }

    setShowAdvanced(true);

    window.setTimeout(() => {
      if (target === "note") {
        advancedSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        noteRef.current?.focus();
        return;
      }

      if (target === "human") {
        humanSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        recentChatRef.current?.focus();
        return;
      }

      advancedSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      recentChatRef.current?.focus();
    }, 80);
  }

  function toggleSelection(
    value: string,
    update: React.Dispatch<React.SetStateAction<string[]>>,
  ) {
    update((existing) =>
      existing.includes(value)
        ? existing.filter((item) => item !== value)
        : [...existing, value].slice(0, 8),
    );
  }

  async function requestAnalysis(
    overrides?: Partial<{
      note: string;
      recipientRole: (typeof roleOptions)[number];
      targetRegion: string;
      occasion: Occasion;
      budgetTier: BudgetTier;
      personTraits: string[];
      personInterests: string[];
      recentChat: string;
      personImpression: string;
    }>,
  ) {
    const nextCustomerInput = customerInput.trim();
    const nextOccasion = overrides?.occasion ?? occasion;
    const nextBudgetTier = overrides?.budgetTier ?? budgetTier;
    const nextRecipientRole = overrides?.recipientRole ?? recipientRole;
    const nextTargetRegion = overrides?.targetRegion ?? targetRegion;
    const nextNote = overrides?.note ?? note;
    const nextPersonTraits = overrides?.personTraits ?? personTraits;
    const nextPersonInterests = overrides?.personInterests ?? personInterests;
    const nextRecentChat = overrides?.recentChat ?? recentChat;
    const nextPersonImpression = overrides?.personImpression ?? personImpression;

    if (!nextCustomerInput) {
      setError("请至少提供公司名、官网、邮箱域名、社媒链接中的任意一种信息。");
      return;
    }

    setError(null);
    setCopyFeedback(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer_input: nextCustomerInput,
          occasion: nextOccasion,
          budget_tier: nextBudgetTier,
          recipient_role:
            nextRecipientRole !== "未指定" ? nextRecipientRole : undefined,
          target_region: nextTargetRegion.trim() || undefined,
          note: nextNote.trim() || undefined,
          person_traits: nextPersonTraits,
          person_interests: nextPersonInterests,
          recent_chat: nextRecentChat.trim() || undefined,
          person_impression: nextPersonImpression.trim() || undefined,
        }),
      });

      const payload = (await response.json()) as
        | AnalyzeResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "生成礼物建议失败，请稍后再试。",
        );
      }

      startTransition(() => {
        setResult(payload as AnalyzeResponse);
        setResultContext({ occasion: nextOccasion, budgetTier: nextBudgetTier });
      });

      await trackEvent("generate_success", nextOccasion);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "生成礼物建议失败，请稍后再试。",
      );
      await trackEvent("generate_failure", nextOccasion);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await requestAnalysis();
  }

  async function handleQuickRefine(presetNote: string) {
    const nextNote = appendUniqueNote(note, presetNote);
    setNote(nextNote);
    setShowAdvanced(true);
    await requestAnalysis({ note: nextNote });
  }

  function resetForm() {
    setCustomerInput("");
    setNote("");
    setPersonTraits([]);
    setPersonInterests([]);
    setRecentChat("");
    setPersonImpression("");
    setRecipientRole("未指定");
    setTargetRegion("");
    setOccasion(DEFAULT_OCCASION);
    setBudgetTier(DEFAULT_BUDGET_TIER);
    setShowAdvanced(false);
    setShowInputExamples(false);
    setResult(null);
    setResultContext(null);
    setError(null);
    setCopyFeedback(null);

    window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => {
      customerInputRef.current?.focus();
    }, 220);
  }

  return (
    <div className="panel p-4 sm:p-6 lg:p-7">
      <div className="rounded-[28px] border border-black/8 bg-[rgba(255,252,246,0.94)] p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[var(--accent-strong)]">
              外贸送礼决策助手
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
              先别纠结送什么，先拿一版能推进的
            </h2>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)] sm:text-base">
              你手里有什么就贴什么。公司名、官网、名片文字、聊天碎片都行，不用先整理成一份完整资料。
            </p>
          </div>
          <button
            type="button"
            className="min-h-11 rounded-full border border-black/10 px-4 py-2 text-sm font-medium transition hover:bg-black/[0.04]"
            onClick={() => {
              setCustomerInput(sampleCustomerInput);
              setRecipientRole("采购 / Buyer");
              setTargetRegion("United States");
              setOccasion("trade_show_follow_up");
              setBudgetTier("300_800_cny");
              setNote("展会后 7 天内想寄出，预算别太夸张，不要食品，不要重货。");
              setPersonTraits(["理性克制", "重视效率"]);
              setPersonInterests(["可持续", "户外"]);
              setRecentChat("上次聊天提到他们最近在看环保材料，也说团队里很多人周末会去露营。");
              setPersonImpression("沟通很直接，不喜欢太花哨，但会注意品牌表达是不是做过功课。");
              setShowAdvanced(false);
              setShowInputExamples(false);
            }}
          >
            直接看示例
          </button>
        </div>

        <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label
                  className="block text-sm font-medium text-[var(--foreground)]"
                  htmlFor="customer-input"
                >
                  把客户信息贴进来
                </label>
                <button
                  type="button"
                  onClick={() => setShowInputExamples((current) => !current)}
                  className="text-xs text-[var(--muted)] underline decoration-black/20 underline-offset-4 transition hover:text-[var(--foreground)]"
                >
                  {showInputExamples ? "收起示例" : "不知道怎么贴？"}
                </button>
              </div>
              <textarea
                id="customer-input"
                ref={customerInputRef}
                value={customerInput}
                onChange={(nextEvent) => setCustomerInput(nextEvent.target.value)}
                placeholder={`例如：\nPatagonia\nhttps://www.patagonia.com/\nJohn Miller | Senior Buyer\njohn.miller@patagonia.com\n他说最近在看环保材料，不喜欢太花哨的礼物`}
                className="min-h-[172px] w-full rounded-[24px] border border-black/10 bg-white/84 px-4 py-4 text-sm leading-7 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(170,111,58,0.12)]"
              />
              {showInputExamples ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  {inputExamples.map((example) => (
                    <button
                      key={example.title}
                      type="button"
                      onClick={() => {
                        setCustomerInput(example.lines.join("\n"));
                      }}
                      className="rounded-[20px] border border-black/8 bg-[rgba(255,255,255,0.76)] p-4 text-left transition hover:border-[var(--accent)]/40 hover:bg-white"
                    >
                      <p className="text-sm font-semibold text-[var(--foreground)]">
                        {example.title}
                      </p>
                      <p className="mt-2 whitespace-pre-line text-xs leading-6 text-[var(--muted)]">
                        {example.lines.join("\n")}
                      </p>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="rounded-[20px] border border-black/8 bg-white/72 px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                  你不用一次填全
                </p>
                <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                  公司名、官网、邮箱域名、LinkedIn、IG、展会名片文字、几句聊天碎片，任意一种都能先跑。
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                  {inputExamples.map((example) => (
                    <span
                      key={example.title}
                      className="rounded-full border border-black/8 bg-[rgba(255,252,246,0.92)] px-3 py-2"
                    >
                      {example.title}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-6 text-[var(--muted)]">
                  {extractedLinks.length > 0
                    ? `已识别 ${extractedLinks.length} 个公开链接，已经够先定方向。`
                    : "你就算只知道公司名，也可以先跑。我会先给你一个更稳的版本。"}
                </p>
              </div>
            </div>

            <div className="rounded-[24px] border border-black/8 bg-[rgba(255,255,255,0.72)] p-5">
              <p className="text-sm font-semibold text-[var(--foreground)]">先看这三件事</p>
              <p className="mt-2 text-xs leading-6 text-[var(--muted)]">
                你现在最需要知道的，不是系统状态，而是这版能不能先推进。
              </p>
              <div className="mt-4 space-y-3">
                {inputSignals.map((item) => (
                  <div
                    key={item.label}
                    className={`rounded-[18px] border px-4 py-3 ${getSignalToneClass(
                      item.tone,
                    )}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-[var(--foreground)]">
                        {item.label}
                      </p>
                      <span className="rounded-full bg-white/84 px-3 py-1 text-xs font-semibold text-[var(--foreground)]">
                        {item.value}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-6 text-[var(--muted)]">
                      {item.hint}
                    </p>
                    {item.actionLabel && item.actionTarget ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (item.actionTarget) {
                            focusTarget(item.actionTarget);
                          }
                        }}
                        className="mt-3 min-h-10 rounded-full border border-black/10 bg-white/84 px-3 py-2 text-xs font-medium text-[var(--foreground)] transition hover:bg-white"
                      >
                        {item.actionLabel}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-[var(--foreground)]">
                你现在更像哪种场景
              </label>
              <span className="text-xs text-[var(--muted)]">
                这一项会直接影响送礼时机和表达方式
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {occasionOptions.map(([value, meta]) => {
                const active = occasion === value;

                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setOccasion(value)}
                    className={
                      active
                        ? "min-h-12 rounded-[20px] border border-[var(--accent)] bg-[rgba(170,111,58,0.12)] p-4 text-left shadow-sm transition"
                        : "min-h-12 rounded-[20px] border border-black/8 bg-white/76 p-4 text-left transition hover:border-[var(--accent)]/50 hover:bg-white"
                    }
                  >
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      {meta.label}
                    </p>
                    <p className="mt-1 text-xs leading-6 text-[var(--muted)]">
                      {meta.hint}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-sm font-medium text-[var(--foreground)]">
                  收礼人是谁
                </label>
                <button
                  type="button"
                  onClick={() => focusTarget("role")}
                  className="text-xs text-[var(--muted)] underline decoration-black/20 underline-offset-4 transition hover:text-[var(--foreground)]"
                >
                  这项为什么值钱
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {roleOptions.map((value, index) => {
                  const active = recipientRole === value;

                  return (
                    <button
                      key={value}
                      ref={(element) => {
                        roleButtonRefs.current[index] = element;
                      }}
                      type="button"
                      onClick={() => setRecipientRole(value)}
                      className={
                        active
                          ? "min-h-11 rounded-[20px] border border-[var(--sage)] bg-[rgba(48,71,61,0.10)] px-3 py-3 text-sm font-medium text-[var(--foreground)] shadow-sm transition"
                          : "min-h-11 rounded-[20px] border border-black/8 bg-white/74 px-3 py-3 text-sm text-[var(--muted)] transition hover:border-[var(--sage)]/40 hover:bg-white"
                      }
                    >
                      {value}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label
                className="block text-sm font-medium text-[var(--foreground)]"
                htmlFor="target-region"
              >
                客户地区
              </label>
              <input
                id="target-region"
                ref={targetRegionRef}
                value={targetRegion}
                onChange={(nextEvent) => setTargetRegion(nextEvent.target.value)}
                placeholder="例如：United States / Germany / Japan"
                className="h-14 w-full rounded-[20px] border border-black/10 bg-white/84 px-4 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(170,111,58,0.12)]"
              />
              <p className="text-xs leading-6 text-[var(--muted)]">
                不填也能先跑。填了以后，我会把寄送和文化风险判断得更细一点。
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-12 rounded-full bg-[var(--foreground)] px-5 py-4 text-sm font-semibold text-white transition hover:opacity-92 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting
                ? `正在整理 ${occasionMeta.label} 的送礼建议...`
                : "先看一版送礼建议"}
            </button>
            <button
              type="button"
              onClick={() => setShowAdvanced((current) => !current)}
              className="min-h-12 rounded-full border border-black/10 bg-white/76 px-4 py-4 text-sm font-medium transition hover:bg-white"
            >
              {showAdvanced
                ? "收起补充信息"
                : advancedCount + humanClueCount > 0
                  ? `再补一点，让结果更准（已填 ${advancedCount + humanClueCount} 项）`
                  : "再补一点，让结果更准"}
            </button>
          </div>

          {!result ? (
            <div className="rounded-[24px] border border-dashed border-black/10 bg-[rgba(255,255,255,0.58)] px-4 py-4 text-sm leading-7 text-[var(--muted)]">
              跑完后你会拿到 4 样东西：主推荐礼物、为什么送它、今天怎么推进、可以直接复制给老板/采购的话术。
            </div>
          ) : null}

          {showAdvanced ? (
            <div
              ref={advancedSectionRef}
              className="space-y-5 rounded-[24px] border border-black/8 bg-[rgba(255,255,255,0.68)] p-5"
            >
              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-2">
                  <label
                    className="block text-sm font-medium text-[var(--foreground)]"
                    htmlFor="note"
                  >
                    有什么硬限制，直接说
                  </label>
                  <textarea
                    id="note"
                    ref={noteRef}
                    value={note}
                    onChange={(nextEvent) => setNote(nextEvent.target.value)}
                    placeholder="例如：想在 1 周内寄出；不要食品和液体；最好老板当天就能批；客户偏设计感但别太私人。"
                    className="min-h-[108px] w-full rounded-[24px] border border-black/10 bg-white/84 px-4 py-4 text-sm leading-7 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(170,111,58,0.12)]"
                  />
                </div>

                <div className="space-y-3 rounded-[22px] border border-black/8 bg-white/66 p-4">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    什么情况下值得补这里
                  </p>
                  <ul className="space-y-2 text-sm leading-7 text-[var(--muted)]">
                    <li>你觉得主推荐太泛，像谁都能送。</li>
                    <li>你知道对方一点个人线索，想把差距拉开。</li>
                    <li>你已经有硬要求，比如别太重、别食品、要好审批。</li>
                  </ul>
                </div>
              </div>

              <div
                ref={humanSectionRef}
                className="space-y-4 rounded-[22px] border border-[rgba(48,71,61,0.10)] bg-[rgba(248,252,249,0.8)] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      让礼物更像为他挑的
                    </p>
                    <p className="mt-1 text-xs leading-6 text-[var(--muted)]">
                      想到一条填一条就行，这里越像聊天碎片越有用。
                    </p>
                  </div>
                  <span className="rounded-full border border-black/8 bg-white/72 px-3 py-2 text-xs text-[var(--muted)]">
                    已补 {humanClueCount} 项
                  </span>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    他更像什么样的人
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {personalityOptions.map((value) => {
                      const active = personTraits.includes(value);

                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() =>
                            toggleSelection(value, setPersonTraits)
                          }
                          className={
                            active
                              ? "rounded-full border border-[var(--sage)] bg-[rgba(48,71,61,0.10)] px-4 py-2 text-sm font-medium text-[var(--foreground)]"
                              : "rounded-full border border-black/8 bg-white/80 px-4 py-2 text-sm text-[var(--muted)] transition hover:border-[var(--sage)]/40 hover:bg-white"
                          }
                        >
                          {value}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    他最近更在意什么 / 可能喜欢什么
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {interestOptions.map((value) => {
                      const active = personInterests.includes(value);

                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() =>
                            toggleSelection(
                              value,
                              setPersonInterests,
                            )
                          }
                          className={
                            active
                              ? "rounded-full border border-[var(--accent)] bg-[rgba(170,111,58,0.12)] px-4 py-2 text-sm font-medium text-[var(--foreground)]"
                              : "rounded-full border border-black/8 bg-white/80 px-4 py-2 text-sm text-[var(--muted)] transition hover:border-[var(--accent)]/40 hover:bg-white"
                          }
                        >
                          {value}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      className="block text-sm font-medium text-[var(--foreground)]"
                      htmlFor="recent-chat"
                    >
                      上次聊天里你记住的一句话
                    </label>
                    <textarea
                      id="recent-chat"
                      ref={recentChatRef}
                      value={recentChat}
                      onChange={(nextEvent) => setRecentChat(nextEvent.target.value)}
                      placeholder="例如：他说最近在做品牌升级；团队最近在看环保材料；不喜欢太夸张的礼物。"
                      className="min-h-[116px] w-full rounded-[24px] border border-black/10 bg-white/84 px-4 py-4 text-sm leading-7 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(170,111,58,0.12)]"
                    />
                  </div>

                  <div className="space-y-2">
                    <label
                      className="block text-sm font-medium text-[var(--foreground)]"
                      htmlFor="person-impression"
                    >
                      你对他的第一印象
                    </label>
                    <textarea
                      id="person-impression"
                      value={personImpression}
                      onChange={(nextEvent) => setPersonImpression(nextEvent.target.value)}
                      placeholder="例如：讲话很理性，不喜欢太用力；审美在线，但不会接受太私人化的东西。"
                      className="min-h-[116px] w-full rounded-[24px] border border-black/10 bg-white/84 px-4 py-4 text-sm leading-7 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(170,111,58,0.12)]"
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="block text-sm font-medium text-[var(--foreground)]">
                      预算档位
                    </label>
                    <span className="text-xs text-[var(--muted)]">
                      直接影响采购版本
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {budgetOptions.map(([value, meta]) => {
                      const active = budgetTier === value;

                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setBudgetTier(value)}
                          className={
                            active
                              ? "rounded-[22px] border border-[var(--sage)] bg-[rgba(48,71,61,0.10)] p-4 text-left shadow-sm transition"
                              : "rounded-[22px] border border-black/8 bg-white/74 p-4 text-left transition hover:border-[var(--sage)]/45 hover:bg-white"
                          }
                        >
                          <p className="text-sm font-semibold text-[var(--foreground)]">
                            {meta.label}
                          </p>
                          <p className="mt-2 text-xs leading-6 text-[var(--muted)]">
                            {meta.hint}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-[22px] border border-black/8 bg-white/66 p-4">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    什么时候值得改预算
                  </p>
                  <ul className="mt-3 space-y-2 text-sm leading-7 text-[var(--muted)]">
                    <li>客户层级明显更高，普通预算撑不住场面。</li>
                    <li>老板已经点头，重点变成怎么把记忆点做出来。</li>
                    <li>你现在需要的不只是稳，还要有一点惊喜感。</li>
                  </ul>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="min-h-11 rounded-full border border-black/10 bg-[var(--foreground)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-92 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  带这些信息重跑一版
                </button>
              </div>
            </div>
          ) : null}
        </form>

        <div className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
          <span className="rounded-full border border-black/8 bg-[rgba(255,255,255,0.68)] px-3 py-2">
            场景：{occasionMeta.label}
          </span>
          <span className="rounded-full border border-black/8 bg-[rgba(255,255,255,0.68)] px-3 py-2">
            预算：{budgetMeta.label}
          </span>
          <span className="rounded-full border border-black/8 bg-[rgba(255,255,255,0.68)] px-3 py-2">
            角色：{displayValue(recipientRole)}
          </span>
          <span className="rounded-full border border-black/8 bg-[rgba(255,255,255,0.68)] px-3 py-2">
            地区：{displayValue(targetRegion)}
          </span>
        </div>

        {error ? (
          <div className="mt-4 rounded-[22px] border border-[rgba(164,73,46,0.18)] bg-[rgba(214,132,104,0.12)] px-4 py-3 text-sm text-[#7e3f23]">
            {error}
          </div>
        ) : null}
      </div>

      <div ref={resultRef} className="mt-5 space-y-4">
        {copyFeedback ? (
          <div className="rounded-[22px] border border-[rgba(48,71,61,0.14)] bg-[rgba(48,71,61,0.08)] px-4 py-3 text-sm text-[var(--sage)]">
            {copyFeedback}
          </div>
        ) : null}

        {!result ? null : (
          <>
            <article className="soft-card border-[rgba(170,111,58,0.25)] bg-[linear-gradient(145deg,rgba(255,250,242,0.98),rgba(250,238,220,0.94))]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="eyebrow">主推荐</p>
                    {resultConfidenceMeta ? (
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-medium ${resultConfidenceMeta.toneClass}`}
                      >
                        {resultConfidenceMeta.label}
                      </span>
                    ) : null}
                    {isPending ? (
                      <span className="text-xs text-[var(--muted)]">
                        正在整理结果...
                      </span>
                    ) : null}
                  </div>
                  <h3 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
                    {result.primary_recommendation.name}
                  </h3>
	                  <p className="mt-2 text-sm font-medium text-[var(--muted)]">
	                    {result.primary_recommendation.item_type}
	                  </p>
	                  {result.primary_recommendation.gift_components.length > 0 ? (
	                    <div className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
	                      {result.primary_recommendation.gift_components.map((component) => (
	                        <span
	                          key={component}
	                          className="rounded-full border border-black/8 bg-white/72 px-3 py-2"
	                        >
	                          {component}
	                        </span>
	                      ))}
	                    </div>
	                  ) : null}
	                  <div className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                    <span className="rounded-full bg-white/72 px-3 py-2">
                      {resultOccasionMeta.label}
                    </span>
                    <span className="rounded-full bg-white/72 px-3 py-2">
                      {resultBudgetMeta.label}
                    </span>
                    <span className="rounded-full bg-white/72 px-3 py-2">
                      {displayValue(result.recipient_role)}
                    </span>
                    <span className="rounded-full bg-white/72 px-3 py-2">
                      {displayValue(result.target_region)}
                    </span>
                  </div>
                  {resultConfidenceMeta ? (
                    <div className="mt-4 rounded-[18px] border border-black/8 bg-white/78 px-4 py-3">
                      <p className="text-sm leading-7 text-[var(--foreground)]">
                        {resultConfidenceMeta.hint}
                      </p>
                      {result.analysis_gaps[0] ? (
                        <p className="mt-1 text-xs leading-6 text-[var(--muted)]">
                          如果再补 1 样：{result.analysis_gaps[0]}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(
                        primarySummary,
                        "copy_primary_recommendation",
                        "主推荐采购卡已复制。",
                      )
                    }
                    className="min-h-11 rounded-full border border-black/10 bg-white/80 px-4 py-3 text-sm font-medium transition hover:bg-white"
                  >
                    复制这版建议
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="min-h-11 rounded-full border border-black/10 bg-white/80 px-4 py-3 text-sm font-medium transition hover:bg-white"
                  >
                    换个客户重来
                  </button>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-[22px] border border-black/8 bg-white/82 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                    建议价格
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[var(--foreground)]">
                    {result.primary_recommendation.target_unit_price}
                  </p>
                </div>
                <div className="rounded-[22px] border border-black/8 bg-white/82 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                    交期
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[var(--foreground)]">
                    {result.primary_recommendation.lead_time}
                  </p>
                </div>
                <div className="rounded-[22px] border border-black/8 bg-white/82 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                    寄送判断
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[var(--foreground)]">
                    {result.primary_recommendation.shipping_ease}
                  </p>
                </div>
                <div className="rounded-[22px] border border-black/8 bg-white/82 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                    审批提醒
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[var(--foreground)]">
                    {result.primary_recommendation.approval_hint}
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-[24px] border border-black/8 bg-white/82 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    为什么是它
                  </p>
	                  <p className="mt-3 text-base leading-8 text-[var(--foreground)]">
	                    {result.decision_summary}
	                  </p>
	                  {result.recipient_anchors.length > 0 ? (
	                    <div className="mt-4 rounded-[18px] border border-black/8 bg-[rgba(255,247,236,0.72)] px-4 py-3">
	                      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                        这次抓住的人物锚点
	                      </p>
	                      <ul className="mt-2 space-y-2 text-sm leading-7 text-[var(--muted)]">
	                        {result.recipient_anchors.map((anchor) => (
	                          <li key={anchor}>{anchor}</li>
	                        ))}
	                      </ul>
	                    </div>
	                  ) : null}
	                  <div className="mt-4 grid gap-3">
	                    <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                        为什么选它
	                      </p>
	                      <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
	                        {result.primary_recommendation.reason}
	                      </p>
	                    </div>
	                    <div className="grid gap-3 md:grid-cols-2">
	                      <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                        <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                          Relevant
	                        </p>
	                        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
	                          {result.primary_recommendation.why_relevant}
	                        </p>
	                      </div>
	                      <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                        <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                          Unexpected
	                        </p>
	                        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
	                          {result.primary_recommendation.why_unexpected}
	                        </p>
	                      </div>
	                    </div>
	                    <div className="grid gap-3 md:grid-cols-2">
	                      <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                        <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                          Novelty
	                        </p>
	                        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
	                          {result.primary_recommendation.why_novel}
	                        </p>
	                      </div>
	                      <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                        <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                          Business Fit
	                        </p>
	                        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
	                          {result.primary_recommendation.business_fit}
	                        </p>
	                      </div>
	                    </div>
	                    <div className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-3">
	                      <p className="text-xs font-semibold tracking-[0.18em] text-[var(--accent)]">
	                        为什么现在送
	                      </p>
                      <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                        {result.primary_recommendation.why_now}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-[24px] border border-black/8 bg-white/82 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    今天怎么推进
                  </p>
                  <div className="mt-4 space-y-3">
                    {executionChecklist.map((step, index) => (
                      <div
                        key={step.title}
                        className="rounded-[18px] bg-[rgba(255,247,236,0.9)] px-4 py-4"
                      >
                        <p className="text-sm font-semibold text-[var(--foreground)]">
                          {index + 1}. {step.title}
                        </p>
                        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                          {step.body}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-[24px] border border-black/8 bg-white/82 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    直接复制去用
                  </p>
                  <span className="text-xs text-[var(--muted)]">
                    少改字，先发出去
                  </span>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                  {resultActionCards.map((card) => (
                    <div
                      key={card.title}
                      className="rounded-[20px] border border-black/8 bg-[rgba(255,247,236,0.86)] p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-[var(--foreground)]">
                          {card.title}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void handleCopy(
                              card.copyText,
                              card.event,
                              card.successMessage,
                            )
                          }
                          className="min-h-10 rounded-full border border-black/10 bg-white/84 px-3 py-2 text-xs font-medium transition hover:bg-white"
                        >
                          复制
                        </button>
                      </div>
                      <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
                        {card.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </article>

            <article className="soft-card">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="eyebrow">快速纠偏</p>
                  <h3 className="mt-4 text-xl font-semibold">觉得不对，就换个方向再跑</h3>
                </div>
                <span className="text-xs text-[var(--muted)]">
                  系统会自动把这个要求带进去重跑
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {quickRefinePresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleQuickRefine(preset.note)}
                    className="min-h-11 rounded-full border border-black/10 bg-white/76 px-4 py-3 text-sm font-medium transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </article>

            <div className="grid gap-4 lg:grid-cols-[1fr_0.95fr]">
              <article className="soft-card">
                <p className="eyebrow">风险检查</p>
                <h3 className="mt-4 text-xl font-semibold">发出前再看一眼</h3>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--muted)]">
                  <li className="rounded-[18px] bg-white/66 px-4 py-3">
                    {result.primary_recommendation.budget_fit}
                  </li>
                  <li className="rounded-[18px] bg-white/66 px-4 py-3">
                    {result.primary_recommendation.caution}
                  </li>
                  {resultConfidenceMeta ? (
                    <li className="rounded-[18px] bg-white/66 px-4 py-3">
                      {resultConfidenceMeta.hint}
                    </li>
                  ) : null}
                  {result.risk_notes.length > 0 ? (
                    result.risk_notes.map((noteItem) => (
                      <li
                        key={noteItem}
                        className="rounded-[18px] bg-white/66 px-4 py-3"
                      >
                        {noteItem}
                      </li>
                    ))
                  ) : (
                    <li className="rounded-[18px] bg-white/66 px-4 py-3">
                      当前没有额外风险提示，按主推荐先推进。
                    </li>
                  )}
                </ul>
              </article>

              <article className="soft-card">
                <p className="eyebrow">采购细节</p>
                <h3 className="mt-4 text-xl font-semibold">需要落地时再展开看细</h3>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      执行方式
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.procurement_brief.execution_mode}
                    </p>
                  </div>
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      建议数量
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.procurement_brief.recommended_quantity}
                    </p>
                  </div>
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      打样建议
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.procurement_brief.sample_plan}
                    </p>
                  </div>
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      包装建议
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.procurement_brief.packaging_plan}
                    </p>
                  </div>
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      定制强度
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.primary_recommendation.customization_level}
                    </p>
                  </div>
                  <div className="rounded-[18px] bg-white/72 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                      采购方向
                    </p>
                    <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                      {result.primary_recommendation.sourcing_tip}
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-[18px] bg-white/72 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                    品牌处理
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                    {result.procurement_brief.branding_note}
                  </p>
                </div>
              </article>
            </div>

            {result.backup_recommendations.length > 0 ? (
              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                  <div>
                    <p className="eyebrow">备选</p>
                    <h3 className="mt-4 text-xl font-semibold">
                      只有主推荐过不了，再看备选
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(
                        backupSummary,
                        "copy_backup_summary",
                        "备选摘要已复制。",
                      )
                    }
                    className="min-h-10 rounded-full border border-black/10 px-3 py-2 text-xs font-medium transition hover:bg-black/[0.04]"
                  >
                    复制备选摘要
                  </button>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  {result.backup_recommendations.map((gift, index) => (
                    <article key={`${gift.name}-${index}`} className="soft-card">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="eyebrow">备选 {index + 1}</p>
                          <h3 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">
                            {gift.name}
                          </h3>
	                          <p className="mt-2 text-sm font-medium text-[var(--muted)]">
	                            {gift.item_type}
	                          </p>
	                          {gift.gift_components.length > 0 ? (
	                            <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
	                              组成：{gift.gift_components.join(" + ")}
	                            </p>
	                          ) : null}
	                        </div>
	                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-[18px] bg-white/72 px-4 py-3">
                          <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                            建议价格
                          </p>
                          <p className="mt-2 text-sm leading-7">
                            {gift.target_unit_price}
                          </p>
                        </div>
                        <div className="rounded-[18px] bg-white/72 px-4 py-3">
                          <p className="text-xs uppercase tracking-[0.22em] text-[var(--accent)]">
                            交期
                          </p>
                          <p className="mt-2 text-sm leading-7">{gift.lead_time}</p>
                        </div>
                      </div>

	                      <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--muted)]">
	                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
	                          {gift.reason}
	                        </li>
	                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
	                          Relevant：{gift.why_relevant}
	                        </li>
	                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
	                          Unexpected：{gift.why_unexpected}
	                        </li>
	                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
	                          Novelty：{gift.why_novel}
	                        </li>
	                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
	                          定制：{gift.customization_level}
	                        </li>
                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
                          寄送：{gift.shipping_ease}
                        </li>
                        <li className="rounded-[18px] bg-white/72 px-4 py-3">
                          风险：{gift.caution}
                        </li>
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <details className="soft-card group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <div>
                  <p className="eyebrow">更多依据</p>
                  <h3 className="mt-3 text-xl font-semibold">需要解释时再展开</h3>
                </div>
                <span className="text-sm text-[var(--muted)] transition group-open:rotate-45">
                  +
                </span>
              </summary>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-[24px] border border-black/8 bg-white/70 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    客户判断
                  </p>
                  <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
                    {result.customer_summary}
                  </p>
                </div>

                <div className="rounded-[24px] border border-black/8 bg-white/70 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    抓到的线索
                  </p>
                  <ul className="mt-3 space-y-2 text-sm leading-7 text-[var(--muted)]">
                    {result.evidence_highlights.length > 0 ? (
                      result.evidence_highlights.map((item) => (
                        <li key={item} className="rounded-[16px] bg-white/76 px-3 py-2">
                          {item}
                        </li>
                      ))
                    ) : (
                      <li className="rounded-[16px] bg-white/76 px-3 py-2">
                        当前没有提取到额外公开线索。
                      </li>
                    )}
                  </ul>
                </div>

                <div className="rounded-[24px] border border-black/8 bg-white/70 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    还缺什么
                  </p>
                  <ul className="mt-3 space-y-2 text-sm leading-7 text-[var(--muted)]">
                    {result.analysis_gaps.length > 0 ? (
                      result.analysis_gaps.map((gap) => (
                        <li key={gap} className="rounded-[16px] bg-white/76 px-3 py-2">
                          {gap}
                        </li>
                      ))
                    ) : (
                      <li className="rounded-[16px] bg-white/76 px-3 py-2">
                        当前这一版没有明显缺口，可以直接按主推荐先执行。
                      </li>
                    )}
                  </ul>
                </div>

                <div className="rounded-[24px] border border-black/8 bg-white/70 p-5">
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    来源记录
                  </p>
                  <div className="mt-3 space-y-3">
                    {result.source_summary.length > 0 ? (
                      result.source_summary.map((source) => (
                        <div
                          key={`${source.url}-${source.status}-${source.label ?? ""}`}
                          className="rounded-[18px] bg-white/76 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <p className="break-all text-sm font-medium leading-6 text-[var(--foreground)]">
                              {sourceLabel(source)}
                            </p>
                            <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-medium text-[var(--muted)]">
                              {statusLabel(source.status)}
                            </span>
                          </div>
                          {source.evidence ? (
                            <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
                              {source.evidence}
                            </p>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-[18px] bg-white/76 p-4 text-sm leading-7 text-[var(--muted)]">
                        当前没有可展示的来源记录。
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </details>

            <div className="rounded-[28px] border border-black/8 bg-[rgba(255,255,255,0.72)] px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="eyebrow">继续细化</p>
                  <h3 className="mt-4 text-2xl font-semibold tracking-[-0.04em]">
                    {result.cta_message}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
                    如果你要把这张采购卡继续改成更贴合某个客户、某个老板审批习惯的版本，可以继续联系我细化。
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy(
                        siteConfig.contactHandle,
                        "copy_contact_handle",
                        "联系方式已复制。",
                      )
                    }
                    className="min-h-11 rounded-full bg-[var(--accent-strong)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-92"
                  >
                    复制联系方式
                  </button>
                  <span className="rounded-full border border-black/10 px-4 py-3 text-sm text-[var(--muted)]">
                    {siteConfig.contactHandle}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
