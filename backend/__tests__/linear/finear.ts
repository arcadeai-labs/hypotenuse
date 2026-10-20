import { afterAll, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOOK_TIMEOUT } from "../setup";

/**
 * finear's in-process application, fetched at a pinned commit by
 * `scripts/fetch-finear.ts` (run by `bun run test`). Imported by path rather
 * than as a package: see that script for why.
 */
const FINEAR_APPLICATION = join(
  import.meta.dir,
  "..",
  "..",
  ".finear",
  "src",
  "application.ts",
);

/**
 * The slice of finear's in-process API these tests use. Declared here rather
 * than imported, because `tsc` would otherwise type-check finear's own sources
 * under this repository's stricter settings.
 */
interface FinearApplication {
  readonly url: URL;
  drain(): Promise<void>;
  advance(milliseconds: number): Promise<number>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** An OAuth client finear registers at boot (with an optional app webhook). */
export interface FinearClientConfig {
  id: string;
  name: string;
  secret: string;
  redirectUris: string[];
  scopes: string[];
  webhook?: {
    url: string;
    secret: string;
    resourceTypes: string[];
    agentSessionEvents?: boolean;
  };
}

/** finear's `createApplication`, as far as these tests call it. */
interface FinearModule {
  createApplication(options: {
    databasePath: string;
    port?: number;
    controlToken?: string;
    clients?: readonly FinearClientConfig[];
  }): Promise<FinearApplication>;
}

/** The fixture API key finear seeds for "Human 1", an admin in workspace `eng`. */
export const FINEAR_PRIMARY_KEY = "finear-fixture-primary-key";

/**
 * Boot finear in-process on a random port with an in-memory database for the
 * current test file, and tear it down after the file.
 * @param options - OAuth clients to register at boot.
 * @returns Accessors for the running fake and its control operations.
 */
export function useFinear(options: { clients?: FinearClientConfig[] } = {}) {
  let app: FinearApplication | undefined;
  const controlToken = crypto.randomUUID();

  beforeAll(async () => {
    if (!existsSync(FINEAR_APPLICATION)) {
      throw new Error(
        "finear is not fetched — run `bun run finear:fetch` in backend/ (or use `bun run test`)",
      );
    }
    const { createApplication } = (await import(
      FINEAR_APPLICATION
    )) as FinearModule;
    app = await createApplication({
      databasePath: ":memory:",
      port: 0,
      controlToken,
      clients: options.clients ?? [],
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  }, HOOK_TIMEOUT);

  /** The running application; throws if called before `beforeAll` ran. */
  const running = (): FinearApplication => {
    if (!app) throw new Error("finear has not started yet");
    return app;
  };

  return {
    /** finear's base URL, e.g. `http://127.0.0.1:54321`. */
    url: () => running().url.toString().replace(/\/$/, ""),
    controlToken,
    /** Flush the webhook outbox now. */
    drain: () => running().drain(),
    /** Advance finear's virtual clock. */
    advance: (ms: number) => running().advance(ms),
    /** Reset finear to its fixtures. */
    reset: () => running().reset(),
  };
}
