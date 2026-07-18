import type { PayloadType } from "./vendor-source.js";

/**
 * A community mirror of the vendor JSON, used only as a fallback when the primary source is
 * unreachable. `mxswat/mx-division-builds` syncs the files via a GitHub Action that curls
 * rubenalamina.mx, so it is the same data — just delayed, and only as complete as its last sync.
 *
 * Two hazards make a freshness gate mandatory rather than optional:
 *  - The sync only covers gear and weapons. Its `mods.json` has not been touched since Feb 2021,
 *    so serving it would alert users about five-year-old stock.
 *  - Even for the synced files, a lagging copy can predate the current reset.
 *
 * We therefore ask GitHub when each file was last committed and drop any payload that is older
 * than the current reset instant. The dead `mods.json` fails that check on its own, so it needs
 * no special-casing — and a payload dropped here is simply not alerted this run. Because dedup is
 * per item fingerprint, anything we skip is picked up by the next successful primary run.
 */

const DEFAULT_MIRROR_BASE =
  "https://raw.githubusercontent.com/mxswat/mx-division-builds/master/public/vendors";

const MIRROR_COMMITS_API = "https://api.github.com/repos/mxswat/mx-division-builds/commits";
const MIRROR_PATH_PREFIX = "public/vendors";

export interface MirrorOptions {
  /** Base URL holding `<type>.json`. Overridable for tests. */
  baseUrl?: string;
  /** Endpoint used to establish per-file freshness. Overridable for tests. */
  commitsApi?: string;
}

/**
 * When the mirror's copy of `<type>.json` was last updated, or undefined if that can't be
 * established. Undefined is treated as "not fresh" by callers — we never guess in the
 * permissive direction, because the cost of being wrong is alerting on dead stock.
 */
export async function mirrorFileUpdatedAt(
  type: PayloadType,
  fetchImpl: typeof fetch,
  userAgent: string,
  signal: AbortSignal | undefined,
  options: MirrorOptions = {},
): Promise<Date | undefined> {
  const api = options.commitsApi ?? MIRROR_COMMITS_API;
  const url = `${api}?path=${encodeURIComponent(`${MIRROR_PATH_PREFIX}/${type}.json`)}&per_page=1`;

  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": userAgent, accept: "application/vnd.github+json" },
      signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Array<{ commit?: { committer?: { date?: string } } }>;
    const raw = body?.[0]?.commit?.committer?.date;
    if (typeof raw !== "string") return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    // Freshness unknown → caller drops the payload. Never throw from the fallback path.
    return undefined;
  }
}

export function mirrorUrl(type: PayloadType, options: MirrorOptions = {}): string {
  return `${options.baseUrl ?? DEFAULT_MIRROR_BASE}/${type}.json`;
}
