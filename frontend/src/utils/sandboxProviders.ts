import type { ConnectionList } from "@backend/actions/connection/connection-list";
import type { ProjectSettingsView } from "@backend/actions/project/project-settings-view";
import type { SandboxLedgerList } from "@backend/actions/sandbox-ledger/sandbox-ledger-list";
import type { ActionResponse } from "keryx";

/** `project:settings-view`'s whole answer: the settings, the providers, the connection kinds. */
export type ProjectSettingsAnswer = ActionResponse<ProjectSettingsView>;

/** One sandbox provider this deployment knows, as `project:settings-view` describes it. */
export type SandboxProviderInfo = ProjectSettingsAnswer["providers"][number];

/** One kind of connection a project may add, and the fields it takes. */
export type ConnectionKindInfo =
  ProjectSettingsAnswer["connectionKinds"][number];

/** A project connection as `connection:list` serializes it — never with its token. */
export type ProjectConnection =
  ActionResponse<ConnectionList>["connections"][number];

/** One row of the sandbox ledger, with its job. */
export type LedgerSandbox =
  ActionResponse<SandboxLedgerList>["sandboxes"][number];

/** What a ledger row says it was given. */
export type SandboxResources = NonNullable<LedgerSandbox["resources"]>;

/**
 * The provider the settings form is describing: the one chosen in the menu,
 * or — when the menu says "the deployment's default" — the default the
 * server reports.
 * @param providers - The providers the server describes.
 * @param chosen - The menu's value; blank for the deployment's default.
 * @param defaultProvider - The deployment's default, as the server reports it.
 * @returns The provider, or `null` when it is not one the server describes.
 */
export function providerFor(
  providers: readonly SandboxProviderInfo[],
  chosen: string,
  defaultProvider: string | null,
): SandboxProviderInfo | null {
  const kind = chosen || defaultProvider || "";
  return providers.find((p) => p.kind === kind) ?? null;
}

/**
 * Whether a provider can hold a deny-by-default egress allowlist — the
 * capability the `allowlist` egress mode and a bot's "require an egress
 * allowlist" need.
 * @param provider - The provider, or `null` when not known.
 * @returns `true` when it can.
 */
export function canHoldAllowlist(
  provider: SandboxProviderInfo | null,
): boolean {
  return provider?.capabilities.domainEgressAllowlist === true;
}

/**
 * A provider as the menu lists it. One this deployment refuses is still
 * listed, so a person sees it exists and why it cannot be chosen.
 * @param provider - The provider.
 * @returns The option's words.
 */
export function providerOptionLabel(provider: SandboxProviderInfo): string {
  return provider.allowedHere
    ? provider.label
    : `${provider.label} — not on this deployment`;
}

/**
 * An amount of memory in words: `512 MiB`, `2 GiB`, `1.5 GiB`.
 * @param mib - Mebibytes.
 * @returns The words.
 */
export function memoryWords(mib: number): string {
  if (mib < 1024) return `${mib} MiB`;
  const gib = mib / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

/**
 * The memory a provider pairs with a vCPU count, when it pairs them.
 * @param provider - The provider.
 * @param vcpus - The count.
 * @returns MiB, or `null` when the provider does not size by vCPU.
 */
export function memoryFor(
  provider: SandboxProviderInfo | null,
  vcpus: number,
): number | null {
  const range = provider?.options.vcpus;
  return range ? vcpus * range.mibPerVcpu : null;
}

/**
 * What a sandbox was given, in one line: `2 vCPUs · 4 GiB · up to 45 min · node24`.
 * A provider that does not size its sandboxes leaves those parts out.
 * @param resources - The ledger row's `resources`, or `null` for a row written before they were recorded.
 * @returns The words, or `null` when there is nothing to say.
 */
export function resourceWords(
  resources: SandboxResources | null,
): string | null {
  if (!resources) return null;
  const parts: string[] = [];
  if (resources.vcpus) {
    parts.push(`${resources.vcpus} vCPU${resources.vcpus === 1 ? "" : "s"}`);
  }
  if (resources.memoryMiB) parts.push(memoryWords(resources.memoryMiB));
  if (resources.timeoutMs) {
    parts.push(`up to ${minutesWords(resources.timeoutMs)}`);
  }
  if (resources.image) parts.push(resources.image);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A provider deadline in words, rounded to the minute.
 * @param ms - Milliseconds.
 * @returns E.g. `45 min` or `2 h`.
 */
function minutesWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * A ledger row's status, as a person reads it.
 * @param status - The server's status.
 * @returns The words.
 */
export function sandboxStatusLabel(status: string): string {
  switch (status) {
    case "creating":
      return "Creating";
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "destroyed":
      return "Destroyed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

/**
 * A stored token as the page may show it: never the token, its last four.
 * @param lastFour - The connection's `lastFour`.
 * @returns `•••• abcd`.
 */
export function maskedToken(lastFour: string): string {
  return `•••• ${lastFour}`;
}

/**
 * A connection's last probe, in words.
 * @param status - `ok`, `error`, or `unverified`.
 * @returns The words.
 */
export function connectionProbeLabel(status: string): string {
  switch (status) {
    case "ok":
      return "Works";
    case "error":
      return "Last test failed";
    default:
      return "Not tested yet";
  }
}

/** A connection form's text: its name, each field, and the token. */
export interface ConnectionDraft {
  name: string;
  config: Record<string, string>;
  token: string;
}

/**
 * Parse a connection form for `connection:create` (every field and the token
 * required) or `connection:edit` (a blank token keeps the stored one). The
 * fields' shapes are the server's to check; this only refuses what is
 * missing.
 * @param kind - The connection kind, with the fields it takes.
 * @param draft - The form.
 * @param editing - Whether a connection already exists.
 * @returns The body to send, or a sentence saying what is missing.
 */
export function parseConnectionDraft(
  kind: ConnectionKindInfo,
  draft: ConnectionDraft,
  editing: boolean,
): { name?: string; config: Record<string, string>; token?: string } | string {
  const config: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = (draft.config[field.key] ?? "").trim();
    if (!value) return `${field.label} is required.`;
    config[field.key] = value;
  }
  const token = draft.token.trim();
  if (!editing && !token) return `${kind.secretLabel} is required.`;
  const name = draft.name.trim();
  return {
    ...(name ? { name } : {}),
    config,
    ...(token ? { token } : {}),
  };
}

/** The ledger statuses that mean a sandbox may still be running, and costing. */
const LIVE_SANDBOX_STATUSES: readonly string[] = [
  "creating",
  "running",
  "stopped",
];

/**
 * Whether a ledger row may still exist on its provider — what `live=true`
 * lists, and what may be destroyed.
 * @param status - The row's status.
 * @returns `true` until it is destroyed or failed.
 */
export function isLiveSandbox(status: string): boolean {
  return LIVE_SANDBOX_STATUSES.includes(status);
}
