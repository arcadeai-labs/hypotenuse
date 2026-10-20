import { ListLayout } from "../../components/layouts/ListLayout";

/** What each destination will hold, said as a promise rather than a claim about data. */
const DESCRIPTIONS: Record<string, string> = {
  Home: "Your project at a glance: sessions waiting on you, what is running, and runner capacity.",
  Sessions:
    "Every agent session from Linear, grouped by status with the ones waiting on you first.",
  Runners:
    "The machines connected to this project, their presence, and their free slots.",
  Routing:
    "Which runners take which work: projects, teams, and labels mapped to runners and roles.",
  Settings: "Project members, the Linear connection, and runner tokens.",
};

/**
 * A destination that has its frame but not its content yet. It says what the
 * page will show; it never asserts anything about data it has not fetched.
 * @param props - `title`, which also picks the description.
 * @returns The page.
 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <ListLayout title={title}>
      <div className="shell-placeholder" data-testid="placeholder">
        <p>{DESCRIPTIONS[title] ?? "This page is on its way."}</p>
      </div>
    </ListLayout>
  );
}
