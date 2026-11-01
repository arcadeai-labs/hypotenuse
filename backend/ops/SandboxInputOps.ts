import { secret } from "keryx";
import { z } from "zod";

/**
 * The inputs every sandbox-facing action shares. Helpers live in `ops/`,
 * never in `actions/`, because Keryx instantiates every export there.
 */

/**
 * The job token, in the body. Optional because an MCP call carries it as the
 * session's bearer instead; `JobTokenMiddleware` refuses a request with
 * neither.
 */
export const jobTokenInput = secret(
  z
    .string()
    .max(200)
    .optional()
    .describe(
      "The sandbox job token, when it is not the request's bearer credential",
    ),
);
