import { approvalLink } from "../surface";

/**
 * **Block Kit for the interactive surface**
 * (https://api.slack.com/reference/block-kit/blocks): the question, approval,
 * and plan messages a bot posts in its thread. Every message also carries
 * `text`, which Slack shows in notifications and to screen readers.
 *
 * Action ids name what a press answers, so the delivery that comes back
 * needs no lookup to route: `q:<questionEntryId>:<option>` answers a question
 * and `a:<approvalId>:approve|deny` decides an approval.
 */

/** Slack's limits on what a block holds. */
const LIMITS = {
  /** A button's label (`plain_text`, 75). */
  buttonText: 75,
  /** A button's value (2000). */
  buttonValue: 2000,
  /** A select option's value (150). */
  optionValue: 150,
  /** A section's text (3000). */
  sectionText: 3000,
  /** Buttons shown before a question becomes a menu. */
  buttons: 5,
};

/**
 * Clip text to a limit.
 * @param text - The text.
 * @param max - The limit.
 * @returns The text, clipped with an ellipsis.
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A question with its options: up to five buttons, or a menu past that.
 * @param text - The question, in `mrkdwn`.
 * @param options - Its options.
 * @param questionEntryId - The transcript entry it is.
 * @returns The blocks.
 */
export function questionBlocks(
  text: string,
  options: string[],
  questionEntryId: number,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(text, LIMITS.sectionText) },
    },
  ];
  if (options.length > 0 && options.length <= LIMITS.buttons) {
    blocks.push({
      type: "actions",
      block_id: `question:${questionEntryId}`,
      elements: options.map((o, i) => ({
        type: "button",
        action_id: `q:${questionEntryId}:${i}`,
        text: { type: "plain_text", text: clip(o, LIMITS.buttonText) },
        value: clip(o, LIMITS.buttonValue),
      })),
    });
  } else if (options.length > LIMITS.buttons) {
    blocks.push({
      type: "actions",
      block_id: `question:${questionEntryId}`,
      elements: [
        {
          type: "static_select",
          action_id: `q:${questionEntryId}:select`,
          placeholder: { type: "plain_text", text: "Choose an answer" },
          options: options.slice(0, 100).map((o) => ({
            text: { type: "plain_text", text: clip(o, LIMITS.buttonText) },
            value: clip(o, LIMITS.optionValue),
          })),
        },
      ],
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Or reply in this thread." }],
  });
  return blocks;
}

/**
 * An approval request: what the bot wants to run, and Approve / Deny when
 * the channel may decide (otherwise a link to the dashboard).
 * @param p - The approval row's payload.
 * @returns The blocks.
 */
export function approvalBlocks(p: {
  approvalId: number;
  name: string;
  args?: unknown;
  actions?: string[];
}): Record<string, unknown>[] {
  const args = JSON.stringify(p.args ?? {}, null, 2);
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(
          `I need approval to run \`${p.name}\`.\n\`\`\`${clip(args, 1500)}\`\`\``,
          LIMITS.sectionText,
        ),
      },
    },
  ];
  if ((p.actions ?? []).length > 0) {
    blocks.push({
      type: "actions",
      block_id: `approval:${p.approvalId}`,
      elements: [
        {
          type: "button",
          action_id: `a:${p.approvalId}:approve`,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: "approve",
        },
        {
          type: "button",
          action_id: `a:${p.approvalId}:deny`,
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          value: "deny",
        },
      ],
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${(p.actions ?? []).length > 0 ? "Or decide" : "Decide"} in Hypotenuse: <${approvalLink(p.approvalId)}|approval ${p.approvalId}>`,
      },
    ],
  });
  return blocks;
}

/** One step of a plan, as a plan row carries it. */
interface Step {
  tool: string;
  state: string;
}

/** The glyph of a step's state. */
const STEP_GLYPH: Record<string, string> = {
  running: ":hourglass_flowing_sand:",
  done: ":white_check_mark:",
  error: ":x:",
};

/**
 * A turn's plan: one line per tool step, edited in place as it runs.
 * @param steps - The steps.
 * @returns The fallback text and the blocks.
 */
export function planMessage(steps: Step[]): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const lines = steps.map(
    (s) => `${STEP_GLYPH[s.state] ?? "•"} \`${clip(s.tool, 200)}\``,
  );
  const text = clip(lines.join("\n"), LIMITS.sectionText);
  return {
    text: `Working: ${steps.map((s) => s.tool).join(", ")}`.slice(0, 3000),
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
  };
}
