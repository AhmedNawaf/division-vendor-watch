import type { ItemMatch } from "../matcher/match-items.js";
import type { VendorItem } from "../types/vendor.js";

/** Discord hard limit for a single message's content field. */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export interface FormatOptions {
  header?: string;
  resetDate?: string;
  /** Override the per-message length budget (mainly for tests). */
  maxMessageLength?: number;
  /** Include the "Reason:" section explaining why each item matched. Defaults to true. */
  showReasons?: boolean;
}

const DEFAULT_TITLE = "🛒 **Weekly Vendor Watch**";

function buildHeader(title: string, resetDate: string | undefined, matchCount: number): string {
  const lines = [title];
  if (resetDate) lines.push(`📅 Next reset: ${resetDate}`);
  lines.push(`🎯 ${matchCount} ${matchCount === 1 ? "match" : "matches"}`);
  return lines.join("\n");
}

function itemMarker(item: VendorItem): string {
  if (item.isNamed) return "⭐";
  if (item.gearSet) return "✨";
  return "▫️";
}

/** Render one matched item into a self-contained text block. */
export function formatItemBlock(match: ItemMatch, showReasons = true): string {
  const { item } = match;
  const lines: string[] = [];
  lines.push(`${itemMarker(item)} ${item.name}`);
  lines.push(`Vendor: ${item.vendor}`);

  if (item.gearSet) lines.push(`Set: ${item.gearSet}`);
  else if (item.brand) lines.push(`Brand: ${item.brand}`);

  if (item.coreAttribute) {
    lines.push("", "Core:", item.coreAttribute.rawValue);
  }

  if (item.attributes.length > 0) {
    lines.push("", "Attributes:");
    for (const attr of item.attributes) lines.push(attr.rawValue);
  }

  if (item.talent) {
    lines.push("", `Talent: ${item.talent}`);
  }

  if (showReasons && match.reasons.length > 0) {
    lines.push("", "Reason:");
    for (const reason of match.reasons) lines.push(`- ${reason}`);
  }

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
  const header = buildHeader(title, options.resetDate, matches.length);
  const contHeader = `${title} (continued)`;

  const showReasons = options.showReasons ?? true;
  const blocks = matches.map((match) => formatItemBlock(match, showReasons));
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
