import type { ModelConnectionCreate } from "@backend/actions/model-connection/model-connection-create";
import type { ActionParams } from "keryx";

/** A provider kind, as `model-connection:create` takes it. */
export type ModelProviderKind = ActionParams<ModelConnectionCreate>["provider"];

/** One provider a person may connect, as the add form offers it. */
export interface ProviderOption {
  kind: ModelProviderKind;
  label: string;
  /** Whether a connection of this kind must name its own base URL. */
  needsBaseUrl: boolean;
  /** What the base URL field shows when it is left empty. */
  placeholder: string;
}

/**
 * The providers, in the order the add form offers them. The labels repeat the
 * server's registry (a connection row carries its own `providerLabel`, which
 * is what a list shows); the kinds are checked against the action's input type,
 * so a kind the server drops is a type error here.
 */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    kind: "anthropic",
    label: "Anthropic",
    needsBaseUrl: false,
    placeholder: "https://api.anthropic.com/v1",
  },
  {
    kind: "openai",
    label: "OpenAI",
    needsBaseUrl: false,
    placeholder: "https://api.openai.com/v1",
  },
  {
    kind: "gateway",
    label: "Vercel AI Gateway",
    needsBaseUrl: false,
    placeholder: "https://ai-gateway.vercel.sh/v4/ai",
  },
  {
    kind: "openai-compatible",
    label: "OpenAI-compatible",
    needsBaseUrl: true,
    placeholder: "https://models.example.com/v1",
  },
];

/**
 * The add form's option for a kind.
 * @param kind - The provider kind.
 * @returns Its option; the first one for a kind the list lacks.
 */
export function providerOption(kind: string): ProviderOption {
  return (
    PROVIDER_OPTIONS.find((option) => option.kind === kind) ??
    (PROVIDER_OPTIONS[0] as ProviderOption)
  );
}

/** The state of a connection's last probe, as the server reports it. */
export type ConnectionStatus = "unverified" | "ok" | "error";

/**
 * What a connection's status glyph says.
 * @param status - The connection's `status`.
 * @returns A short phrase for the glyph's label and the row.
 */
export function connectionStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "Key works";
    case "error":
      return "Last test failed";
    default:
      return "Not tested yet";
  }
}

/**
 * A key as a list may show it: never the key, only its last four characters.
 * @param lastFour - The connection's `lastFour`.
 * @returns `…abcd`.
 */
export function maskedKey(lastFour: string): string {
  return `…${lastFour}`;
}

/** The access-list entry that means every member. */
export const ACCESS_EVERYONE = "*";

/**
 * Whether an access list lets every member through: empty, or naming `*`.
 * @param list - A bot's `accessRead` or `accessWrite`.
 * @returns `true` when the list is open to every member.
 */
export function isOpenToEveryone(list: readonly string[]): boolean {
  return list.length === 0 || list.includes(ACCESS_EVERYONE);
}

/**
 * An access list in words, for a properties panel or a list row.
 * @param list - A bot's `accessRead` or `accessWrite`.
 * @returns "Every member", or the tags it names.
 */
export function describeAccess(list: readonly string[]): string {
  return isOpenToEveryone(list) ? "Every member" : list.join(", ");
}

/**
 * The tags an access list's checkboxes start from: the named tags, and none
 * when the list is open (`*` is not a tag a person checks).
 * @param list - A bot's `accessRead` or `accessWrite`.
 * @returns The tag names to show checked.
 */
export function checkedTags(list: readonly string[]): string[] {
  return list.filter((entry) => entry !== ACCESS_EVERYONE);
}

/**
 * Read a number field that may be left empty.
 * @param text - What the person typed.
 * @returns The number, `null` for an empty field, or `undefined` when it is not a number.
 */
export function optionalNumber(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
