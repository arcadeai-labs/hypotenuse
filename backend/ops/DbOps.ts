import type { api } from "keryx";

/**
 * The Drizzle transaction handle passed to `api.db.db.transaction(fn)`. Ops that
 * take one compose inside a caller's transaction, which is how the sign-up
 * bootstrap keeps its inserts atomic — and how `AuditedAction` commits the audit
 * row with the change it describes.
 */
export type TxHandle = Parameters<
  Parameters<typeof api.db.db.transaction>[0]
>[0];

/** Either an open transaction or the shared pool, for reads that work in both. */
export type DbHandle = TxHandle | typeof api.db.db;
