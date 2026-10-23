import { describe, expect, test } from "bun:test";
import type { AssignmentDispatch } from "../../../protocol/src/index";
import {
  buildPrompt,
  DEFAULT_TEMPLATES,
  listTemplateVariables,
  renderTemplate,
  unknownVariables,
} from "../../src/acp/prompt";
import { PROMPT_VARIABLES } from "../../src/config/validate";
import { assignment } from "./harness";

/**
 * A manager's dispatch, as an assignment carries it.
 * @param overrides - Fields to change.
 * @returns The dispatch.
 */
function dispatch(
  overrides: Partial<AssignmentDispatch> = {},
): AssignmentDispatch {
  return {
    mode: "new",
    reviewRound: 0,
    instructions: null,
    agentPreference: null,
    parent: {
      agentSessionId: 40,
      issueIdentifier: "ENG-0",
      issueUrl: "https://linear.app/acme/issue/ENG-0/plan",
    },
    ...overrides,
  };
}

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
  test("LC-CTX-01 LC-CTX-02 a new session: every section, in order, with the issue linked", () => {
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

  test("LC-ACT-14 a mention's instruction is the request; a follow-up's prompts are, without echoing them in the history", () => {
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

  test("a role's docs follow its instructions: URLs to read first, files verbatim and unrendered", () => {
    const blocks = buildPrompt(assignment(), null, {
      ...ctx,
      docs: [
        { source: "https://wiki.example.com/process", text: null },
        {
          source: "~/prompts/process.md",
          text: "Plans need a {{killer}} demo.\n",
        },
        { source: "https://wiki.example.com/bdd", text: null },
      ],
    });
    const body = text(blocks);
    expect(body).toContain(
      [
        "</role-instructions>",
        "<role-docs>\nThese documents are part of your instructions: they say how this team works. Where one disagrees with the instructions above about your tools or what you never do, the instructions above win.",
        "Read each of these with your tools before you begin. If one cannot be read, say so in your response.\n- https://wiki.example.com/process\n- https://wiki.example.com/bdd",
        '<doc source="~/prompts/process.md">\nPlans need a {{killer}} demo.\n</doc>\n</role-docs>',
        "<linear-context>",
      ].join("\n\n"),
    );
    expect(text(buildPrompt(assignment(), null, ctx))).not.toContain(
      "<role-docs>",
    );
    expect(
      text(
        buildPrompt(assignment(), null, {
          ...ctx,
          resumed: true,
          docs: [{ source: "https://wiki.example.com/process", text: null }],
        }),
      ),
    ).not.toContain("role-docs");
  });

  test("a prompt_file URL is an instruction to read it, in place of any template", () => {
    const body = text(
      buildPrompt(
        assignment(),
        { prompt: "ignored" },
        { ...ctx, templateUrl: "https://wiki.example.com/worker" },
      ),
    );
    expect(body).toContain(
      "<role-instructions>\nYour instructions for this role are the document at https://wiki.example.com/worker. Read it with your tools before doing anything else, and follow it. If you cannot read it, say so in your response and stop.\n</role-instructions>",
    );
    expect(body).not.toContain("ignored");
  });

  test("a dispatched turn renders the dispatch variable", () => {
    const blocks = buildPrompt(
      assignment({ kind: "dispatch", dispatch: dispatch() }),
      { prompt: "Part of {{dispatch.parent_identifier}}." },
      ctx,
    );
    expect(text(blocks)).toContain(
      "<role-instructions>\nPart of ENG-0.\n</role-instructions>",
    );
  });

  test("a dispatched worker's first turn names the planning session and carries its instructions", () => {
    const prompt = text(
      buildPrompt(
        assignment({
          kind: "dispatch",
          dispatch: dispatch({ instructions: "Reuse the money helper." }),
        }),
        null,
        ctx,
      ),
    );
    expect(prompt).toContain(
      "This issue was dispatched to you by the planning agent's session on https://linear.app/acme/issue/ENG-0/plan.",
    );
    expect(prompt).toContain(
      "<request>\nBegin.\n\n## Instructions from the planning agent\n\nReuse the money helper.\n</request>",
    );
  });

  test("changes requested are the request, on a resumed turn too", () => {
    const changes = assignment({
      kind: "prompt",
      dispatch: dispatch({
        mode: "changes",
        reviewRound: 1,
        instructions: "Handle EUR too.",
      }),
    });
    for (const resumed of [false, true]) {
      expect(text(buildPrompt(changes, null, { ...ctx, resumed }))).toContain(
        "<request>\n## Changes requested by the planning agent\n\nHandle EUR too.\n</request>",
      );
    }
  });

  test("a review turn carries the worker's result in a fence its text cannot close", () => {
    const review = assignment({
      kind: "review",
      role: "manager",
      review: {
        childAgentSessionId: 7,
        childIssueIdentifier: "ENG-2",
        childIssueUrl: "https://linear.app/acme/issue/ENG-2/eur",
        reviewRound: 0,
        outcome: "completed",
        finalResponse: "Done. See ```diff``` above.",
        plan: [{ content: "Write the test", status: "completed" }],
        pullRequests: [
          { label: "Pull Request", url: "https://github.com/acme/web/pull/9" },
        ],
      },
    });
    const prompt = text(buildPrompt(review, null, { ...ctx, resumed: true }));
    expect(prompt).toContain(
      [
        "<request>",
        "## Worker result for ENG-2 (round 1)",
        "",
        "Issue: https://linear.app/acme/issue/ENG-2/eur",
        "",
        "````",
        "outcome: completed",
        "pull requests:",
        "- Pull Request: https://github.com/acme/web/pull/9",
        "plan:",
        "- [completed] Write the test",
        "final response:",
        "Done. See ```diff``` above.",
        "````",
      ].join("\n"),
    );
    expect(prompt).toContain("accept it, request changes, or file follow-ups");
  });

  test("a read-only checkout and a repository-less turn say where they are", () => {
    const manager = assignment({
      role: "manager",
      repository: { remote: "github.com/acme/web", baseBranch: "main" },
    });
    expect(
      text(
        buildPrompt(manager, null, { ...ctx, branch: null, readOnly: true }),
      ),
    ).toContain(
      "This is a read-only checkout of main (detached, no branch): read the code, do not change it.",
    );
    expect(
      text(buildPrompt(assignment({ role: "manager" }), null, ctx)),
    ).toContain("No repository applies to this session");
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
