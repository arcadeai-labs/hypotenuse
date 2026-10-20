import type { Page, Route } from "@playwright/test";

/**
 * Whether a route handler failed because the page or the test is already gone.
 *
 * A route handler outlives the assertions around it: a live page can still have
 * a refresh in flight when the test ends, and the handler is then inside
 * `route.fetch()`, which surfaces as an error that is not part of any test and
 * fails the whole file.
 *
 * Teardown reaches the handler at whichever line it happens to be on, so the
 * message varies: the fetch itself reports `Test ended`, and a fetch that
 * already returned reports `Response has been disposed` from the `.json()`
 * after it. Both are the same race and both have to be named here.
 * @param error - What the handler threw.
 * @returns Whether the page or test is already gone.
 */
function isStalePlaywrightRoute(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Test ended|has been closed|Target closed|has been disposed/i.test(
    message,
  );
}

/**
 * Run a route handler, ignoring fetches that outlive the test.
 * @param handle - The real handler.
 * @returns A Playwright route callback.
 */
export function ignoreStaleRoute(
  handle: (route: Route) => Promise<void>,
): (route: Route) => Promise<void> {
  return async (route) => {
    try {
      await handle(route);
    } catch (error) {
      if (isStalePlaywrightRoute(error)) return;
      throw error;
    }
  };
}

/** How many events one page of the transcript asks for; mirrors `EVENT_PAGE`. */
export const EVENT_PAGE = 200;

/** A handle on the fabricated transcript a spec is serving. */
export interface FakeTranscript {
  /** Say the run has produced this many events in total. */
  grow: (total: number) => void;
}

/**
 * Serve a run's transcript from the test instead of from the database.
 *
 * A browser is the only place the log's *window* can be tested — whether it
 * fits the page, whether it fits the panel it is in, whether it follows the
 * newest line, whether it lets go when somebody scrolls up — and none of that
 * is reachable with the handful of events a run that fails provisioning
 * produces. So the events endpoint answers with a transcript the test decides
 * the length of, honoring `afterId` exactly as the real one does, which is what
 * keeps the page's drain loop terminating: a short page means there is no more.
 *
 * Every event is its own `assistant` row, deliberately. Tool calls pair with
 * their results and reasoning folds, so an id would stop being a row and
 * counting rows would stop being counting events.
 *
 * Fulfilled from the real response rather than hand-built: these specs are
 * cross-origin, and a body without the backend's own CORS headers fails in the
 * browser as a network error rather than as the thing being simulated. GET
 * only — PUT on this route is the supervisor's own ingest.
 * @param page - The Playwright page.
 * @returns The handle that decides how much transcript exists.
 */
export async function fakeRunEvents(page: Page): Promise<FakeTranscript> {
  let total = 0;

  await page.route(
    (url) => url.pathname === "/api/run/events",
    ignoreStaleRoute(async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const url = new URL(route.request().url());
      const afterId = Number(url.searchParams.get("afterId") ?? 0);
      const events = [];
      for (
        let id = afterId + 1;
        id <= total && events.length < EVENT_PAGE;
        id++
      ) {
        events.push({
          id,
          runId: 1,
          seq: id,
          occurredAt: Date.now() - (total - id) * 1_000,
          type: "assistant",
          toolName: null,
          text: `Step ${id}: still working on it.`,
          payload: {},
        });
      }
      await route.fulfill({
        response,
        json: {
          events,
          pagination: {
            page: 1,
            limit: EVENT_PAGE,
            total,
            pages: Math.ceil(total / EVENT_PAGE),
          },
        },
      });
    }),
  );

  return { grow: (next: number) => (total = next) };
}
