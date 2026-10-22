import { Channel } from "keryx";
import { projectMemberChannelMiddleware } from "../ops/ChannelOps";
import { PROJECT_EVENTS_CHANNEL_PATTERN } from "../ops/TriggerEventOps";

/**
 * The subscribe-time gate on `project:<id>:events`: a signed-in person who
 * is a member of the project, refused identically whether or not the project
 * exists.
 */
export const ProjectEventsChannelMiddleware = projectMemberChannelMiddleware(
  PROJECT_EVENTS_CHANNEL_PATTERN,
  "events",
);

/**
 * `project:<projectId>:events` — tells a project's dashboards that its event
 * log changed: a webhook delivery was recorded or processed. The one frame,
 * `{ event: "events" }`, carries nothing; the client re-reads through
 * `trigger-event:list`.
 */
export class ProjectEventsChannel extends Channel {
  constructor() {
    super({
      name: PROJECT_EVENTS_CHANNEL_PATTERN,
      description:
        "Live changes to one project's webhook event log. Requires a session and membership in that project.",
      middleware: [ProjectEventsChannelMiddleware],
    });
  }
}
