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

/** One in-app notification, as `notification:list` returns it. */
export type AppNotification =
  ActionResponse<NotificationList>["notifications"][number];

/** How many notifications the bell's menu holds. */
const RECENT_LIMIT = 15;

/** How long an in-app toast stays on screen. */
const TOAST_MS = 8_000;

/** A toast currently on screen. */
export interface NotificationToast {
  id: number;
  title: string;
  body: string;
  linkPath: string;
}

/**
 * Add a toast unless one for that notification is already on screen. Keyed on
 * the notification id: frames are best-effort, so a repeat is a thing that
 * happens, and it must not stack a second copy.
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
 * ids already seen in this tab. `seen` is `null` until the first read settles;
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

/**
 * Fold one read into the tab's history: which rows to toast, and the ids seen.
 * `fresh` is `null` when no read was applied (superseded, or failed), which
 * must change nothing — an empty first read would make the next real read
 * toast the whole backlog.
 * @param seen - Ids already seen, or `null` before the first read.
 * @param fresh - The list just read, or `null` if no read was applied.
 * @returns The rows to toast and the history to keep.
 */
export function applyRead(
  seen: ReadonlySet<number> | null,
  fresh: AppNotification[] | null,
): { arrivals: AppNotification[]; seen: ReadonlySet<number> | null } {
  if (fresh === null) return { arrivals: [], seen };
  return {
    arrivals: newArrivals(seen, fresh),
    seen: new Set([...(seen ?? []), ...fresh.map((n) => n.id)]),
  };
}

/** Everything the bell and the toasts read. */
export interface NotificationState {
  /** Unread notifications for the active project. */
  unreadCount: number;
  /** The most recent notifications, newest first. */
  notifications: AppNotification[];
  /** Whether the first read has answered. */
  loaded: boolean;
  /** Toasts currently on screen. */
  toasts: NotificationToast[];
  /** Mark specific notifications read. */
  markRead: (ids: number[]) => Promise<void>;
  /** Mark every unread notification in the active project read. */
  markAllRead: () => Promise<void>;
  /** Re-read the list and the count; resolves with the list, or `null` when superseded or failed. */
  refresh: () => Promise<AppNotification[] | null>;
  /** Dismiss one toast. */
  dismissToast: (id: number) => void;
}

const NotificationContext = createContext<NotificationState | null>(null);

/**
 * The per-project notification channel's name. The backend's pattern is
 * `project:<projectId>:notifications`.
 * @param projectId - The project.
 * @returns The channel name.
 */
export function notificationsChannel(projectId: number): string {
  return `project:${projectId}:notifications`;
}

/**
 * Whether an inner payload is the notification ping. The frame is exactly
 * `{ event: "notifications" }` — no id, no recipient, no content.
 * @param payload - The inner PubSub payload.
 * @returns Whether to re-read notifications.
 */
export function isNotificationsPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as { event?: unknown }).event === "notifications";
}

/**
 * Whether a raw socket frame is the notification ping, through the doubly
 * wrapped wire format.
 * @param raw - The frame's `data`.
 * @returns Whether to re-read notifications.
 */
export function isNotificationsBroadcast(raw: unknown): boolean {
  const envelope = parseSocketEnvelope(raw);
  return envelope !== null && isNotificationsPayload(envelope.payload);
}

/**
 * Live notifications: the unread count and recent rows for the active project,
 * kept current by the content-free `project:<id>:notifications` channel and
 * re-read on every reconnect.
 *
 * **The socket is an accelerant, not the delivery mechanism.** Every
 * notification is a row before it is a broadcast, so a tab whose socket died
 * still finds the unread count waiting on its next read. Everything shown
 * comes from `notification:list`, scoped to the session's own user, which is
 * what makes one shared per-project channel safe.
 * @param props.children - The subtree that consumes {@link useNotifications}.
 * @returns The provider element.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user, activeProjectId } = useAuth();
  const userId = user?.id ?? null;

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toasts, setToasts] = useState<NotificationToast[]>([]);

  const seen = useRef<ReadonlySet<number> | null>(null);
  // Only the newest read may write: a switch while a read is in flight would
  // otherwise let the older answer land last, with another project's count.
  const latest = useRef(0);
  const refreshRef = useRef<() => Promise<AppNotification[] | null>>(
    async () => null,
  );

  const refresh = useCallback(async (): Promise<AppNotification[] | null> => {
    const ticket = ++latest.current;
    if (userId === null) {
      setUnreadCount(0);
      setNotifications([]);
      setLoaded(false);
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
      if (ticket !== latest.current) return null;
      setNotifications(list.notifications);
      setUnreadCount(count.count);
      setLoaded(true);
      return list.notifications;
    } catch {
      // A failed read leaves the last known state on screen.
      return null;
    }
  }, [userId, activeProjectId]);
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

  /** Re-read, then toast whatever arrived since the last read. */
  const refreshAndToast = useCallback(async () => {
    const read = applyRead(seen.current, await refreshRef.current());
    for (const arrived of read.arrivals) {
      setToasts((current) =>
        appendToast(current, {
          id: arrived.id,
          title: arrived.title,
          body: arrived.body,
          linkPath: arrived.linkPath,
        }),
      );
      setTimeout(
        () =>
          setToasts((current) => current.filter((t) => t.id !== arrived.id)),
        TOAST_MS,
      );
    }
    seen.current = read.seen;
  }, []);

  useLiveChannel(
    userId !== null && activeProjectId
      ? notificationsChannel(activeProjectId)
      : null,
    (payload) => {
      if (isNotificationsPayload(payload)) void refreshAndToast();
    },
  );

  useLiveReconnect(() => {
    void refreshAndToast();
  });

  // A different person or project starts a new history: its backlog is not news.
  useEffect(() => {
    seen.current = null;
    void refreshAndToast();
  }, [refresh, refreshAndToast]);

  // A tab coming back into view re-reads too: a socket that died while the
  // tab slept is the normal failure, and this is the cheap net under it.
  useEffect(() => {
    /** Re-read when the tab becomes visible. */
    function onVisible(): void {
      if (document.visibilityState === "visible") void refreshAndToast();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshAndToast]);

  const value = useMemo<NotificationState>(
    () => ({
      unreadCount,
      notifications,
      loaded,
      toasts,
      markRead,
      markAllRead,
      refresh,
      dismissToast,
    }),
    [
      unreadCount,
      notifications,
      loaded,
      toasts,
      markRead,
      markAllRead,
      refresh,
      dismissToast,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
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
