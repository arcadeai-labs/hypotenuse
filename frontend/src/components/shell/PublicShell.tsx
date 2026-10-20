import { Monitor, Moon, Sun } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { type ThemePreference, useTheme } from "../../context/ThemeContext";
import { Mark } from "../../ui";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * The theme control for signed-out pages: one button cycling System → Light → Dark.
 * @returns The toggle.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon =
    preference === "system" ? Monitor : preference === "light" ? Sun : Moon;
  return (
    <button
      type="button"
      className="public-theme-toggle"
      data-testid="theme-toggle"
      data-preference={preference}
      aria-label={`Theme: ${PREFERENCE_LABEL[preference]}. Switch to ${PREFERENCE_LABEL[NEXT_PREFERENCE[preference]]}`}
      title={`Theme: ${PREFERENCE_LABEL[preference]}`}
      onClick={() => setPreference(NEXT_PREFERENCE[preference])}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}

/**
 * The frame for every page a signed-out visitor can read: a top bar with the
 * mark, Docs, Sign in (or, with a session, a way back into the app), and the
 * theme toggle; the page; and a footer.
 * @returns The shell with the routed page inside.
 */
export function PublicShell() {
  const { user } = useAuth();
  return (
    <div className="public-shell" data-testid="public-shell">
      <header className="public-topbar">
        <Link to="/" className="public-brand">
          <Mark size={18} label={null} />
          <span>Hypotenuse</span>
        </Link>
        <nav className="public-nav" aria-label="Site">
          <NavLink to="/docs" data-testid="public-docs-link">
            Docs
          </NavLink>
          {user ? (
            <NavLink to="/home" data-testid="public-app-link">
              Open Hypotenuse
            </NavLink>
          ) : (
            <NavLink to="/sign-in" data-testid="public-sign-in-link">
              Sign in
            </NavLink>
          )}
          <ThemeToggle />
        </nav>
      </header>
      <main className="public-main">
        <Outlet />
      </main>
      <footer className="public-footer">
        <span>
          <Mark size={12} label={null} /> Hypotenuse
        </span>
        <nav aria-label="Footer">
          <Link to="/docs">Docs</Link>
          <Link to="/docs/why">Why Hypotenuse</Link>
          <a
            href="https://github.com/arcadeai-labs/hypotenuse"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub
          </a>
        </nav>
      </footer>
    </div>
  );
}
