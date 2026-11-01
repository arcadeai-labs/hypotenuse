import { loadFromEnvIfSet } from "keryx";
export const configTasks = {
  enabled: await loadFromEnvIfSet("TASKS_ENABLED", true),
  // What queues should the taskProcessors work?
  // Order controls worker priority: workers drain queues left-to-right.
  // e.g. ["worker", "scheduler"] means "worker" jobs are processed before "scheduler" jobs.
  // Use ["*"] to process all queues with equal priority.
  //
  // `ingress` and `outbox` come before `agents` on purpose: a person's message
  // must reach a conversation's inbox, and a finished answer must leave for its
  // platform, ahead of another tick on some other conversation. Ticks are the
  // long work, so they wait. `orchestrator` holds the clocks and sweeps.
  queues: [
    "ingress",
    "outbox",
    "agents",
    "sandboxes",
    "orchestrator",
    "default",
  ] as string[] | (() => Promise<string[]>),
  // Or, rather than providing a static list of `queues`, you can define a method that returns the list of queues.
  // queues: async () => { return ["queueA", "queueB"]; } as string[] | (() => Promise<string[]>)>,
  // how long to sleep between jobs / scheduler checks
  timeout: await loadFromEnvIfSet("TASK_TIMEOUT", 5000),
  // how many parallel workers we run?
  taskProcessors: await loadFromEnvIfSet(
    "TASK_PROCESSORS",
    Bun.env.NODE_ENV === "test" ? 0 : 1,
  ),
  // how often should we check the event loop to spawn more taskProcessors?
  checkTimeout: 500,
  // how many ms would constitute an event loop delay to halt taskProcessors spawning?
  maxEventLoopDelay: 5,
  // how long before we mark a resque worker / task processor as stuck/dead?
  stuckWorkerTimeout: 1000 * 60 * 60,
  // should the scheduler automatically try to retry failed tasks which were failed due to being 'stuck'?
  retryStuckJobs: false,
};
