import { useNavigate } from "react-router-dom";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import Dropdown from "../ui/Dropdown";
import Nav from "../ui/Nav";
import {
  type AppNotification,
  useNotifications,
} from "../context/NotificationContext";

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
 * The navbar bell: an unread count and the recent notifications behind it.
 *
 * Clicking an item marks it read **and** navigates, in that order, because a
 * notification you have opened is one you have read and making that a second
 * deliberate act is busywork. The count comes from the context, so it is correct
 * whether it arrived over the socket or from a reconnect refresh.
 * @returns The rendered bell.
 */
export default function NotificationBell() {
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
    <Dropdown align="end" data-testid="notification-bell">
      <Dropdown.Toggle
        as={Nav.Link}
        id="tx-notification-bell"
        data-testid="notification-bell-toggle"
      >
        {/* A box-drawing glyph rather than an icon font: the theme's rule is
            that glyphs come from text, and one more webfont for a bell is not a
            trade worth making. */}
        <span aria-hidden="true">◈</span>
        <span className="visually-hidden">Notifications</span>
        {unreadCount > 0 && (
          <>
            {" "}
            <Badge bg="warning" data-testid="notification-unread-count">
              {unreadCount}
            </Badge>
          </>
        )}
      </Dropdown.Toggle>
      <Dropdown.Menu style={{ minWidth: "22rem" }}>
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
            <div className="d-flex justify-content-between align-items-start gap-2">
              <span className={notification.readAt ? "tx-muted" : undefined}>
                {!notification.readAt && (
                  <span aria-hidden="true" className="me-1">
                    ●
                  </span>
                )}
                {notification.title}
              </span>
              <span
                className="tx-muted small text-nowrap"
                title={new Date(notification.createdAt).toLocaleString()}
              >
                {relativeTime(notification.createdAt)}
              </span>
            </div>
          </Dropdown.Item>
        ))}

        <Dropdown.Divider />
        <div className="px-3 pb-2 d-flex flex-column gap-2">
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
