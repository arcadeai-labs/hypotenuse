import { config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import { DOCKER_CAPABILITIES, DockerSandboxProvider } from "./providers/docker";
import type {
  ProviderCapabilities,
  SandboxProvider,
  SandboxProviderName,
} from "./types";

/**
 * A registered sandbox provider, plus what the settings page and
 * `project:settings-edit` need to describe and validate it. Adding a provider
 * is one entry here and one file in `providers/`; no call site changes.
 */
export interface SandboxProviderDefinition {
  /** The registry key, stored in `project_settings.sandboxProvider`. */
  kind: SandboxProviderName;
  /** Human-readable name for the settings page. */
  label: string;
  /** One line explaining when to pick it. */
  description: string;
  /**
   * Whether the provider may be used when `NODE_ENV === "production"`.
   * `docker` may not: it shells out to a local daemon a deployed service does
   * not have, and it cannot enforce an egress allowlist.
   */
  productionAllowed: boolean;
  /** What the provider can do — the same object the provider instance exposes. */
  capabilities: ProviderCapabilities;
  /**
   * Construct the provider. Providers hold no per-sandbox state, so this is
   * called per use.
   */
  build(): SandboxProvider;
}

/** Every provider, by kind. */
export const SANDBOX_PROVIDERS: Record<
  SandboxProviderName,
  SandboxProviderDefinition
> = {
  docker: {
    kind: "docker",
    label: "Docker (development only)",
    description:
      "One container per job on this server's Docker daemon. For local development and CI; refused in production.",
    productionAllowed: false,
    capabilities: DOCKER_CAPABILITIES,
    build: () => new DockerSandboxProvider(),
  },
};

/** The registered provider kinds. */
export const SANDBOX_PROVIDER_KINDS = Object.keys(
  SANDBOX_PROVIDERS,
) as SandboxProviderName[];

/**
 * Whether this process runs in production, read at use so a suite can prove
 * the guard by flipping it.
 * @returns `true` under `NODE_ENV=production`.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The definition of a provider, refusing an unknown one or one this
 * deployment may not use. **The** production guard: `project:settings-edit`
 * calls it when a provider is chosen, and `sandbox-job:start` when one is
 * used, so `docker` is refused in production at both.
 * @param kind - The provider's registry key.
 * @param key - The input to name in the error, when it came from one.
 * @returns The definition.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export function assertSandboxProviderAllowed(
  kind: string,
  key = "sandboxProvider",
): SandboxProviderDefinition {
  const definition = SANDBOX_PROVIDERS[kind as SandboxProviderName];
  if (!definition) {
    throw new TypedError({
      message: `"${kind}" is not a sandbox provider. Choose one of: ${SANDBOX_PROVIDER_KINDS.join(", ")}.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key,
    });
  }
  if (!definition.productionAllowed && isProduction()) {
    throw new TypedError({
      message: `The ${kind} sandbox provider is for development only and cannot be used in production.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key,
    });
  }
  return definition;
}

/**
 * Build the provider a project's jobs run on.
 * @param kind - The provider's registry key.
 * @returns The provider.
 * @throws {TypedError} When the provider is unknown or refused here.
 */
export function buildSandboxProvider(kind: string): SandboxProvider {
  return assertSandboxProviderAllowed(kind).build();
}

/**
 * The provider a project uses: its own choice, else the deployment's default.
 * @param chosen - `project_settings.sandboxProvider`.
 * @returns The provider's kind.
 */
export function effectiveProvider(chosen: string | null | undefined): string {
  return chosen || config.sandbox.defaultProvider;
}
