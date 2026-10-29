import type { BotList } from "@backend/actions/bot/bot-list";
import type { BotView } from "@backend/actions/bot/bot-view";
import type { ModelAliasList } from "@backend/actions/model-alias/model-alias-list";
import type { TagList } from "@backend/actions/tag/tag-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../utils/client";

/** A bot as `bot:view` serializes it. */
export type Bot = ActionResponse<BotView>["bot"];

/** What the caller may do with a bot, as the server decided it. */
export type BotStanding = ActionResponse<BotView>["standing"];

/** A row of `bot:list`: the bot and the caller's standing on it. */
export type BotRow = ActionResponse<BotList>["bots"][number];

/** `model-alias:list`'s answer. */
export type ModelAliasesResponse = ActionResponse<ModelAliasList>;

/** A project tag, as `tag:list` serializes it. */
export type ProjectTag = ActionResponse<TagList>["tags"][number];

/** What a read hook hands a page. */
export interface Read<T> {
  /** The answer, or `null` before the first one. */
  data: T | null;
  /** Why the last read failed, or `null`. */
  error: string | null;
  /** Read again. */
  reload: () => Promise<void>;
}

/**
 * Read one GET route for the active project, keyed by its path, so a
 * project switch reads afresh and an answer for a stale path is dropped.
 * @param path - The route beneath `/api`, or `null` while there is nothing to read.
 * @returns See {@link Read}.
 */
export function useRead<T>(path: string | null): Read<T> {
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    error: string | null;
  } | null>(null);

  const reload = useCallback(async () => {
    if (path === null) return;
    try {
      const data = await apiFetch<T>(path);
      setState({ path, data, error: null });
    } catch (err) {
      setState((current) => ({
        path,
        data: current?.path === path ? current.data : null,
        error: err instanceof Error ? err.message : "Could not load this.",
      }));
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  const fresh = state !== null && state.path === path;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    reload,
  };
}

/**
 * The active project's model names, for a bot's model pickers and the
 * missing-names banner.
 * @param projectId - The project, or `null`.
 * @returns See {@link Read}.
 */
export function useModelAliases(
  projectId: number | null,
): Read<ModelAliasesResponse> {
  return useRead<ModelAliasesResponse>(
    projectId === null ? null : `/project/${projectId}/model-aliases?limit=100`,
  );
}

/**
 * The active project's tags, for the access pickers. The reserved `admin` tag
 * is left out: admins pass every list whether it names them or not.
 * @param projectId - The project, or `null`.
 * @returns The tags, or `null` before the answer.
 */
export function useAccessTags(projectId: number | null): ProjectTag[] | null {
  const { data } = useRead<ActionResponse<TagList>>(
    projectId === null ? null : `/project/${projectId}/tags?limit=100`,
  );
  return data ? data.tags.filter((tag) => !tag.reserved) : null;
}
