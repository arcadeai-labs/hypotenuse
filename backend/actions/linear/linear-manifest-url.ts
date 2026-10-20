import type { Action, ActionParams } from "keryx";
import { z } from "zod";
import {
  buildAppManifest,
  buildAppManifestUrl,
} from "../../ops/LinearManifestOps";

/**
 * `linear:manifest-url` — print the pre-filled Linear app-creation link for
 * this deployment: `bun keryx.ts linear:manifest-url`. An operator tool, run
 * once per environment; it has no `web` route and is never an MCP tool.
 */
export class LinearManifestUrl implements Action {
  name = "linear:manifest-url";
  description =
    "Print the link that creates this deployment's Linear OAuth app with the callback URL, webhook URL, and webhook resource types pre-filled.";
  inputs = z.object({
    name: z
      .string()
      .optional()
      .describe('The app\'s name in Linear (default "Hypotenuse")'),
    developer: z
      .string()
      .optional()
      .describe("Who Linear shows as the app's developer (default: the name)"),
  });

  /**
   * @param params - Optional name and developer.
   * @returns The link and the manifest it carries.
   */
  async run(params: ActionParams<LinearManifestUrl>) {
    return {
      url: buildAppManifestUrl(params),
      manifest: buildAppManifest(params),
    };
  }
}
