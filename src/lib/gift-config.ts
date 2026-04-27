import type { BudgetTier, Occasion } from "./types";

export const DEFAULT_OCCASION: Occasion = "trade_show_follow_up";
export const DEFAULT_BUDGET_TIER: BudgetTier = "300_800_cny";

export const OCCASION_META: Record<
  Occasion,
  {
    label: string;
    hint: string;
    decision_goal: string;
    timing_note: string;
  }
> = {
  trade_show_follow_up: {
    label: "展会后跟进",
    hint: "刚见过面，记忆还热，礼物要轻巧、得体、好寄送。",
    decision_goal: "在展会结束后的大量联系人里，让客户更容易记住你。",
    timing_note: "建议在展会后 3-10 天内寄出或安排递送。",
  },
  first_visit: {
    label: "初次拜访前",
    hint: "第一次正式见面前，礼物要稳，不要过重或过度表达。",
    decision_goal: "让第一次见面显得有准备，但不要造成压力。",
    timing_note: "建议在线下首次见面时携带或在会前送达。",
  },
  client_visit: {
    label: "客户来访接待",
    hint: "客户到访现场，礼物要方便交付，也要利于带走。",
    decision_goal: "让来访体验更完整，并留下一个可带走的记忆点。",
    timing_note: "建议在接待尾声递交，避免一开始就显得过重。",
  },
};

export const BUDGET_META: Record<
  BudgetTier,
  {
    label: string;
    hint: string;
    price_band: string;
  }
> = {
  "100_300_cny": {
    label: "人民币 100-300",
    hint: "轻预算，更看重判断力和细节表达。",
    price_band: "轻量但不能廉价感强",
  },
  "300_800_cny": {
    label: "人民币 300-800",
    hint: "最适合做有记忆点的商务礼物，兼顾质感和可执行性。",
    price_band: "主流商务礼预算带",
  },
  "800_1500_cny": {
    label: "人民币 800-1500",
    hint: "预算更充足，但仍应避免显得太重或太夸张。",
    price_band: "偏高预算，适合更完整的礼盒或桌面件",
  },
};

export function isOccasion(value: string): value is Occasion {
  return value in OCCASION_META;
}

export function isBudgetTier(value: string): value is BudgetTier {
  return value in BUDGET_META;
}

export function getOccasionMeta(occasion: Occasion) {
  return OCCASION_META[occasion];
}

export function getBudgetMeta(budgetTier: BudgetTier) {
  return BUDGET_META[budgetTier];
}
