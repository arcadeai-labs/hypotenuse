import { ChevronUp, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type ThemePreference, useTheme } from "../../context/ThemeContext";
import { initials } from "../../ui";
import { NOT_SIGNED_IN, type ShellUser } from "./shellData";

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** See {@link AccountMenu}. */
export interface AccountMenuProps {
  /** Draw only the trigger's avatar. */
  collapsed?: boolean;
  /** Who is signed in, or `null`. */
  user: ShellUser | null;
  /** End the session. */
  onSignOut?: () => void;
  /** Invitations waiting for the person, drawn beside Invites. */
  pendingInvites?: number;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * The account menu at the foot of the sidebar: who is signed in, the account
 * and invites pages, the theme control, and sign-out. The person-scoped items
 * are disabled, not absent, while there is no session, so one selector
 * resolves in both states; signed out, the menu also offers Sign in.
 * @param props - See {@link AccountMenuProps}.
 * @returns The menu.
 */
export function AccountMenu({
  collapsed = false,
  user,
  onSignOut,
  pendingInvites = 0,
  onNavigate,
}: AccountMenuProps) {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  /** Close the menu, and tell the sheet a choice was made. */
  const close = () => {
    setOpen(false);
    onNavigate?.();
  };

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
          {user ? (
            <>
              <Link
                to="/account"
                className="shell-account-item"
                data-testid="account-link"
                onClick={close}
              >
                Account
              </Link>
              <Link
                to="/invites"
                className="shell-account-item"
                data-testid="invites-link"
                onClick={close}
              >
                Invites
                {pendingInvites > 0 && (
                  <span
                    className="shell-nav-count shell-unread tabular"
                    data-testid="pending-invites-count"
                  >
                    {pendingInvites}
                  </span>
                )}
              </Link>
            </>
          ) : (
            <>
              <button
                type="button"
                className="shell-account-item"
                data-testid="account-link"
                disabled
                title={NOT_SIGNED_IN}
              >
                Account
              </button>
              <button
                type="button"
                className="shell-account-item"
                data-testid="invites-link"
                disabled
                title={NOT_SIGNED_IN}
              >
                Invites
              </button>
              <Link
                to="/sign-in"
                className="shell-account-item"
                data-testid="account-sign-in"
                onClick={close}
              >
                Sign in
              </Link>
            </>
          )}
          <button
            type="button"
            className="shell-account-item"
            data-testid="sign-out"
            disabled={!user}
            title={user ? undefined : NOT_SIGNED_IN}
            onClick={() => {
              close();
              onSignOut?.();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
