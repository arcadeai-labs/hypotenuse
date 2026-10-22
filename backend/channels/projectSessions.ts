import { Channel } from "keryx";
import { projectMemberChannelMiddleware } from "../ops/ChannelOps";
import { PROJECT_SESSIONS_CHANNEL_PATTERN } from "../ops/SessionChannelOps";

/**
 * The subscribe-time gate on `project:<id>:sessions`: a signed-in person who
 * is a member of the project, refused identically whether or not the project
 * exists.
 */
export const ProjectSessionsChannelMiddleware = projectMemberChannelMiddleware(
  PROJECT_SESSIONS_CHANNEL_PATTERN,
  "sessions",
);

/**
 * `project:<projectId>:sessions` — tells a project's dashboards that an
 * agent session changed: created, prompted, stopped, an activity sent, a turn
 * offered, claimed, waiting, or finished. Frames are `{ event: "sessions" }`
 * or `{ event: "session", id }` and nothing else; the client re-reads
 * through `agent-session:*`.
 */
export class ProjectSessionsChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_SESSIONS_CHANNEL_PATTERN,
      description:
        "Live changes to one project's agent sessions. Requires a session and membership in that project.",
      middleware: [ProjectSessionsChannelMiddleware],
    });
  }
}
