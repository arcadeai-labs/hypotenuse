import { config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import { DOCKER_CAPABILITIES, DockerSandboxProvider } from "./providers/docker";
import {
  VERCEL_CAPABILITIES,
  VERCEL_DEFAULT_RUNTIME,
  VERCEL_MIB_PER_VCPU,
  VERCEL_RUNTIMES,
  VERCEL_VCPU_RANGE,
  VercelSandboxProvider,
  vercelCredentials,
} from "./providers/vercel";
import type {
  ProviderCapabilities,
  ProviderConnection,
  SandboxProvider,
  SandboxProviderName,
} from "./types";

/**
 * What a project may configure for a provider, beyond choosing it. Each
 * field is absent for a provider that does not take it, and
 * `project:settings-edit` refuses a value for one that does not.
 */
export interface SandboxProviderOptions {
  /** Whether a job's sandbox boots an image the project names. */
  image: boolean;
  /** The stock runtimes it may boot, and the default, when it boots runtimes. */
  runtimes?: { values: readonly string[]; default: string };
  /** The vCPUs a sandbox may be given, and memory per vCPU in MiB. */
  vcpus?: { min: number; max: number; default: number; mibPerVcpu: number };
}

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
   * Whether its sandboxes boot with bun, the coding CLI, and the GitHub CLI
   * already in them. A provider on stock runtimes does not, and provisioning
   * installs them (`runtimeInstallScript`) before egress narrows.
   */
  bakesRuntimeIntoImage: boolean;
  /**
   * The `project_connections` kind it runs on, when it needs the project's
   * own account; `null` for one that runs on this deployment's.
   */
  connectionKind: string | null;
  /** What a project may configure for it. */
  options: SandboxProviderOptions;
  /**
   * Construct the provider. Providers hold no per-sandbox state, so this is
   * called per use — with the project's decrypted connection, for one that
   * needs it (`SandboxCredentialOps.providerForProject` supplies it).
   */
  build(connection: ProviderConnection | null): SandboxProvider;
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
    bakesRuntimeIntoImage: true,
    connectionKind: null,
    options: { image: true },
    build: () => new DockerSandboxProvider(),
  },
  vercel: {
    kind: "vercel",
    label: "Vercel Sandbox",
    description:
      "One Vercel Sandbox microVM per job, on the project's own Vercel account. Holds a deny-by-default egress allowlist; for production.",
    productionAllowed: true,
    capabilities: VERCEL_CAPABILITIES,
    bakesRuntimeIntoImage: false,
    connectionKind: "vercel",
    options: {
      image: false,
      runtimes: { values: VERCEL_RUNTIMES, default: VERCEL_DEFAULT_RUNTIME },
      vcpus: { ...VERCEL_VCPU_RANGE, mibPerVcpu: VERCEL_MIB_PER_VCPU },
    },
    build: (connection) => {
      if (!connection) {
        throw new TypedError({
          message:
            "The vercel sandbox provider runs on the project's own account, and was built without its connection.",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
      return new VercelSandboxProvider(vercelCredentials(connection));
    },
  },
};

/**
 * Whether a provider can narrow a *running* sandbox to an allowlist — what
 * provisioning needs to install with the network open and narrow before the
 * agent starts.
 * @param capabilities - The provider's capabilities.
 * @returns `true` when it can.
 */
export function canNarrowEgress(capabilities: ProviderCapabilities): boolean {
  return capabilities.domainEgressAllowlist && capabilities.liveEgressUpdate;
}

/**
 * Describe every provider for an answer: what the settings page offers and
 * what `project:settings-edit` accepts.
 * @returns One entry per provider, with whether this deployment allows it.
 */
export function describeSandboxProviders() {
  return SANDBOX_PROVIDER_KINDS.map((kind) => {
    const d = SANDBOX_PROVIDERS[kind];
    return {
      kind: d.kind,
      label: d.label,
      description: d.description,
      allowedHere: d.productionAllowed || !isProduction(),
      capabilities: d.capabilities,
      connectionKind: d.connectionKind,
      options: {
        image: d.options.image,
        runtimes: d.options.runtimes
          ? {
              values: [...d.options.runtimes.values],
              default: d.options.runtimes.default,
            }
          : null,
        vcpus: d.options.vcpus ?? null,
      },
    };
  });
}

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
 * The provider a project uses: its own choice, else the deployment's default.
 * @param chosen - `project_settings.sandboxProvider`.
 * @returns The provider's kind.
 */
export function effectiveProvider(chosen: string | null | undefined): string {
  return chosen || config.sandbox.defaultProvider;
}
