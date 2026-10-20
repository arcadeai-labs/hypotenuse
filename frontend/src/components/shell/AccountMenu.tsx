import { ChevronUp, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { type ThemePreference, useTheme } from "../../context/ThemeContext";
import { initials } from "../../ui";

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * The account menu at the foot of the sidebar: who is signed in, the account
 * page, the theme control, and sign-out. Sign-out is disabled, not absent,
 * while there is no session to end, so one selector resolves in both states.
 * @param props - `collapsed` draws only the trigger's avatar.
 * @returns The menu.
 */
export function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { preference, setPreference } = useTheme();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    /**
     * Close when a click lands outside the menu.
     * @param event - The pointer event.
     */
    function onDown(event: MouseEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    /**
     * Close on Escape.
     * @param event - The key event.
     */
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * End the session and land on the sign-in form. That is also where
   * `ProtectedRoute` sends the page the moment the session is gone, so naming
   * it here keeps the two from racing to different destinations.
   */
  async function onSignOut() {
    setOpen(false);
    await signOut();
    navigate("/sign-in", { replace: true });
  }

  return (
    <div className="shell-account" ref={root}>
      <button
        type="button"
        className="shell-account-trigger"
        data-testid="account-menu"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={user?.name ?? "Account"}
      >
        <span className="shell-account-avatar" aria-hidden="true">
          {user ? initials(user.name) : "?"}
        </span>
        {!collapsed && (
          <span className="shell-account-name" data-testid="account-name">
            {user?.name ?? "Not signed in"}
          </span>
        )}
        {!collapsed && <ChevronUp size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div className="shell-account-menu">
          {user && (
            <div className="shell-account-section">
              <span className="shell-account-heading">Signed in as</span>
              <span className="shell-account-email" data-testid="account-email">
                {user.email}
              </span>
            </div>
          )}
          <div
            className="shell-account-section"
            role="radiogroup"
            aria-label="Theme"
          >
            <span className="shell-account-heading">Theme</span>
            <div className="shell-theme-options">
              {THEME_OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={preference === value}
                  data-testid={`theme-${value}`}
                  className="shell-theme-option"
                  onClick={() => setPreference(value)}
                >
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Link
            to="/account"
            className="shell-account-item"
            data-testid="account-link"
            onClick={() => setOpen(false)}
          >
            Account
          </Link>
          <button
            type="button"
            className="shell-account-item"
            data-testid="sign-out"
            disabled={!user}
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
