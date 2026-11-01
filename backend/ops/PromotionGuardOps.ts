import type { Channel } from "../schema/channels";

/**
 * **Memory of one customer stays with that customer.** A Pylon channel is a
 * customer account, and its memory holds that customer's setup, history, and
 * people. Promoting a fact to project memory, where every bot reads it while
 * working every other customer, is allowed only for a fact that names no
 * customer: not the account's name, and none of its domains (nor a domain's
 * name without its suffix, `acme` of `acme.com`).
 *
 * | Channel | Fact | Then |
 * |---|---|---|
 * | not a customer account (`pylon`) | any | promoted |
 * | a customer account | names the account or a domain | refused, naming what it found |
 * | a customer account | names neither | promoted |
 */

/** The channel types whose channels are customers. */
const CUSTOMER_CHANNEL_TYPES = ["pylon"];

/**
 * Escape a string for a regular expression.
 * @param s - The string.
 * @returns It, escaped.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What in a fact names the channel's customer.
 * @param channel - The channel the fact was learned in.
 * @param content - The fact.
 * @returns The name or domain found, or `null` when the fact names none.
 */
export function customerNamedIn(
  channel: Pick<Channel, "type" | "name" | "details">,
  content: string,
): string | null {
  if (!CUSTOMER_CHANNEL_TYPES.includes(channel.type)) return null;
  const domains = ((channel.details ?? {}) as { domains?: unknown }).domains;
  const names = new Set<string>();
  const accountName = channel.name.trim();
  if (accountName.length >= 3 && !/^Account [0-9a-f-]{1,8}$/i.test(accountName))
    names.add(accountName);
  for (const d of Array.isArray(domains) ? domains : []) {
    if (typeof d !== "string" || d.trim() === "") continue;
    const domain = d.trim().toLowerCase();
    names.add(domain);
    const stem = domain.split(".")[0];
    if (stem.length >= 3) names.add(stem);
  }
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(^|\\W)${escapeRegExp(name)}(?!\\w)`, "i").test(content)) {
      return name;
    }
  }
  return null;
}
