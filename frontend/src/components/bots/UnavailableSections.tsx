import { NOT_AVAILABLE } from "../shell/destinations";

/** One part of a bot the page will configure, and what it is for. */
interface UnavailableSection {
  slug: string;
  title: string;
  /** What the section will hold, so a reader knows what to expect. */
  purpose: string;
}

/**
 * The parts of a bot this page does not configure yet, in the order they
 * will appear. Drawn disabled rather than left out — the same rule the
 * sidebar follows — so the page's shape does not change as they arrive.
 */
export const UNAVAILABLE_BOT_SECTIONS: readonly UnavailableSection[] = [
  {
    slug: "channels",
    title: "Channels",
    purpose: "Where it listens: Slack channels, Linear teams, Pylon accounts.",
  },
  {
    slug: "code",
    title: "Code",
    purpose: "Code mode and the sandboxes it hands repository work to.",
  },
  {
    slug: "skills",
    title: "Skills",
    purpose: "The project's shared skills this bot may use.",
  },
  {
    slug: "prompts",
    title: "Prompts",
    purpose: "Instructions beyond its persona, written as files.",
  },
  {
    slug: "goals",
    title: "Goals",
    purpose: "What it works toward between conversations.",
  },
];

/**
 * The bot page's disabled sections, each saying it is not available yet and
 * what it will be for.
 * @returns The sections.
 */
export function UnavailableSections() {
  return (
    <div className="bot-unavailable-sections">
      {UNAVAILABLE_BOT_SECTIONS.map((section) => (
        <section
          key={section.slug}
          className="bot-unavailable"
          aria-disabled="true"
          title={NOT_AVAILABLE}
          data-testid={`bot-section-${section.slug}`}
        >
          <h2 className="bot-unavailable-title">{section.title}</h2>
          <p className="bot-unavailable-status">{NOT_AVAILABLE}</p>
          <p className="bot-unavailable-purpose">{section.purpose}</p>
        </section>
      ))}
    </div>
  );
}
