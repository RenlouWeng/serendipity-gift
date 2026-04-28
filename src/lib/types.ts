export type Occasion =
  | "trade_show_follow_up"
  | "first_visit"
  | "client_visit";

export type BudgetTier =
  | "100_300_cny"
  | "300_800_cny"
  | "800_1500_cny";

export type AnalysisConfidence = "high" | "medium" | "low";

export interface AnalyzeRequest {
  customer_input?: string;
  company_name?: string;
  links?: string[];
  occasion?: Occasion;
  budget_tier?: BudgetTier;
  recipient_role?: string;
  target_region?: string;
  note?: string;
  person_traits?: string[];
  person_interests?: string[];
  recent_chat?: string;
  person_impression?: string;
}

export interface SourceSummary {
  url: string;
  label?: string;
  status: "used" | "unavailable";
  evidence?: string;
}

export interface GiftIdeaWithReasoning {
  name: string;
  item_type: string;
  gift_components: string[];
  reason: string;
  why_relevant: string;
  why_unexpected: string;
  why_novel: string;
  business_fit: string;
  why_now: string;
  budget_fit: string;
  target_unit_price: string;
  lead_time: string;
  customization_level: string;
  shipping_ease: string;
  sourcing_tip: string;
  approval_hint: string;
  caution: string;
  message_snippet: string;
}

export interface ProcurementBrief {
  execution_mode: string;
  recommended_quantity: string;
  sample_plan: string;
  packaging_plan: string;
  branding_note: string;
  supplier_message: string;
}

export interface AnalyzeResponse {
  customer_summary: string;
  decision_summary: string;
  analysis_confidence: AnalysisConfidence;
  analysis_gaps: string[];
  evidence_highlights: string[];
  recipient_anchors: string[];
  recipient_role: string;
  target_region: string;
  primary_recommendation: GiftIdeaWithReasoning;
  procurement_brief: ProcurementBrief;
  backup_recommendations: GiftIdeaWithReasoning[];
  follow_up_message: string;
  risk_notes: string[];
  source_summary: SourceSummary[];
  cta_message: string;
  mode: "ai" | "fallback";
}
