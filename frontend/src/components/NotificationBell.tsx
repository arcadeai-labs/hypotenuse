import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  type AppNotification,
  useNotifications,
} from "../context/NotificationContext";
import { Button, Dropdown } from "../ui";

/**
 * Render a timestamp as "4m ago", which is what a notification list wants.
 *
 * A relative time rather than a clock, because the question a person asks of
 * this list is "is this new?" and not "what time was it?". The absolute time is
 * on the `title` attribute for whoever needs it.
 * @param epochMs - When it happened.
 * @returns A short relative string.
 */
export function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The sidebar bell: an unread count and the recent notifications behind it.
 * Drawn as a sidebar row so it survives the collapsed, icons-only sidebar.
 *
 * Clicking an item marks it read **and** navigates, in that order, because a
 * notification you have opened is one you have read and making that a second
 * deliberate act is busywork. The count comes from the context, so it is correct
 * whether it arrived over the socket or from a reconnect refresh.
 * @param props - `collapsed` draws only the icon (and the count as a dot).
 * @returns The rendered bell.
 */
export default function NotificationBell({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const {
    unreadCount,
    notifications,
    markRead,
    markAllRead,
    requestPermission,
    permission,
    declined,
  } = useNotifications();
  const navigate = useNavigate();

  /** Mark one read and go where it points. */
  async function open(notification: AppNotification) {
    if (!notification.readAt) {
      // Awaited so the badge is already right when the destination renders;
      // failing is not worth blocking the navigation over.
      await markRead([notification.id]).catch(() => {});
    }
    navigate(notification.linkPath);
  }

  return (
    <Dropdown className="shell-notifications" data-testid="notification-bell">
      <Dropdown.Toggle
        className="shell-nav-item"
        data-testid="notification-bell-toggle"
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

        {notifications.length === 0 && (
          <Dropdown.Item disabled data-testid="notification-empty">
            Nothing yet
          </Dropdown.Item>
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
            onClick={() => markAllRead().catch(() => {})}
            data-testid="notification-mark-all-read"
          >
            Mark all read
          </Button>
          {/* The permission ask lives behind a click and nowhere else — never on
              page load. Hidden once granted, and hidden after a refusal so the
              offer is not re-made every session. */}
          {permission === "default" && !declined && (
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => requestPermission()}
              data-testid="notification-enable-desktop"
            >
              Enable desktop notifications
            </Button>
          )}
        </div>
      </Dropdown.Menu>
    </Dropdown>
  );
}
