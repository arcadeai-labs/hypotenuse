import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

/** What a person chose. `system` follows the OS and keeps following it live. */
export type ThemePreference = "system" | "light" | "dark";
/** What is actually painted. */
export type ResolvedTheme = "light" | "dark";

/** The localStorage key. `index.html`'s boot script reads the same key before first paint. */
export const THEME_STORAGE_KEY = "hypotenuse.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The context value. */
export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Read the stored preference, treating anything unknown (or no storage) as `system`.
 * @returns The stored preference.
 */
export function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Resolve a preference against the OS setting.
 * @param preference - The person's choice.
 * @param systemDark - Whether the OS currently prefers dark.
 * @returns The theme to paint.
 */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/**
 * Owns the theme after first paint: persists the choice, writes `data-theme` on
 * `<html>`, and follows the OS live while the preference is `system`.
 * @param props - Children.
 * @returns The provider.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this tab.
    }
    setPreferenceState(next);
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The current theme and its setter. Only charts, code blocks, and screenshots
 * need this; everything else is painted by tokens.
 * @returns The theme state.
 */
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
