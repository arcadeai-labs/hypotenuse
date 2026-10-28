import { loadFromEnvIfSet } from "keryx";

/**
 * The key material behind every credential stored at rest — model keys,
 * platform tokens, MCP server credentials.
 *
 * Deliberately raw here — this module only reads the environment. Validation
 * (base64, exactly 32 bytes) lives in `ops/CryptoOps.ts`, and the boot-time
 * refusal in `initializers/secrets.ts`. Splitting it this way avoids a cycle:
 * `CryptoOps` reads `config.secrets`, so `config.secrets` cannot import
 * `CryptoOps`.
 *
 * In the deployed blueprint this comes from the shared env var group, not from
 * either service directly: `generateValue: true` declared on both web and worker
 * mints two different keys, and anything the web service encrypted would then be
 * undecryptable in a worker task.
 */
export const configSecrets = {
  encryptionKey: await loadFromEnvIfSet("SECRETS_ENCRYPTION_KEY", ""),
};

declare module "keryx" {
  interface KeryxConfig {
    secrets: typeof configSecrets;
  }
}
