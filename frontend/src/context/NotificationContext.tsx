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
const PERMISSION_DECLINED_KEY = "toolexec.desktopNotificationsDeclined";

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

/** Everything the bell, the toasts, and the inbox read. */
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
 * **A broadcast carries no content** — an id and a recipient — so everything
 * shown comes from re-reading `notification:list`, which is scoped to the
 * session's own user. That is what lets one shared per-project channel be safe:
 * a member excluded by an agent's `accessRead` receives frames that say nothing.
 * The client-side `userId` filter saves a round trip; it is not the boundary.
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

  const userId = useRef<number | null>(null);
  userId.current = user?.id ?? null;
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
      // Returned as well as stored, so the socket handler can raise a toast from
      // the freshly fetched rows rather than from anything the frame carried —
      // the frame deliberately carries no content.
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
          tag: `toolexec-${notification.id}`,
        });
      } catch {
        // Some browsers throw from the constructor when the page is not in a
        // service-worker context. The in-app toast already fired.
      }
    }
  }

  useLiveChannel(
    user && activeProjectId ? `project:${activeProjectId}:notifications` : null,
    (payload) => {
      const signal = parseNotificationPayload(payload);
      if (!signal) return;
      // A convenience, not a boundary — the frame carries no content to
      // protect. It saves a round trip on somebody else's notification.
      if (signal.userId !== userId.current) return;

      // **Everything shown comes from the re-read, not from the frame.**
      void refreshRef.current().then((fresh) => {
        const arrived = fresh.find((n) => n.id === signal.id);
        if (arrived) showToast(arrived);
      });
    },
  );

  useLiveReconnect(() => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

/** All a broadcast frame carries: which notification, and for whom. */
export interface NotificationSignal {
  id: number;
  userId: number;
}

/**
 * Pull the signal out of a parsed inner payload.
 *
 * **The payload is an id and a recipient by design**, so this returns exactly
 * those two fields and nothing that pretends to be content. Anything with a
 * shape other than that is dropped: a frame from an older deploy that still
 * carried a full payload would yield only its id and `userId`, which is the
 * conservative reading rather than a parse failure.
 *
 * The Keryx wrapper lives in {@link parseSocketEnvelope}; live handlers
 * receive the inner payload already unwrapped.
 * @param payload - The inner PubSub payload.
 * @returns The signal, or `null` for anything that is not a notification.
 */
export function parseNotificationPayload(
  payload: unknown,
): NotificationSignal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as {
    event?: string;
    notification?: { id?: unknown; userId?: unknown };
  };
  if (body.event !== "notification" || !body.notification) return null;

  const { id, userId } = body.notification;
  if (typeof id !== "number" || typeof userId !== "number") return null;
  return { id, userId };
}

/**
 * Pull the signal out of a raw socket frame.
 *
 * Kept as the test-facing reader of the doubly-wrapped wire format. Live
 * handlers receive the inner payload from {@link parseSocketEnvelope} and
 * call {@link parseNotificationPayload} directly.
 * @param raw - The frame's `data`.
 * @returns The signal, or `null` for anything that is not a notification.
 */
export function parseBroadcast(raw: unknown): NotificationSignal | null {
  const envelope = parseSocketEnvelope(raw);
  if (!envelope) return null;
  return parseNotificationPayload(envelope.payload);
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
