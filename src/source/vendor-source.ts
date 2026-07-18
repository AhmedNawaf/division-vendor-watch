import { VendorSourceError } from "../errors.js";
import { mirrorFileUpdatedAt, mirrorUrl, type MirrorOptions } from "./mirror.js";

export type PayloadType = "gear" | "weapons" | "mods";

export type SourceOrigin = "primary" | "mirror";

export interface RawVendorPayload {
  type: PayloadType;
  url: string;
  records: unknown[];
  /** Server `Last-Modified`, echoed back on the next run as `If-Modified-Since`. */
  lastModified?: string;
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
  /** Which source served this data. */
  origin: SourceOrigin;
  /**
   * True when every payload answered 304 Not Modified, so `payloads` is empty. The caller
   * should serve items from its own cache rather than treating this as "no stock".
   */
  notModified?: boolean;
  /** Payload types that could not be served (e.g. a mirror file too stale to trust). */
  missing?: PayloadType[];
}

export interface SourceLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface VendorSourceOptions {
  vendorUrl: string;
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Per-payload `Last-Modified` values from a previous successful fetch. When all three are
   * unchanged the source answers 304 and we skip the transfer entirely.
   */
  ifModifiedSince?: Partial<Record<PayloadType, string>>;
  /** Community-mirror fallback when the primary source fails. Off unless provided. */
  mirror?: MirrorOptions;
  /**
   * Reject mirror payloads last updated before this instant — pass the current reset instant.
   * Required for the mirror to be used at all; without it we cannot prove freshness.
   */
  mirrorFresherThan?: Date;
  logger?: SourceLogger;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "division-vendor-watch/0.1 (personal project; respectful weekly checks)";

/** Below these sizes a 200 response is almost certainly an error/placeholder page. */
const MIN_HTML_BYTES = 500;
const MIN_JSON_BYTES = 3;

const PAYLOAD_TYPES: PayloadType[] = ["gear", "weapons", "mods"];

const noopLogger: SourceLogger = { info: () => {}, warn: () => {} };

interface ResolvedOptions {
  timeoutMs: number;
  userAgent: string;
  fetchImpl: typeof fetch;
}

interface FetchTextResult {
  text: string;
  contentType: string;
  status: number;
  url: string;
  lastModified?: string;
  /** True when the server answered 304 and `text` is empty. */
  notModified?: boolean;
}

interface ExpectOptions {
  /** Skipped when undefined — the GitHub raw mirror serves JSON as text/plain. */
  contentTypeIncludes?: string;
  minBytes: number;
  ifModifiedSince?: string;
}

async function fetchText(
  url: string,
  opts: ResolvedOptions,
  expect: ExpectOptions,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/json",
  };
  if (expect.ifModifiedSince) headers["if-modified-since"] = expect.ifModifiedSince;

