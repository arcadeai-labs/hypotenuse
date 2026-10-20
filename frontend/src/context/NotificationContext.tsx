import type { NotificationList } from "@backend/actions/notification/notification-list";
import type { NotificationUnreadCount } from "@backend/actions/notification/notification-unread-count";
import type { ActionResponse } from "keryx";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "../utils/client";
import { useAuth } from "./AuthContext";
import {
  parseSocketEnvelope,
  useLiveChannel,
  useLiveReconnect,
} from "./LiveSocketContext";

/** One in-app notification, derived from `notification:list`. */
export type AppNotification =
  ActionResponse<NotificationList>["notifications"][number];

/** How many notifications the bell's dropdown holds. */
const RECENT_LIMIT = 15;

/** How long an in-app toast stays on screen. */
const TOAST_MS = 8_000;

/** `localStorage` key remembering that the user declined desktop notifications. */
const PERMISSION_DECLINED_KEY = "hypotenuse.desktopNotificationsDeclined";

/** A toast currently on screen. */
export interface NotificationToast {
  id: number;
  title: string;
  body: string;
  linkPath: string;
}

/**
 * Add a toast unless one for that notification is already on screen.
 *
 * **Keyed on the notification id**, which is the same guarantee the desktop
 * notification gets for free from its `tag`. A duplicate or replayed PubSub
 * frame would otherwise stack identical toasts on top of each other until their
 * timers expired — and the frames are explicitly best-effort, so a repeat is a
 * thing that happens rather than a thing that would be a bug elsewhere.
 *
 * A pure function so it can be tested without a DOM; the socket handler is
 * inside an effect and would otherwise need a rendered tree to exercise.
 * @param current - The toasts on screen.
 * @param toast - The one that just arrived.
 * @returns The new list, unchanged when it is already there.
 */
export function appendToast(
  current: NotificationToast[],
  toast: NotificationToast,
): NotificationToast[] {
  if (current.some((t) => t.id === toast.id)) return current;
  return [...current, toast];
}

/**
 * The rows a re-read turned up that deserve a toast: unread, and not among the
 * ids already seen in this tab.
 *
 * A broadcast says only that *something* changed, so the toast set is decided
 * here, from the fresh list. `seen` is `null` until the first read settles;
 * that read seeds the set and toasts nothing, or every page load would replay
 * the whole unread backlog as toasts.
 * @param seen - Ids already seen, or `null` before the first read.
 * @param fresh - The list just re-read from the server.
 * @returns The rows to toast, oldest first.
 */
export function newArrivals(
  seen: ReadonlySet<number> | null,
  fresh: AppNotification[],
): AppNotification[] {
  if (seen === null) return [];
  return fresh.filter((n) => !n.readAt && !seen.has(n.id)).reverse();
}

/** Everything the bell and the toasts read. */
export interface NotificationState {
  /** Unread `browser` notifications for the active project. */
  unreadCount: number;
  /** The most recent notifications, newest first. */
  notifications: AppNotification[];
  /** Toasts currently on screen. */
  toasts: NotificationToast[];
  /** Mark specific notifications read. */
  markRead: (ids: number[]) => Promise<void>;
  /** Mark every unread notification of the caller's read. */
  markAllRead: () => Promise<void>;
  /** Re-read the list and the count from the server; resolves with the list. */
  refresh: () => Promise<AppNotification[]>;
  /** Dismiss one toast. */
  dismissToast: (id: number) => void;
  /** Ask the browser for desktop-notification permission. From a click only. */
  requestPermission: () => Promise<void>;
  /** The current permission, or `"unsupported"` where the API does not exist. */
  permission: NotificationPermission | "unsupported";
  /** Whether the user has previously declined our offer to enable them. */
  declined: boolean;
}

const NotificationContext = createContext<NotificationState | null>(null);

