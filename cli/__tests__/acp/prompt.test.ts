import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  DEFAULT_TEMPLATES,
  listTemplateVariables,
  renderTemplate,
  unknownVariables,
} from "../../src/acp/prompt";
import { PROMPT_VARIABLES } from "../../src/config/validate";
import { assignment } from "./harness";

/** The one prompt builder: golden prompts, guidance order, and variables. */

const ctx = {
  cwd: "/w/eng-1",
  branch: "hypotenuse/eng-1-fix",
  repositoryName: "web",
  runnerName: "evan-mbp",
  resumed: false,
};

/**
 * The text block of a prompt.
 * @param blocks - The blocks.
 * @returns The first block's text.
 */
function text(blocks: ReturnType<typeof buildPrompt>): string {
  const first = blocks[0];
  return first?.type === "text" ? first.text : "";
}

describe("prompt", () => {
  test("a new session: every section, in order, with the issue linked", () => {
    const blocks = buildPrompt(
      assignment({
        repository: { remote: "github.com/acme/web", baseBranch: "main" },
        guidance: [
          { origin: "team", teamKey: "ENG", body: "Open a draft PR." },
          { origin: "workspace", body: "Reference the issue." },
        ],
        creator: { name: "Peach", email: "peach@example.com" },
      } as never),
      {
        prompt:
          "Fix {{issue.identifier}} in {{repository.name}} for {{creator.name}}.",
      },
      ctx,
    );
    expect(text(blocks)).toBe(
      [
        "<hypotenuse>\nYou are working as the worker agent for Linear issue ENG-1 on behalf of Peach, in a Linear agent session. You are an AI agent; never claim to be a person. What you say at the end of your turn is posted to the session as your response.\n</hypotenuse>",
        "<role-instructions>\nFix ENG-1 in web for Peach.\n</role-instructions>",
        '<linear-context>\n<issue identifier="ENG-1">Fix checkout rounding</issue>\n</linear-context>',
        '<guidance>\n<rule origin="team" team="ENG">\nOpen a draft PR.\n</rule>\n<rule origin="workspace">\nReference the issue.\n</rule>\n</guidance>',
        "<request>\nBegin.\n</request>",
        "<environment>\nWorking directory: /w/eng-1 (branch hypotenuse/eng-1-fix, from main)\nRepository: github.com/acme/web\nRunner: evan-mbp\n</environment>",
      ].join("\n\n"),
    );
    expect(blocks[1]).toEqual({
      type: "resource_link",
      uri: "https://linear.app/acme/issue/ENG-1/fix-checkout-rounding",
      name: "ENG-1",
      title: "Fix checkout rounding",
    });
  });

  test("a mention's instruction is the request; a follow-up's prompts are, without echoing them in the history", () => {
    expect(
      text(
        buildPrompt(assignment({ instruction: "plan the launch" }), null, ctx),
      ),
    ).toContain("<request>\nplan the launch\n</request>");
    const followUp = text(
      buildPrompt(
        assignment({
          kind: "prompt",
          history: [
            {
              seq: 1,
              activityId: 1,
              direction: "outbound",
              type: "thought",
              body: "thinking",
              signal: null,
            },
            {
              seq: 2,
              activityId: 2,
              direction: "outbound",
              type: "response",
              body: "Fixed.",
              signal: null,
            },
            {
              seq: 3,
              activityId: 3,
              direction: "outbound",
              type: "elicitation",
              body: "Which?",
              signal: "select",
            },
            {
              seq: 4,
              activityId: 4,
              direction: "inbound",
              type: "prompt",
              body: "Also EUR",
              signal: null,
            },
            {
              seq: 5,
              activityId: 5,
              direction: "inbound",
              type: "prompt",
              body: "And GBP",
              signal: null,
            },
          ],
          prompt: [
            { activityId: 4, body: "Also EUR" },
            { activityId: 5, body: "And GBP" },
          ],
        }),
        null,
        ctx,
      ),
    );
    expect(followUp).toContain(
      '<conversation>\n<turn role="agent">\nFixed.\n</turn>\n<turn role="agent" kind="elicitation">\nWhich?\n</turn>\n</conversation>',
    );
    expect(followUp).toContain("<request>\nAlso EUR\n\nAnd GBP\n</request>");
    expect(followUp).not.toContain("thinking");
  });

  test("a resumed session gets a one-line reminder and the request", () => {
    const blocks = buildPrompt(
      assignment({
        kind: "prompt",
        prompt: [{ activityId: 9, body: "Now the docs" }],
      }),
      null,
      { ...ctx, resumed: true },
    );
    expect(blocks).toEqual([
      {
        type: "text",
        text: "<hypotenuse>\nThis is a follow-up in the same Linear agent session for Linear issue ENG-1. You are an AI agent; never claim to be a person.\n</hypotenuse>\n\n<request>\nNow the docs\n</request>",
      },
    ]);
  });

  test("a dispatched turn renders the dispatch variable", () => {
    const blocks = buildPrompt(
      assignment({
        kind: "dispatch",
        dispatch: { parentIdentifier: "ENG-0" },
      } as never),
      { prompt: "Part of {{dispatch.parent_identifier}}." },
      ctx,
    );
    expect(text(blocks)).toContain(
      "<role-instructions>\nPart of ENG-0.\n</role-instructions>",
    );
  });

  test("the built-in templates are used when the role has none, and use only known variables", () => {
    expect(text(buildPrompt(assignment(), null, ctx))).toContain(
      "Implement ENG-1 — Fix checkout rounding",
    );
    expect(unknownVariables(DEFAULT_TEMPLATES.worker)).toEqual([]);
    expect(unknownVariables(DEFAULT_TEMPLATES.manager)).toEqual([]);
  });

  test("an unknown variable renders empty and is reported once", () => {
    const seen: string[] = [];
    expect(
      renderTemplate(
        "{{issue.titel}}/{{issue.titel}}/{{role}}",
        { role: "worker" },
        (n) => seen.push(n),
      ),
    ).toBe("//worker");
    expect(seen).toEqual(["issue.titel"]);
    expect(listTemplateVariables()).toEqual(PROMPT_VARIABLES);
  });
});
