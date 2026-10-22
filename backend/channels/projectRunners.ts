import { Channel } from "keryx";
import { projectMemberChannelMiddleware } from "../ops/ChannelOps";
import { PROJECT_RUNNERS_CHANNEL_PATTERN } from "../ops/RunnerOps";

/**
 * The subscribe-time gate on `project:<id>:runners`: a signed-in person who
 * is a member of the project. The same refusal whether the project exists or
 * not, so the channel does not enumerate project ids.
 */
export const ProjectRunnersChannelMiddleware = projectMemberChannelMiddleware(
  PROJECT_RUNNERS_CHANNEL_PATTERN,
  "runners",
);

/**
 * `project:<projectId>:runners` — tells a project's dashboards that its
 * runner list changed: a registration, an edit, a revocation, a heartbeat
 * that changed status or capabilities, or the reaper. The one frame,
 * `{ event: "runners" }`, carries no ids; the list is visible to every member
 * anyway, and the client re-reads it through `runner:list`.
 */
export class ProjectRunnersChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_RUNNERS_CHANNEL_PATTERN,
      description:
        "Live changes to one project's runner list. Requires a session and membership in that project.",
      middleware: [ProjectRunnersChannelMiddleware],
    });
  }
}
