import { useEffect, useMemo, useRef } from "react";
import {
  useLiveReconnect,
  useLiveSocket,
} from "../../context/LiveSocketContext";
import { useRead } from "../bots/data";
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
 * @param projectId - The project, or `null`.
 * @returns The ids (empty until read).
 */
export function useReadableBotIds(projectId: number | null): number[] {
  const bots = useRead<{ bots: { id: number }[] }>(
    projectId === null ? null : `/project/${projectId}/bots?limit=100`,
  );
  return useMemo(() => bots.data?.bots.map((b) => b.id) ?? [], [bots.data]);
}
