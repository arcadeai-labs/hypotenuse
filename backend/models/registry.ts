import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderV4 } from "@ai-sdk/provider";
import { z } from "zod";
import { guardedFetch } from "../ops/NetworkGuardOps";

/**
 * **The one table of model provider kinds.** Every caller branches on what an
 * entry says — whether a base URL is required, how to build a provider, how to
 * probe it — never on the kind's name, so adding a provider is adding an entry.
 *
 * Every provider is built with {@link guardedFetch} as its `fetch`, so no call
 * the AI SDK makes reaches a host the SSRF guard did not approve. The key is
 * handed to `build` decrypted, by the caller, for the lifetime of one call.
 *
 * Base URLs are what the AI SDK's `baseURL` setting takes — for Anthropic and
 * OpenAI that includes `/v1` — so one string means one thing everywhere.
 */

/** Every provider kind, in the order a person is offered them. */
export const MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "gateway",
  "openai-compatible",
] as const;

/** One of {@link MODEL_PROVIDERS}. */
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** What `build`, `probe`, and `listModels` are given: a connection, decrypted. */
export interface ProviderCredentials {
  /** The base URL, or `null` for the kind's default. */
  baseUrl: string | null;
  /** The plaintext API key. */
  apiKey: string;
}

/** One model an endpoint reports. */
export interface ListedModel {
  id: string;
  /** A display name, when the provider gives one. */
  name: string | null;
}

/** One provider kind. */
export interface ProviderKind {
  kind: ModelProvider;
  /** What a person is shown. */
  label: string;
  /** The credential fields a connection of this kind takes. */
  credentialSchema: z.ZodType<{ apiKey: string }>;
  /** The base URL used when a connection names none, or `null` when one is required. */
  defaultBaseUrl: string | null;
  /** Build an AI SDK provider. Call per use; never cache the result. */
  build(credentials: ProviderCredentials): ProviderV4;
  /**
   * Prove the key works against the endpoint.
   * @throws {Error} With a message a person can act on.
   */
  probe(credentials: ProviderCredentials): Promise<void>;
  /** The models the endpoint reports, live. */
  listModels(credentials: ProviderCredentials): Promise<ListedModel[]>;
}

/** The credential every kind takes today: one API key. */
const apiKeySchema = z.object({
  apiKey: z.string().trim().min(1, "An API key is required").max(4096),
});

/** Anthropic's API version header, the one its own SDK sends. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * A base URL without its trailing slashes.
 * @param credentials - The connection.
 * @param fallback - The kind's default.
 * @returns The base URL to call.
 */
function baseOf(
  credentials: ProviderCredentials,
  fallback: string | null,
): string {
  const base = credentials.baseUrl ?? fallback;
  if (!base) throw new Error("This provider needs a base URL.");
  return base.replace(/\/+$/, "");
}

/**
 * GET a JSON list of models through the guard, turning a refusal into a
 * sentence that says what the endpoint answered.
 * @param url - The models URL.
 * @param headers - The authentication headers.
 * @returns The parsed body.
 * @throws {Error} When the endpoint answers anything but 2xx JSON.
 */
async function getModelsJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await guardedFetch(url, {
    headers: { accept: "application/json", ...headers },
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `The provider refused the key (HTTP ${res.status}). Check the key, or rotate it.`,
      );
    }
    throw new Error(
      `The provider answered HTTP ${res.status} from ${url}${text ? `: ${text}` : ""}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`The provider's answer from ${url} was not JSON.`);
  }
}

/** The `{ data: [{ id, … }] }` shape both Anthropic and OpenAI answer. */
const modelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      display_name: z.string().nullish(),
    }),
  ),
});

/**
 * Parse a `{ data: [...] }` model list.
 * @param body - The parsed JSON.
 * @returns The models.
 * @throws {Error} When the body is not that shape.
 */
function parseModelList(body: unknown): ListedModel[] {
  const parsed = modelListSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("The provider's model list was not in the expected shape.");
  }
  return parsed.data.data.map((m) => ({
    id: m.id,
    name: m.display_name ?? null,
  }));
}

/**
 * A Vercel AI Gateway SDK error as a sentence: its own message, which already
 * names what was wrong with the key.
 * @param error - What the gateway client threw.
 * @returns The error to rethrow.
 */