  let res: Response;
  try {
    res = await opts.fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
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

  const lastModified = res.headers.get("last-modified") ?? undefined;

  if (res.status === 304) {
    return { text: "", contentType: "", status: 304, url, lastModified, notModified: true };
  }

  if (!res.ok) {
    throw new VendorSourceError(`Unexpected HTTP ${res.status} fetching ${url}`, {
      url,
      status: res.status,
    });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (
    expect.contentTypeIncludes &&
    !contentType.toLowerCase().includes(expect.contentTypeIncludes)
  ) {
    throw new VendorSourceError(
      `Unexpected content-type "${contentType}" for ${url} (expected ${expect.contentTypeIncludes})`,
      { url, contentType },
    );
  }

  const text = await res.text();
  if (text.length < expect.minBytes) {
    throw new VendorSourceError(`Suspiciously small response (${text.length} bytes) from ${url}`, {
      url,
      bytes: text.length,
    });
  }

  return { text, contentType, status: res.status, url, lastModified };
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

  const missing = PAYLOAD_TYPES.filter((t) => !urls[t]);
  if (missing.length > 0) {
    throw new VendorSourceError(
      `Vendor page structure changed: could not find loader URLs for ${missing.join(", ")}`,
      { missing, foundCalls: matches.length, structural: true },
    );
  }

  return { urls: urls as Record<PayloadType, string>, resetDate };
}

function parseJsonArray(text: string, url: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new VendorSourceError(
      `Response from ${url} was not valid JSON`,
      { url, structural: true },
      { cause: err },
    );
  }
  if (!Array.isArray(data)) {
    throw new VendorSourceError(`Expected a JSON array from ${url}`, { url, structural: true });
  }
  return data;
}

/**
 * Whether an error means "the source changed shape" rather than "the source was unreachable".
 * Shape changes must never trigger the mirror fallback: the mirror carries a copy of the same
 * upstream data, so it would likely be broken identically, and swapping sources would bury the
 * breakage we need to see.
 */
function isStructuralError(err: unknown): boolean {
  return (
    err instanceof VendorSourceError &&
    typeof err.context === "object" &&
    err.context !== null &&
    (err.context as Record<string, unknown>).structural === true
  );
}

/** Fetch the three JSON payloads from the primary source, honouring conditional requests. */
async function fetchPrimaryPayloads(
  urls: Record<PayloadType, string>,
  resolved: ResolvedOptions,
  ifModifiedSince: Partial<Record<PayloadType, string>>,
): Promise<{ payloads: RawVendorPayload[]; notModified: boolean }> {
  const results = new Map<PayloadType, FetchTextResult>();
  for (const type of PAYLOAD_TYPES) {
    results.set(
      type,
      await fetchText(urls[type], resolved, {
        contentTypeIncludes: "json",
        minBytes: MIN_JSON_BYTES,
        ifModifiedSince: ifModifiedSince[type],
      }),
    );
  }

  // All unchanged → tell the caller to use its cache instead of transferring anything.
  if (PAYLOAD_TYPES.every((type) => results.get(type)!.notModified)) {
    return { payloads: [], notModified: true };
  }

  const payloads: RawVendorPayload[] = [];
  for (const type of PAYLOAD_TYPES) {
    let result = results.get(type)!;
    // Something changed, so we need a complete set: re-fetch the ones that answered 304.
    if (result.notModified) {
      result = await fetchText(urls[type], resolved, {
        contentTypeIncludes: "json",
        minBytes: MIN_JSON_BYTES,
      });
    }
    payloads.push({
      type,
      url: result.url,
      records: parseJsonArray(result.text, result.url),
      lastModified: result.lastModified,
    });
  }
  return { payloads, notModified: false };
}

/**
 * Fetch from the community mirror, keeping only payloads provably newer than `fresherThan`.
 * Returns the payloads it could vouch for plus the types it had to drop.
 */
async function fetchMirrorPayloads(
  resolved: ResolvedOptions,
  mirror: MirrorOptions,
  fresherThan: Date,
  log: SourceLogger,
): Promise<{ payloads: RawVendorPayload[]; missing: PayloadType[] }> {
  const payloads: RawVendorPayload[] = [];
  const missing: PayloadType[] = [];

  for (const type of PAYLOAD_TYPES) {
    const url = mirrorUrl(type, mirror);
    const updatedAt = await mirrorFileUpdatedAt(
      type,
      resolved.fetchImpl,
      resolved.userAgent,
      undefined,
      mirror,
    );

    if (!updatedAt || updatedAt.getTime() < fresherThan.getTime()) {
      log.warn(
        `Mirror ${type}.json rejected as stale (last updated ` +
          `${updatedAt ? updatedAt.toISOString() : "unknown"}, need >= ${fresherThan.toISOString()})`,
      );
      missing.push(type);
      continue;
    }

    try {
      // GitHub raw serves JSON as text/plain, so content-type is not checked here.
      const result = await fetchText(url, resolved, { minBytes: MIN_JSON_BYTES });
      payloads.push({
        type,
        url,
        records: parseJsonArray(result.text, url),
        // Deliberately no lastModified: mirror stamps must never seed conditional
        // requests against the primary source.
      });
    } catch (err) {
      log.warn(`Mirror ${type}.json fetch failed: ${err instanceof Error ? err.message : err}`);
      missing.push(type);
    }
  }

  return { payloads, missing };
}

/** Fetches the vendor index page, discovers the JSON endpoints, and fetches them. */
export async function fetchVendorData(options: VendorSourceOptions): Promise<RawVendorData> {
  const resolved: ResolvedOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const log = options.logger ?? noopLogger;
  const fetchedAt = new Date().toISOString();

  try {
    const page = await fetchText(options.vendorUrl, resolved, {
      contentTypeIncludes: "text/html",
      minBytes: MIN_HTML_BYTES,
    });
    const { urls, resetDate } = discoverPayloadUrls(page.text, page.url);
    const { payloads, notModified } = await fetchPrimaryPayloads(
      urls,
      resolved,
      options.ifModifiedSince ?? {},
    );

    if (notModified) log.info("Vendor source unchanged since last run (HTTP 304).");

    return {
      sourceUrl: options.vendorUrl,
      resetDate,
      fetchedAt,
      payloads,
      origin: "primary",
      ...(notModified ? { notModified: true } : {}),
    };
  } catch (primaryError) {
    // The mirror exists for availability, not for correctness: fall back only on transport
    // failures, never on a shape change (see isStructuralError).
    if (isStructuralError(primaryError)) throw primaryError;
    if (!options.mirror || !options.mirrorFresherThan) throw primaryError;

    log.warn(
      `Primary vendor source failed (${
        primaryError instanceof Error ? primaryError.message : String(primaryError)
      }); trying the community mirror.`,
    );

    const { payloads, missing } = await fetchMirrorPayloads(
      resolved,
      options.mirror,
      options.mirrorFresherThan,
      log,
    );

    if (payloads.length === 0) {
      throw new VendorSourceError(
        "Primary vendor source failed and no mirror payload was fresh enough to trust",
        { missing },
        { cause: primaryError },
      );
    }

    log.warn(
      `Serving DEGRADED data from the mirror: ${payloads.map((p) => p.type).join(", ")}` +
        (missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""),
    );

    return {
      sourceUrl: options.vendorUrl,
      fetchedAt,
      payloads,
      origin: "mirror",
      ...(missing.length > 0 ? { missing } : {}),
    };
  }
}
