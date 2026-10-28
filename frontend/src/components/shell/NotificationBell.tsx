import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  type AppNotification,
  useNotifications,
} from "../../context/NotificationContext";
import { Button, Dropdown } from "../../ui";
import { NOT_SIGNED_IN } from "./shellData";

/**
 * Render a timestamp as "4m ago". The question a person asks of this list is
 * "is this new?", not "what time was it?"; the absolute time is on `title`.
 * @param epochMs - When it happened.
 * @param now - The time to measure from (a test passes its own).
 * @returns A short relative string.
 */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The sidebar's bell: the active project's unread count and its recent
 * notifications. Drawn as a sidebar row so it survives the collapsed,
 * icons-only sidebar, where the count becomes a dot.
 *
 * Opening an item marks it read and then navigates, because a notification
 * you have opened is one you have read. Signed out, the bell is still there,
 * disabled, so the sidebar keeps one shape.
 * @param props - `collapsed` draws only the icon; `signedIn` enables it.
 * @returns The bell.
 */
export function NotificationBell({
  collapsed = false,
  signedIn,
}: {
  collapsed?: boolean;
  signedIn: boolean;
}) {
  const { unreadCount, notifications, loaded, markRead, markAllRead } =
    useNotifications();
  const navigate = useNavigate();

  /**
   * Mark one read and go where it points.
   * @param notification - The row opened.
   */
  async function open(notification: AppNotification) {
    if (!notification.readAt) {
      await markRead([notification.id]).catch(() => {});
    }
    navigate(notification.linkPath);
  }

  if (!signedIn) {
    return (
      <div className="shell-notifications" data-testid="notification-bell">
        <span
          className="shell-nav-item is-disabled"
          data-testid="notification-bell-toggle"
          aria-disabled="true"
          title={collapsed ? `Notifications · ${NOT_SIGNED_IN}` : NOT_SIGNED_IN}
        >
          <Bell size={16} aria-hidden="true" />
          <span className="shell-nav-label">Notifications</span>
        </span>
      </div>
    );
  }

  return (
    <Dropdown className="shell-notifications" data-testid="notification-bell">
      <Dropdown.Toggle
        className="shell-nav-item"
        data-testid="notification-bell-toggle"
        data-unread={unreadCount}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        title={collapsed ? "Notifications" : undefined}
      >
        <Bell size={16} aria-hidden="true" />
        <span className="shell-nav-label">Notifications</span>
        {unreadCount > 0 && (
          <span
            className="shell-nav-count shell-unread tabular"
            data-testid="notification-unread-count"
          >
            {unreadCount}
          </span>
        )}
      </Dropdown.Toggle>
      <Dropdown.Menu className="notification-menu">
        <Dropdown.Header>Notifications</Dropdown.Header>
        {loaded && notifications.length === 0 && (
          <div className="notification-empty" data-testid="notification-empty">
            Nothing yet. A bot that needs a person here will say so in this
            list.
          </div>
        )}
        {!loaded && (
          <div
            className="notification-empty"
            data-testid="notification-loading"
          >
            Loading
          </div>
        )}
        {notifications.map((notification) => (
          <Dropdown.Item
            key={notification.id}
            onClick={() => open(notification)}
            data-testid={`notification-item-${notification.id}`}
          >
            <div className="notification-row">
              <span
                className={
                  notification.readAt
                    ? "notification-title text-muted"
                    : "notification-title is-unread"
                }
              >
                {notification.title}
              </span>
              <span
                className="text-meta text-nowrap"
                title={new Date(notification.createdAt).toLocaleString()}
              >
                {relativeTime(notification.createdAt)}
              </span>
            </div>
          </Dropdown.Item>
        ))}
        <Dropdown.Divider />
        <div className="notification-actions">
          <Button
            size="sm"
            variant="outline-secondary"
            disabled={unreadCount === 0}
            title={unreadCount === 0 ? "Nothing unread" : undefined}
            onClick={() => markAllRead().catch(() => {})}
            data-testid="notification-mark-all-read"
          >
            Mark all read
          </Button>
        </div>
      </Dropdown.Menu>
    </Dropdown>
  );
}
