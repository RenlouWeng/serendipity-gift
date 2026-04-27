const URL_REGEX = /https?:\/\/[^\s,;]+/gi;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const DOMAIN_REGEX =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

function trimCandidate(value: string) {
  return value.replace(/[),.;]+$/g, "").trim();
}

export function normalizeLink(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeLinks(links: string[], limit = 5) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of links) {
    const value = normalizeLink(candidate);

    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

export function extractLinksFromCustomerInput(input: string, limit = 5) {
  if (!input.trim()) {
    return [];
  }

  const rawMatches: string[] = [];
  const text = input.trim();

  for (const match of text.match(URL_REGEX) ?? []) {
    rawMatches.push(trimCandidate(match));
  }

  for (const match of text.matchAll(EMAIL_REGEX)) {
    rawMatches.push(match[1]);
  }

  for (const match of text.match(DOMAIN_REGEX) ?? []) {
    rawMatches.push(trimCandidate(match));
  }

  return normalizeLinks(rawMatches, limit);
}

export function stripLinksFromCustomerInput(input: string) {
  return input
    .replace(URL_REGEX, " ")
    .replace(EMAIL_REGEX, " ")
    .replace(DOMAIN_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function guessCompanyName(customerInput: string, links: string[]) {
  const lines = customerInput
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const withoutUrl = line.replace(URL_REGEX, " ").replace(EMAIL_REGEX, " ").trim();

    if (!withoutUrl) {
      continue;
    }

    if (withoutUrl.length >= 2 && withoutUrl.length <= 80) {
      return withoutUrl.replace(/\s+/g, " ");
    }
  }

  const firstLink = links[0];

  if (!firstLink) {
    return "";
  }

  try {
    return new URL(firstLink).hostname.replace(/^www\./, "");
  } catch {
    return firstLink;
  }
}
