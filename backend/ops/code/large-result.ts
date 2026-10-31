import { z } from "zod";
import { readLargeResult } from "../../tools/read-large-result";
import type { HostFunctionDef } from "./host-shared";
import { parseWith } from "./memory";

/**
 * `largeResult.read` in a program: `read_large_result`'s own lookup, confined
 * to this conversation's large results.
 */

const options = z
  .object({
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

/** The `large_result_read` host function. */
export const largeResultHost: Record<string, HostFunctionDef> = {
  large_result_read: {
    fn: "largeResult.read",
    args: z.tuple([z.string(), options.optional()]),
    body: async (scope, [id, opts]) => {
      const o = (opts ?? {}) as z.infer<typeof options>;
      const input = parseWith(
        readLargeResult.inputSchema,
        { id, offset: o.offset, limit: Math.min(o.limit ?? 10_000, 20_000) },
        "largeResult.read",
      );
      return {
        name: String(id),
        value: await readLargeResult.run(input, scope.ctx),
      };
    },
  },
};
