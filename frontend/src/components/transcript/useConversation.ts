import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLiveChannel,
  useLiveReconnect,
} from "../../context/LiveSocketContext";
import { apiFetch } from "../../utils/client";
import type { LiveSurface } from "../chat/model";
import {
  type ConversationViewResponse,
  type Entry,
  lastSeqOf,
  mergeEntries,
} from "./model";

/** The largest page `conversation:entries` serves. */
const ENTRY_PAGE = 100;

/** What {@link useConversation} hands the page. */
export interface ConversationState {
  /** `conversation:view`'s answer, or `null` before the first one. */
  view: ConversationViewResponse | null;
  /** Every entry read so far, in seq order. */
  entries: Entry[];
  /**
   * What the bot is showing while it works — its status line, the text it is
   * writing, and its plan — read with the entries, or `null` before the
   * first read (or when it could not be read).
   */
  live: LiveSurface | null;
  /** Why the conversation could not be read, or `null`. */
  error: string | null;
  /** Whether the first read has finished, either way. */
  loaded: boolean;
  /** Read again now: the view, and entries after the last seq held. */
  refresh: () => Promise<void>;
}

/** The answer `conversation:entries` gives. */
interface EntriesPage {
  entries: Entry[];
  pagination: { page: number; pages: number };
}

/**
 * One conversation, kept current. It reads the conversation and its whole
 * transcript over HTTP, then follows the content-free
 * `project:<id>:conversation:<id>` channel: every frame means "something
 * changed", so the page re-reads the view and the entries `since` the newest
 * seq it holds, and `conversation:live` with them, so streamed text and the
 * status line arrive on the same pings. A reconnect re-reads the same way, so a frame missed while
 * the socket was down costs nothing. Reads never overlap: a frame that
 * arrives mid-read asks for one more read after it.
 * @param projectId - The project, or `null`.
 * @param conversationId - The conversation, or `null`.
 * @returns See {@link ConversationState}.
 */
export function useConversation(
  projectId: number | null,
  conversationId: number | null,
): ConversationState {
  const [view, setView] = useState<ConversationViewResponse | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState<LiveSurface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const held = useRef<Entry[]>([]);
  const busy = useRef(false);
  const again = useRef(false);
  // Which conversation the refs describe; an answer for another is dropped.
  const target = useRef<string | null>(null);

  const key =
    projectId !== null && conversationId !== null
      ? `${projectId}:${conversationId}`
      : null;

  const read = useCallback(async () => {
    if (key === null) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const base = `/project/${projectId}/conversation/${conversationId}`;
        const next = await apiFetch<ConversationViewResponse>(base);
        let since = lastSeqOf(held.current);
        let incoming: Entry[] = [];
        for (;;) {
          const page = await apiFetch<EntriesPage>(
            `${base}/entries?since=${since}&limit=${ENTRY_PAGE}`,
          );
          incoming = incoming.concat(page.entries);
          if (page.entries.length < ENTRY_PAGE) break;
          since = lastSeqOf(page.entries, since);
        }
        // The live surface is progress: a failure to read it never fails the page.
        const surface = await apiFetch<{ live: LiveSurface }>(`${base}/live`)
          .then((res) => res.live)
          .catch(() => null);
        if (target.current !== key) return;
        held.current = mergeEntries(held.current, incoming);
        setEntries(held.current);
        setLive(surface);
        setView(next);
        setError(null);
      } while (again.current);
    } catch (err) {
      if (target.current === key) {
        setError(err instanceof Error ? err.message : "Could not read it.");
      }
    } finally {
      busy.current = false;
      if (target.current === key) setLoaded(true);
    }
  }, [key, projectId, conversationId]);

  useEffect(() => {
    target.current = key;
    held.current = [];
    busy.current = false;
    again.current = false;
    setEntries([]);
    setLive(null);
    setView(null);
    setError(null);
    setLoaded(false);
    read();
  }, [key, read]);

  useLiveChannel(
    key === null ? null : `project:${projectId}:conversation:${conversationId}`,
    () => {
      read();
    },
  );
  useLiveReconnect(() => {
    read();
  });

  return { view, entries, live, error, loaded, refresh: read };
}
