import { type Action, type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  assertRunnableCron,
  cronInput,
  describeCron,
  timeZoneInput,
  upcomingSlots,
} from "../../ops/ScheduleOps";

/**
 * `schedule:preview` — check a cron expression and zone before saving:
 * what it means in words and its next five slots. Any project member.
 */
export class SchedulePreview implements Action {
  name = "schedule:preview";
  description =
    "Check a cron expression in a time zone without saving anything: it answers the expression in words and its next five slots (epoch ms), or says what is wrong with it (unparseable, no future slot, or slots closer than 5 minutes).";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/schedule-preview",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    cron: cronInput,
    timeZone: timeZoneInput.default("UTC"),
  });

  /**
   * @param params - The inputs.
   * @returns The description and slots.
   */
  async run(params: ActionParams<SchedulePreview>) {
    assertRunnableCron(params.cron, params.timeZone);
    return {
      preview: {
        cron: params.cron,
        timeZone: params.timeZone,
        description: describeCron(params.cron),
        nextSlots: upcomingSlots(params.cron, params.timeZone, 5).map((d) =>
          d.getTime(),
        ),
      },
    };
  }
}
