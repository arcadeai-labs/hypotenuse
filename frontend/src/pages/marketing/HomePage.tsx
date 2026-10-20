import { Link } from "react-router-dom";
import { CopyButton } from "../../components/CopyButton";

/** The agents named on the home page, as text — never as logos. */
const AGENTS = ["Claude Code", "Codex", "Gemini CLI", "GitHub Copilot", "goose", "OpenCode", "Cursor"];

/** Install commands, as the README documents them. */
const INSTALLS = [
  {
    label: "macOS / Linux",
    command: "curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash",
  },
  {
    label: "Windows (PowerShell)",
    command: "irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex",
  },
  { label: "npm (requires Bun)", command: "bun install -g @arcadeai/hypotenuse" },
];

const STEPS = [
  {
    title: "Delegate in Linear",
    body: "Assign an issue to @hypotenuse, or mention it in a comment. Nothing new to learn.",
  },
  {
    title: "It works where your code is",
    body: "A coding agent on your laptop or a teammate's build box picks it up in a fresh git worktree.",
  },
  {
    title: "It answers in the session",
    body: "Thinking, plan, and tool calls stream into the Linear agent session. It opens a pull request and replies.",
  },
];

/**
 * The triangle: Linear at the top right, your machine at the bottom left, and
 * Hypotenuse as the shortest path between them. Drawn from tokens, so it reads
 * in both themes.
 * @returns The diagram.
 */
function TriangleDiagram() {
  return (
    <svg className="home-diagram" viewBox="0 0 400 280" role="img" aria-labelledby="home-diagram-title">
      <title id="home-diagram-title">
        Linear at the top right, your machine at the bottom left, Hypotenuse the line between them
      </title>
      <path className="home-diagram-legs" d="M340 40 L340 240 L60 240" />
      <path className="home-diagram-hypotenuse" d="M340 40 L60 240" />
      <circle className="home-diagram-node" cx="340" cy="40" r="8" />
      <circle className="home-diagram-node" cx="60" cy="240" r="8" />
      <text className="home-diagram-label" x="328" y="44" textAnchor="end">
        Linear
      </text>
      <text className="home-diagram-label" x="72" y="230">
        Your machine
      </text>
      <text className="home-diagram-label home-diagram-label-accent" x="210" y="130" textAnchor="middle">
        Hypotenuse
      </text>
    </svg>
  );
}

/**
 * The public home page.
 * @returns The page.
 */
export function HomePage() {
  return (
    <div className="home" data-testid="home-page">
      <section className="home-hero">
        <div className="home-hero-copy">
          <h1 className="text-display">Your agents, your machines, inside Linear</h1>
          <p className="home-lede">
            Delegate a Linear issue to <code>@hypotenuse</code>. A coding agent on your own machine does the work in a
            fresh git worktree, streams its progress into the agent session, and opens a pull request.
          </p>
          <div className="home-actions">
            <Link className="ui-button ui-variant-primary" to="/docs">
              Read the docs
            </Link>
            <Link className="ui-button ui-variant-secondary" to="/docs/why">
              Why Hypotenuse
            </Link>
          </div>
        </div>
        <TriangleDiagram />
      </section>

      <section className="home-steps" aria-label="How it works">
        {STEPS.map((step, i) => (
          <div key={step.title} className="home-step">
            <span className="home-step-number tabular">{i + 1}</span>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
          </div>
        ))}
      </section>

      <section className="home-section">
        <h2>A manager and its workers</h2>
        <p>
          A <strong>manager</strong> agent can own a whole project: it writes the PRD, files the tickets, hands them to{" "}
          <strong>worker</strong> agents, and reviews what comes back.
        </p>
      </section>

      <section className="home-section">
        <h2>Any agent that speaks ACP</h2>
        <p className="home-agents" data-testid="home-agents">
          {AGENTS.join(" · ")}, and anything else that speaks the{" "}
          <a href="https://agentclientprotocol.com" target="_blank" rel="noreferrer noopener">
            Agent Client Protocol
          </a>
          .
        </p>
      </section>

      <section className="home-section">
        <h2>Install</h2>
        <div className="home-installs">
          {INSTALLS.map((install) => (
            <div key={install.label} className="home-install">
              <span className="text-meta">{install.label}</span>
              <div className="home-install-command">
                <code>{install.command}</code>
                <CopyButton text={install.command} label={`Copy ${install.label} install command`} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="home-section">
        <h2>Security</h2>
        <ul className="home-security">
          <li>Your model logins and git keys stay on your machine.</li>
          <li>Linear's tokens stay on the hosted service.</li>
          <li>Runners and agents reach Linear only through narrowly scoped tools.</li>
          <li>Every agent works in its own git worktree, never in your checkout.</li>
        </ul>
      </section>
    </div>
  );
}
