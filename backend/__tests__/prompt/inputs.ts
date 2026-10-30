import type { PromptInputs, SectionInput } from "../../ops/PromptOps";
import type { Goal } from "../../schema/goals";

/**
 * Hand-built assembler inputs, shared by the pure suites and the subprocess
 * that proves a hash is the same in another process.
 */

/**
 * A section, with defaults.
 * @param over - The fields to set.
 * @returns The section.
 */
export function section(
  over: Partial<SectionInput> & { id: number },
): SectionInput {
  return {
    key: `s${over.id}`,
    scope: "bot",
    loading: "always",
    keywords: [],
    agentEditable: false,
    position: over.id,
    version: 1,
    title: `Section ${over.id}`,
    body: `Body of section ${over.id}.`,
    ...over,
  };
}

/**
 * A goal row, with defaults.
 * @param over - The fields to set.
 * @returns The goal.
 */
export function goal(over: Partial<Goal> & { id: number }): Goal {
  return {
    projectId: 1,
    botId: 1,
    title: `Goal ${over.id}`,
    description: "",
    status: "active",
    priority: "medium",
    notes: "",
    reviewEverySeconds: null,
    lastReviewedAt: null,
    position: 0,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/**
 * A full set of inputs touching every part of the prompt.
 * @param over - The fields to set.
 * @returns The inputs.
 */
export function fullInputs(over: Partial<PromptInputs> = {}): PromptInputs {
  return {
    bot: {
      name: "Toadsworth",
      displayName: "Toadsworth",
      description: "The castle steward.",
      capabilities: "Read and send the castle's mail.",
      promptBudgetTokens: 8_000,
    },
    channel: { type: "api", name: "default" },
    conversationTitle: "Deploying the drawbridge",
    latestMessage: "How do we deploy to preprod?",
    sections: [
      section({
        id: 1,
        key: "identity",
        title: "Identity",
        body: "I am the steward.",
        position: 0,
      }),
      section({
        id: 2,
        key: "how-i-work",
        title: "How I work",
        body: "Briefly.",
        position: 1,
        agentEditable: true,
      }),
      section({
        id: 3,
        key: "house-style",
        scope: "project",
        title: "House style",
        body: "Write plainly.",
        position: 0,
      }),
      section({
        id: 4,
        key: "deploys",
        title: "Deploys",
        loading: "contextual",
        keywords: ["deploy"],
        body: "Deploys go through preprod first.",
        position: 5,
      }),
      section({
        id: 5,
        key: "billing",
        title: "Billing",
        loading: "contextual",
        keywords: ["invoice"],
        body: "Invoices are monthly.",
        position: 6,
      }),
      section({
        id: 6,
        key: "release-notes",
        scope: "project",
        title: "Release notes",
        loading: "contextual",
        keywords: ["drawbridge"],
        body: "Group by area.",
        position: 1,
      }),
    ],
    goals: [
      goal({ id: 7, title: "Keep the moat clean", priority: "low" }),
      goal({
        id: 8,
        title: "Ship the drawbridge",
        priority: "high",
        notes: "Hinges ordered.",
      }),
      goal({ id: 9, title: "Old goal", status: "achieved" }),
    ],
    skills: [
      {
        name: "release-notes",
        description: "Write release notes",
        arguments: [
          { name: "since", required: true },
          { name: "audience", required: false, default: "customers" },
        ],
      },
    ],
    mcp: true,
    ...over,
  };
}
