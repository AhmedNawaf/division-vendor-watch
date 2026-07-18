import type { ItemMatch } from "../matcher/match-items.js";
import type { VendorItem } from "../types/vendor.js";
import { vendorLine } from "./vendor-locations.js";

/** Discord hard limit for a single message's content field. */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export interface FormatOptions {
  header?: string;
  resetDate?: string;
  /** Override the per-message length budget (mainly for tests). */
  maxMessageLength?: number;
  /** Credit line for the upstream data source. Pass `false` to omit. */
  sourceCredit?: string | false;
  /** Warning shown when the stock came from a degraded/incomplete source. */
  sourceNotice?: string;
}

const DEFAULT_TITLE = "🛒 **Weekly Vendor Watch**";

/**
 * The vendor stock is hand-compiled and published for free by Ruben Alamina. There is no
 * official Ubisoft API and no independent source, so the least we can do is say where it
 * came from.
 */
export const SOURCE_CREDIT = "📖 Data: rubenalamina.mx";

function buildHeader(
  title: string,
  resetDate: string | undefined,
  matchCount: number,
  credit: string | false,
  notice: string | undefined,
): string {
  const lines = [title];
  if (resetDate) lines.push(`📅 Next reset: ${resetDate}`);
  lines.push(`🎯 ${matchCount} ${matchCount === 1 ? "match" : "matches"}`);
  if (notice) lines.push(`⚠️ ${notice}`);
  if (credit !== false) lines.push(credit);
  return lines.join("\n");
}

function itemMarker(item: VendorItem): string {
  if (item.isNamed) return "⭐";
  if (item.gearSet) return "✨";
  return "▫️";
}

/**
 * Render one matched item as three dense lines: what it is, where to buy it, what it rolls.
 *
 * The earlier layout gave every attribute its own line under its own heading, so a single item
 * ran to a dozen lines and a normal week's alert became a wall of text you had to scroll rather
 * than scan. Discord also caps a message at 2000 characters, so verbosity directly costs items
 * per message.
 */
export function formatItemBlock(match: ItemMatch): string {
  const { item } = match;

  // What it is: name, then the qualifiers that identify it at a glance.
  const identity = [`${itemMarker(item)} **${item.name}**`];
  if (item.slot) identity.push(item.slot);
  if (item.gearSet) identity.push(item.gearSet);
  else if (item.brand) identity.push(item.brand);

  // What it rolls: core first (it is the defining stat), then attributes, then the talent.
  const stats = [
    ...(item.coreAttribute ? [item.coreAttribute.rawValue] : []),
    ...item.attributes.map((attr) => attr.rawValue),
    ...(item.talent ? [item.talent] : []),
  ];

  const lines = [identity.join(" · "), vendorLine(item.vendor)];
  if (stats.length > 0) lines.push(stats.join(" · "));
  return lines.join("\n");
}

/** Split an oversized single block across messages on line boundaries as a last resort. */
function hardSplit(block: string, limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      out.push(current);
      current = line.length > limit ? line.slice(0, limit) : line;
    } else {
      current = candidate.length > limit ? candidate.slice(0, limit) : candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Format matches into Discord-ready message strings, each within the length limit.
 * Returns an empty array when there is nothing to report.
 */
export function formatAlerts(matches: ItemMatch[], options: FormatOptions = {}): string[] {
  if (matches.length === 0) return [];

  const limit = options.maxMessageLength ?? DISCORD_MAX_MESSAGE_LENGTH;
  const title = options.header ?? DEFAULT_TITLE;
  const header = buildHeader(
    title,
    options.resetDate,
    matches.length,
    options.sourceCredit ?? SOURCE_CREDIT,
    options.sourceNotice,
  );
  const contHeader = `${title} (continued)`;

  const blocks = matches.map((match) => formatItemBlock(match));
  const messages: string[] = [];
  let currentHeader = header;
  let current = currentHeader;

  const flush = () => {
    if (current !== currentHeader) messages.push(current);
    currentHeader = contHeader;
    current = currentHeader;
  };

  for (const block of blocks) {
    const separator = "\n\n";
    const candidate = `${current}${separator}${block}`;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    // Block doesn't fit after the current header. Start a fresh message.
    flush();

    const standalone = `${currentHeader}\n\n${block}`;
    if (standalone.length <= limit) {
      current = standalone;
    } else {
      // Even a fresh message can't hold this block: hard-split it.
      const parts = hardSplit(block, limit);
      for (let i = 0; i < parts.length; i += 1) {
        if (i === 0) {
          messages.push(`${currentHeader}\n\n${parts[i]}`.slice(0, limit));
        } else {
          messages.push(parts[i]!.slice(0, limit));
        }
      }
      currentHeader = contHeader;
      current = currentHeader;
    }
  }

  if (current !== currentHeader) messages.push(current);
  return messages;
}
