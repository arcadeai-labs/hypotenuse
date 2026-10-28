import { Link } from "react-router-dom";
import { PLATFORM_LABELS, PLATFORMS } from "../../../../design/states";
import { Chip } from "../../ui";

/** The one-line description, verbatim wherever one appears (docs/DESIGN.md#writing). */
export const TAGLINE =
  "A persistent multiplayer, multichannel agent for your team";

/** How it works, in three steps. */
const STEPS = [
  {
    title: "Mention it where you work",
    body: "Each bot is its own app in Slack and Linear, and answers on Pylon tickets. Anyone who can post there can ask it — no new tool, no second login.",
  },
  {
    title: "It remembers the channel",
    body: "Every channel has its own memory, and the whole project shares one more. What a bot learns in #billing is there the next time someone asks.",
  },
  {
    title: "It hands code to a sandbox",
    body: "When the work is code, a fresh sandbox clones the repository, does it, and opens a pull request — then the bot answers in the thread it came from.",
  },
];

/**
 * The triangle: where the team already talks at the top right, the work done
 * at the bottom left, and Hypotenuse as the shortest path between them. Drawn
 * from tokens, so it reads in both themes.
 * @returns The diagram.
 */
function TriangleDiagram() {
  return (
    <svg
      className="home-diagram"
      viewBox="0 0 400 280"
      role="img"
      aria-labelledby="home-diagram-title"
    >
      <title id="home-diagram-title">
        Where your team talks at the top right, the work getting done at the
        bottom left, Hypotenuse the line between them
      </title>
      <path className="home-diagram-legs" d="M340 40 L340 240 L60 240" />
      <path className="home-diagram-hypotenuse" d="M340 40 L60 240" />
      <circle className="home-diagram-node" cx="340" cy="40" r="8" />
      <circle className="home-diagram-node" cx="60" cy="240" r="8" />
      <text className="home-diagram-label" x="326" y="24" textAnchor="end">
        Where your team talks
      </text>
      <text className="home-diagram-label" x="48" y="268">
        The work, done
      </text>
      <text
        className="home-diagram-label home-diagram-label-accent"
        x="186"
        y="124"
        textAnchor="middle"
      >
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
          <Chip tone="accent" data-testid="home-status">
            In development
          </Chip>
          <h1 className="text-display">A teammate in every channel</h1>
          <p className="home-lede">
            {TAGLINE}. Its bots answer in Slack, Linear, and Pylon with their
            own identity, their own tools, and their own memory — and when a
            task needs code, they hand it to a sandbox that opens the pull
            request.
          </p>
          <div className="home-actions">
            <Link className="ui-button ui-variant-primary" to="/docs">
              Read the docs
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
        <h2>Where it answers</h2>
        <p className="home-platforms" data-testid="home-platforms">
          {PLATFORMS.map((platform) => PLATFORM_LABELS[platform]).join(" · ")}
          {" — "}a Slack thread, a Linear agent session, a Pylon issue, or a
          plain HTTP call. The platform's own permissions decide who may talk to
          a bot; your project decides who may configure it.
        </p>
      </section>

      <section className="home-section">
        <h2>Always visibly a bot</h2>
        <p>
          Every bot carries the <strong>bot</strong> badge wherever it appears,
          so nobody mistakes it for a person — in a channel, in the dashboard,
          or in a screenshot.
        </p>
      </section>

      <section className="home-section">
        <h2>Security</h2>
        <ul className="home-security">
          <li>
            Platform tokens, model keys, and MCP credentials stay on the server;
            nothing hands them back.
          </li>
          <li>
            A sandbox holds one credential — its run token — and reaches models
            and git through server-side proxies.
          </li>
          <li>
            Every decision a person makes about a bot is written to the audit
            log.
          </li>
        </ul>
      </section>
    </div>
  );
}
