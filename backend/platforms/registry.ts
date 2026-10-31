import { apiAdapter } from "./api/adapter";
import type { PlatformAdapter, SurfaceAdapter } from "./types";
import { webAdapter } from "./web/adapter";
import { webhookAdapter } from "./webhook/adapter";

/**
 * **The adapter registry**: one surface adapter per channel type, and among
 * them the platforms people reach a bot from. Adding a platform is one
 * adapter and one line here; the outbox, ingress, and processing read the
 * contract, never the type.
 */

/** The platforms with an installation, a webhook, and a manifest. */
export const PLATFORM_ADAPTERS: Record<string, PlatformAdapter> = {
  webhook: webhookAdapter,
};

/** Every surface, keyed by channel type. */
const SURFACE_ADAPTERS: Record<string, SurfaceAdapter> = {
  api: apiAdapter,
  web: webAdapter,
  ...PLATFORM_ADAPTERS,
};

/** The platform types, for input enums. */
export const PLATFORM_TYPES = Object.keys(PLATFORM_ADAPTERS) as [
  string,
  ...string[],
];

/**
 * The surface adapter for a channel type.
 * @param type - The channel's type.
 * @returns The adapter, or `undefined` for an unknown type.
 */
export function surfaceAdapter(type: string): SurfaceAdapter | undefined {
  return SURFACE_ADAPTERS[type];
}

/**
 * The platform adapter for a type.
 * @param type - The platform.
 * @returns The adapter, or `undefined`.
 */
export function platformAdapter(type: string): PlatformAdapter | undefined {
  return PLATFORM_ADAPTERS[type];
}
