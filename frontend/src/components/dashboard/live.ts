import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLiveReconnect,
  useLiveSocket,
} from "../../context/LiveSocketContext";
import { apiFetch } from "../../utils/client";
import { botDashboardChannel, type DashboardStale, staleOf } from "./model";

/** How long a burst of frames is gathered into one re-read. */
const DEBOUNCE_MS = 400;

/**
 * Follow the dashboard channels of the bots a page shows and re-read when
 * one of `kinds` goes stale. A burst of frames (a streaming step pings many
 * times) becomes one trailing re-read; a reconnect re-reads too. A frame
 * carries no content, so the re-read goes through the same gated action the
 * page first read with.
 * @param projectId - The project, or `null`.
 * @param botIds - The bots whose channels to follow (the reader's readable bots).
 * @param kinds - Which stale kinds this page cares about.
 * @param onStale - The re-read.
 */
export function useDashboardFrames(
  projectId: number | null,
  botIds: readonly number[],
  kinds: readonly DashboardStale[],
  onStale: () => void,
): void {
  const { subscribe } = useLiveSocket();
  const handler = useRef(onStale);
  handler.current = onStale;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelKey = useMemo(
    () =>
      projectId === null
        ? ""
        : [...new Set(botIds)]
            .sort((a, b) => a - b)
            .map((id) => botDashboardChannel(projectId, id))
            .join(","),
    [projectId, botIds],
  );
  const kindKey = kinds.join(",");

  useEffect(() => {
    if (!channelKey) return;
    const wanted = new Set(kindKey.split(","));
    const onFrame = (payload: unknown) => {
      const stale = staleOf(payload);
      if (!stale || !wanted.has(stale)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        handler.current();
      }, DEBOUNCE_MS);
    };
    const leaves = channelKey
      .split(",")
      .map((channel) => subscribe(channel, onFrame));
    return () => {
      for (const leave of leaves) leave();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [channelKey, kindKey, subscribe]);

  useLiveReconnect(() => handler.current());
}

/**
 * The ids of the bots the reader may read in a project — `bot:list` filters
 * by `canReadBot` — which are the dashboard channels a list page follows.
 * Every page of the list is read, so a project with more bots than one page
 * holds still follows them all.
 * @param projectId - The project, or `null`.
 * @returns The ids (empty until read).
 */
export function useReadableBotIds(projectId: number | null): number[] {
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => {
    setIds([]);
    if (projectId === null) return;
    let cancelled = false;
    (async () => {
      const all: number[] = [];
      for (let page = 1; ; page++) {
        const res = await apiFetch<{
          bots: { id: number }[];
          pagination: { pages: number };
        }>(`/project/${projectId}/bots?limit=100&page=${page}`);
        all.push(...res.bots.map((b) => b.id));
        if (page >= res.pagination.pages) break;
      }
      if (!cancelled) setIds(all);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return ids;
}
