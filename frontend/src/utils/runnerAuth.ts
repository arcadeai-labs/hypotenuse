/**
 * What the runner auth page tells a runner's owner to do, per provider —
 * the target of an `auth` elicitation's link in Linear
 * (`/runners/:runnerId/auth/:provider`). The login has to happen on the
 * runner's own machine, so the page gives commands, never a sign-in button.
 */

/** One provider's fix. */
export interface AuthInstructions {
  /** What needs signing in, as a person reads it. */
  title: string;
  /** Commands to run on the runner's machine, in order. */
  commands: string[];
  /** Anything else worth knowing. */
  note: string | null;
}

/** Environment variables an agent can sign in with instead of a login. */
const API_KEYS: Record<string, string> = {
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  qwen: "OPENAI_API_KEY",
};

/** The agents a runner advertises, as `runner:view` returns them. */
interface RunnerAgent {
  id: string;
  preset: string;
}

/**
 * The fix for one provider on one runner.
 * @param provider - The link's provider: an agent id, `github`, or a git host.
 * @param agents - The runner's agents.
 * @returns The title, the commands, and a note.
 */
export function authInstructions(
  provider: string,
  agents: RunnerAgent[],
): AuthInstructions {
  const agent = agents.find((a) => a.id.toLowerCase() === provider);
  if (agent || provider === "agent") {
    const id = agent?.id ?? "<agent>";
    const key = agent ? API_KEYS[agent.preset] : undefined;
    return {
      title: `The ${id} agent`,
      commands: [`hypotenuse agents login ${id}`],
      note: key
        ? `Or set ${key} in the daemon's environment and restart the daemon. Either way, the runner offers the agent work again once it signs in.`
        : "The runner offers the agent work again once it signs in.",
    };
  }
  if (provider === "github") {
    return {
      title: "GitHub",
      commands: ["gh auth login", "gh auth setup-git"],
      note: "This signs in the GitHub CLI (which opens pull requests) and lets git push over HTTPS with it. An SSH key on GitHub works for git too.",
    };
  }
  return {
    title: provider,
    commands: [`git ls-remote https://${provider}/<owner>/<repo>.git`],
    note: `Give git a way to reach ${provider} without a prompt — an SSH key or a credential helper — until this command works on the runner.`,
  };
}