function gatewayError(error: unknown): Error {
  return new Error(
    error instanceof Error ? error.message : "The gateway refused the request.",
  );
}

const anthropic: ProviderKind = {
  kind: "anthropic",
  label: "Anthropic",
  credentialSchema: apiKeySchema,
  defaultBaseUrl: "https://api.anthropic.com/v1",
  build: (c) =>
    createAnthropic({
      apiKey: c.apiKey,
      baseURL: baseOf(c, anthropic.defaultBaseUrl),
      fetch: guardedFetch as typeof fetch,
    }),
  probe: async (c) => {
    await anthropic.listModels(c);
  },
  listModels: async (c) =>
    parseModelList(
      await getModelsJson(`${baseOf(c, anthropic.defaultBaseUrl)}/models`, {
        "x-api-key": c.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      }),
    ),
};

const openai: ProviderKind = {
  kind: "openai",
  label: "OpenAI",
  credentialSchema: apiKeySchema,
  defaultBaseUrl: "https://api.openai.com/v1",
  build: (c) =>
    createOpenAI({
      apiKey: c.apiKey,
      baseURL: baseOf(c, openai.defaultBaseUrl),
      fetch: guardedFetch as typeof fetch,
    }),
  probe: async (c) => {
    await openai.listModels(c);
  },
  listModels: async (c) =>
    parseModelList(
      await getModelsJson(`${baseOf(c, openai.defaultBaseUrl)}/models`, {
        authorization: `Bearer ${c.apiKey}`,
      }),
    ),
};

const gateway: ProviderKind = {
  kind: "gateway",
  label: "Vercel AI Gateway",
  credentialSchema: apiKeySchema,
  defaultBaseUrl: "https://ai-gateway.vercel.sh/v4/ai",
  build: (c) =>
    createGateway({
      apiKey: c.apiKey,
      baseURL: baseOf(c, gateway.defaultBaseUrl),
      fetch: guardedFetch as typeof fetch,
    }),
  // The model catalog is public, so listing models proves nothing about the
  // key; the credit balance is per key, and is the cheapest call that needs it.
  probe: async (c) => {
    try {
      await createGateway({
        apiKey: c.apiKey,
        baseURL: baseOf(c, gateway.defaultBaseUrl),
        fetch: guardedFetch as typeof fetch,
      }).getCredits();
    } catch (error) {
      throw gatewayError(error);
    }
  },
  listModels: async (c) => {
    try {
      const { models } = await createGateway({
        apiKey: c.apiKey,
        baseURL: baseOf(c, gateway.defaultBaseUrl),
        fetch: guardedFetch as typeof fetch,
      }).getAvailableModels();
      return models.map((m) => ({ id: m.id, name: m.name ?? null }));
    } catch (error) {
      throw gatewayError(error);
    }
  },
};

const openaiCompatible: ProviderKind = {
  kind: "openai-compatible",
  label: "OpenAI-compatible",
  credentialSchema: apiKeySchema,
  defaultBaseUrl: null,
  build: (c) =>
    createOpenAICompatible({
      name: "openai-compatible",
      apiKey: c.apiKey,
      baseURL: baseOf(c, null),
      fetch: guardedFetch as typeof fetch,
    }),
  probe: async (c) => {
    await openaiCompatible.listModels(c);
  },
  listModels: async (c) =>
    parseModelList(
      await getModelsJson(`${baseOf(c, null)}/models`, {
        authorization: `Bearer ${c.apiKey}`,
      }),
    ),
};

/** Every kind, keyed by name. */
export const PROVIDER_KINDS: Readonly<Record<ModelProvider, ProviderKind>> = {
  anthropic,
  openai,
  gateway,
  "openai-compatible": openaiCompatible,
};

/**
 * The registry entry for a stored provider name.
 * @param provider - The `model_connections.provider` value.
 * @returns The kind.
 * @throws {Error} For a name the registry does not know (a row written by a
 *   newer deployment, or by hand).
 */
export function providerKind(provider: string): ProviderKind {
  const kind = PROVIDER_KINDS[provider as ModelProvider];
  if (!kind) throw new Error(`Unknown model provider "${provider}".`);
  return kind;
}
