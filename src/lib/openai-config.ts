const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export interface ResolvedOpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function normalizeBaseUrl(value?: string) {
  return (value ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
}

export function resolveOpenAIConfig(): ResolvedOpenAIConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL);
  const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;

  return {
    apiKey,
    baseUrl,
    model,
  };
}
