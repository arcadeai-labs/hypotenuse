import type { HelpList } from "@backend/actions/help/help-list";
import type { HelpView } from "@backend/actions/help/help-view";
import type { TriggerEventList } from "@backend/actions/trigger-event/trigger-event-list";
import type { ActionResponse } from "keryx";

/** One row of `help:list`. */
export type HelpRow = ActionResponse<HelpList>["helpRequests"][number];

/** `help:view`'s answer. */
export type HelpDetail = ActionResponse<HelpView>;

/** One row of `trigger-event:list`. */
export type TriggerEventRow =
  ActionResponse<TriggerEventList>["triggerEvents"][number];

/** The page size the help inbox and the events log ask for. */
export const PAGE_SIZE = 25;

/** The help inbox's status filters, in the order the chips are drawn. Pending is the inbox. */
export const HELP_FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "answered", label: "Answered" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
  { value: "", label: "All" },
] as const;

/**
 * A help request's status, as a person reads it.
 * @param status - `pending`, `answered`, `expired`, or `cancelled`.
 * @returns The word.
 */
export function helpStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Waiting for an answer";
    case "answered":
      return "Answered";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

/**
 * How urgent a request is, as a chip reads.
 * @param urgency - `low`, `normal`, or `high`.
 * @returns The word.
 */
export function urgencyLabel(urgency: string): string {
  switch (urgency) {
    case "high":
      return "Urgent";
    case "low":
      return "Low";
    default:
      return "Normal";
  }
}

/**
 * The query string for one page of a filtered list.
 * @param filters - The filters set, by name; an empty value is left out.
 * @param page - The 1-indexed page.
 * @returns `?page=…&limit=…` plus each filter that is set.
 */
export function listQuery(
  filters: Record<string, string | undefined>,
  page: number,
): string {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return `?${params}`;
}

/** The events log's status filters. */
export const EVENT_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "processed", label: "Processed" },
  { value: "ignored", label: "Ignored" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
] as const;

/**
 * What a trigger event's status says.
 * @param status - `pending`, `processed`, `ignored`, or `failed`.
 * @returns The word.
 */
export function eventStatusLabel(status: string): string {
  switch (status) {
    case "processed":
      return "Processed";
    case "ignored":
      return "Ignored";
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
    default:
      return status;
  }
}
