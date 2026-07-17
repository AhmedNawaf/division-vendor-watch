import { VendorSourceError } from "../errors.js";

export type PayloadType = "gear" | "weapons" | "mods";

export interface RawVendorPayload {
  type: PayloadType;
  url: string;
  records: unknown[];
}

export interface RawVendorData {
  sourceUrl: string;
  /**
   * The JSON cache-buster date from the loader script (the site's last-updated date), as
   * YYYY-MM-DD. This is NOT the in-game reset — see reset-schedule.ts for the real reset.
   */
  resetDate?: string;
  fetchedAt: string;
  payloads: RawVendorPayload[];
}

export interface VendorSourceOptions {
  vendorUrl: string;
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "division-vendor-watch/0.1 (personal project; respectful weekly checks)";

/** Below these sizes a 200 response is almost certainly an error/placeholder page. */
const MIN_HTML_BYTES = 500;
const MIN_JSON_BYTES = 3;

interface FetchTextResult {
  text: string;
  contentType: string;
  status: number;
  url: string;
}

async function fetchText(
  url: string,
  opts: Required<Pick<VendorSourceOptions, "timeoutMs" | "userAgent" | "fetchImpl">>,
  expect: { contentTypeIncludes: string; minBytes: number },
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      headers: { "user-agent": opts.userAgent, accept: "text/html,application/json" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new VendorSourceError(
      aborted
        ? `Timed out after ${opts.timeoutMs}ms fetching ${url}`
        : `Network error fetching ${url}`,
      { url, timeoutMs: opts.timeoutMs },
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new VendorSourceError(`Unexpected HTTP ${res.status} fetching ${url}`, {
      url,
      status: res.status,
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(expect.contentTypeIncludes)) {
    throw new VendorSourceError(
      `Unexpected content-type "${contentType}" for ${url} (expected ${expect.contentTypeIncludes})`,
      { url, contentType },
    );
  }

  const text = await res.text();
  if (text.length < expect.minBytes) {
    throw new VendorSourceError(
      `Suspiciously small response (${text.length} bytes) from ${url}`,
      { url, bytes: text.length },
    );
  }

  return { text, contentType, status: res.status, url };
}

/**
 * Extracts the three `loadData('/division/<type>.json?YYYYMMDD')` URLs the page's
 * loader script requests. This keeps us robust to the reset date changing and
 * fails loudly if the page structure changes.
 */
export function discoverPayloadUrls(
  html: string,
  baseUrl: string,
): { urls: Record<PayloadType, string>; resetDate?: string } {
  const matches = [...html.matchAll(/loadData\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
  const urls: Partial<Record<PayloadType, string>> = {};
  let resetDate: string | undefined;

  for (const raw of matches) {
    const absolute = new URL(raw, baseUrl).toString();
    const type: PayloadType | undefined = /gear\.json/i.test(raw)
      ? "gear"
      : /weapons\.json/i.test(raw)
        ? "weapons"
        : /mods\.json/i.test(raw)
          ? "mods"
          : undefined;
    if (!type) continue;
    urls[type] = absolute;
    if (!resetDate) {
      const query = raw.split("?")[1] ?? "";
      const dateMatch = query.match(/(\d{4})(\d{2})(\d{2})/);
      if (dateMatch) resetDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }
  }

  const missing = (["gear", "weapons", "mods"] as const).filter((t) => !urls[t]);
  if (missing.length > 0) {
    throw new VendorSourceError(
      `Vendor page structure changed: could not find loader URLs for ${missing.join(", ")}`,
      { missing, foundCalls: matches.length },
    );
  }

  return {
    urls: urls as Record<PayloadType, string>,
    resetDate,
  };
}

function parseJsonArray(text: string, url: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new VendorSourceError(`Response from ${url} was not valid JSON`, { url }, { cause: err });
  }
  if (!Array.isArray(data)) {
    throw new VendorSourceError(`Expected a JSON array from ${url}`, { url });
  }
  return data;
}

/** Fetches the vendor index page, discovers the JSON endpoints, and fetches them. */
export async function fetchVendorData(options: VendorSourceOptions): Promise<RawVendorData> {
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    fetchImpl: options.fetchImpl ?? fetch,
  };

  const page = await fetchText(options.vendorUrl, resolved, {
    contentTypeIncludes: "text/html",
    minBytes: MIN_HTML_BYTES,
  });

  const { urls, resetDate } = discoverPayloadUrls(page.text, page.url);

  const types: PayloadType[] = ["gear", "weapons", "mods"];
  const payloads: RawVendorPayload[] = [];
  for (const type of types) {
    const url = urls[type];
    const result = await fetchText(url, resolved, {
      contentTypeIncludes: "json",
      minBytes: MIN_JSON_BYTES,
    });
    payloads.push({ type, url, records: parseJsonArray(result.text, url) });
  }

  return {
    sourceUrl: options.vendorUrl,
    resetDate,
    fetchedAt: new Date().toISOString(),
    payloads,
  };
}