/**
 * Live notifications: a shared socket subscription, a reconnect refresh, and
 * the toasts.
 *
 * **The socket is an accelerant, not the delivery mechanism.** Every
 * notification is a row before it is a broadcast, so a user whose tab was closed
 * — or whose socket died an hour ago — still finds the unread badge waiting on
 * their next page load. Nothing here depends on a socket having been open, and
 * that is what makes it safe for the socket to be best-effort.
 *
 * **A broadcast carries no content at all** — the frame is exactly
 * `{ event: "notifications" }` — so everything shown comes from re-reading
 * `notification:list`, which is scoped to the session's own user. That is what
 * lets one shared per-project channel be safe: every member receives the same
 * frame, and it says nothing. Which rows become toasts is decided by
 * {@link newArrivals} against the ids this tab has already seen.
 * @param props.children - The subtree that consumes {@link useNotifications}.
 * @returns The provider element.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user, activeProjectId } = useAuth();

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<NotificationToast[]>([]);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(() =>
    typeof window !== "undefined" && "Notification" in window
      ? window.Notification.permission
      : "unsupported",
  );
  const [declined, setDeclined] = useState(
    () => localStorage.getItem(PERMISSION_DECLINED_KEY) === "true",
  );

  const seen = useRef<Set<number> | null>(null);
  const refreshRef = useRef<() => Promise<AppNotification[]>>(async () => []);

  const refresh = useCallback(async (): Promise<AppNotification[]> => {
    if (!user) {
      setUnreadCount(0);
      setNotifications([]);
      return [];
    }

    const scope = new URLSearchParams(
      activeProjectId ? { projectId: String(activeProjectId) } : {},
    );
    const listParams = new URLSearchParams(scope);
    listParams.set("limit", String(RECENT_LIMIT));

    try {
      const [list, count] = await Promise.all([
        apiFetch<ActionResponse<NotificationList>>(
          `/notifications?${listParams}`,
        ),
        apiFetch<ActionResponse<NotificationUnreadCount>>(
          `/notifications/unread-count?${scope}`,
        ),
      ]);
      setNotifications(list.notifications);
      setUnreadCount(count.count);
      // Returned as well as stored, so the socket handler can raise toasts from
      // the freshly fetched rows — the frame deliberately carries no content.
      return list.notifications;
    } catch {
      // A failed refresh leaves the last known state on screen. The badge being
      // briefly stale is a far smaller problem than the bell emptying itself
      // because one request lost a race with a session refresh.
      return [];
    }
  }, [user, activeProjectId]);

  // Kept current every render, so the socket's message handler always calls the
  // live `refresh` without holding it as a dependency.
  refreshRef.current = refresh;

  const markRead = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      await apiFetch("/notifications/read", {
        method: "POST",
        body: JSON.stringify({ notificationIds: ids }),
      });
      await refresh();
    },
    [refresh],
  );

  const markAllRead = useCallback(async () => {
    await apiFetch("/notifications/read", {
      method: "POST",
      body: JSON.stringify({
        all: true,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      }),
    });
    await refresh();
  }, [refresh, activeProjectId]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  /**
   * Ask for desktop-notification permission.
   *
   * **Only ever from a click.** Browsers increasingly ignore or penalize an
   * unprompted `requestPermission()`, and a permission dialog on first visit
   * reads as hostile. A refusal is remembered so the offer is not made again
   * every session.
   */
  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await window.Notification.requestPermission();
    setPermission(result);
    if (result !== "granted") {
      localStorage.setItem(PERMISSION_DECLINED_KEY, "true");
      setDeclined(true);
    }
  }, []);

  /**
   * Raise an in-app toast, and an OS one when the tab is not being looked at.
   * @param notification - The row just re-read from the server.
   */
  function showToast(notification: AppNotification) {
    setToasts((current) =>
      appendToast(current, {
        id: notification.id,
        title: notification.title,
        body: notification.body,
        linkPath: notification.linkPath,
      }),
    );
    setTimeout(
      () =>
        setToasts((current) => current.filter((t) => t.id !== notification.id)),
      TOAST_MS,
    );

    // **Only when the tab is hidden.** A desktop toast stacked on top of an
    // in-app toast the user is already looking at is noise, not redundancy.
    // Gated on the API existing at all, because it is absent in some embedded
    // contexts and the in-app toast has to work regardless.
    if (
      "Notification" in window &&
      window.Notification.permission === "granted" &&
      document.visibilityState === "hidden"
    ) {
      try {
        new window.Notification(notification.title, {
          body: notification.body,
          tag: `hypotenuse-${notification.id}`,
        });
      } catch {
        // Some browsers throw from the constructor when the page is not in a
        // service-worker context. The in-app toast already fired.
      }
    }
  }

  /**
   * Re-read, then toast whatever arrived since the last read.
   * @returns Nothing; failures leave the last known state on screen.
   */
  const refreshAndToast = useCallback(async () => {
    const fresh = await refreshRef.current();
    for (const arrived of newArrivals(seen.current, fresh)) showToast(arrived);
    seen.current = new Set([
      ...(seen.current ?? []),
      ...fresh.map((n) => n.id),
    ]);
    // `showToast` only touches state setters, so an empty list is honest.
  }, []);

  useLiveChannel(
    user && activeProjectId ? notificationsChannel(activeProjectId) : null,
    (payload) => {
      // **Everything shown comes from the re-read, not from the frame.**
      if (isNotificationsPayload(payload)) void refreshAndToast();
    },
  );

  useLiveReconnect(() => {
    void refreshAndToast();
  });

  // A different user or project starts a new history: its backlog is not news.
  useEffect(() => {
    seen.current = null;
    void refreshAndToast();
  }, [refresh, refreshAndToast]);

  const value = useMemo<NotificationState>(
    () => ({
      unreadCount,
      notifications,
      toasts,
      markRead,
      markAllRead,
      refresh,
      dismissToast,
      requestPermission,
      permission,
      declined,
    }),
    [
      unreadCount,
      notifications,
      toasts,
      markRead,
      markAllRead,
      refresh,
      dismissToast,
      requestPermission,
      permission,
      declined,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * The per-project notification channel's name. The backend's pattern is
 * `/^project:(\d+):notifications$/`.
 * @param projectId - The project.
 * @returns The channel name.
 */
export function notificationsChannel(projectId: number): string {
  return `project:${projectId}:notifications`;
}

/**
 * Whether an inner payload is the notification ping.
 *
 * **The frame is exactly `{ event: "notifications" }`** — no id, no recipient,
 * no content. Anything else on the socket (subscribe confirmations, presence,
 * another channel's ping) is not this.
 * @param payload - The inner PubSub payload.
 * @returns Whether to re-read notifications.
 */
export function isNotificationsPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as { event?: unknown }).event === "notifications";
}

/**
 * Whether a raw socket frame is the notification ping. The test-facing reader
 * of the doubly-wrapped wire format; live handlers receive the inner payload
 * from {@link parseSocketEnvelope} and call {@link isNotificationsPayload}.
 * @param raw - The frame's `data`.
 * @returns Whether to re-read notifications.
 */
export function isNotificationsBroadcast(raw: unknown): boolean {
  const envelope = parseSocketEnvelope(raw);
  return envelope !== null && isNotificationsPayload(envelope.payload);
}

/**
 * Access the current {@link NotificationState}.
 * @returns The notification state.
 * @throws {Error} If called outside a {@link NotificationProvider}.
 */
export function useNotifications(): NotificationState {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error(
      "useNotifications must be used within a NotificationProvider",
    );
  }
  return ctx;
}
