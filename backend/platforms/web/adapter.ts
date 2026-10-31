import type { SurfaceAdapter } from "../types";

/**
 * **The `web` platform: the dashboard chat.** A member talks to a bot in the
 * dashboard and sees what a teammate on a platform would, with every
 * capability. Its people are Hypotenuse members (project RBAC is the
 * permission, so there is no installation and no binding), its inbound path
 * is `conversation:create` / `conversation:message`, and `send` has nothing
 * to post: the dashboard reads Postgres (`conversation:live`), so its rows
 * are written `sent`.
 */
export const webAdapter: SurfaceAdapter = {
  type: "web",
  capabilities: {
    threads: true,
    streaming: true,
    status: true,
    plan: true,
    buttons: true,
    ephemeral: true,
    edits: true,
    elicitation: false,
    typing: true,
  },
  settlesAtEnqueue: true,
  validateOutbound: (draft) => draft,
  send: async () => ({ outcome: "sent" }),
};
