/**
 * `hypotenuse project` — the caller's projects (`project:*`), and which one
 * later commands act on.
 */
import type { Command } from "commander";
import {
  type ProjectSummary,
  resolveOrganizationId,
  resolveProjectId,
} from "../api/resolve";
import {
  type CliContext,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseDuration, parseNumber } from "../input";
import { table } from "../output/theme";

/** `project:view`'s answer. */
interface ProjectView {
  project: ProjectSummary;
  organization: { id: number; name: string; slug: string };
  callerTags: { id: number; name: string }[];
  standing: { isAdmin: boolean; viaOrganizationOwner: boolean };
}

/** The egress modes a project's sandbox jobs may run under. */
export const SANDBOX_EGRESS_MODES = ["open-world", "allowlist"] as const;

/** `project:settings-view` and `project:settings-edit`'s settings. */
export interface ProjectSettings {
  projectId: number;
  sandboxProvider: string | null;
  sandboxConfig: {
    image?: string;
    runtime?: string;
    vcpus?: number;
    egressMode?: string;
  } | null;
  sandboxConcurrency: number | null;
  sandboxMaxDurationMs: number | null;
  effectiveSandbox: {
    provider: string;
    image: string | null;
    /** The stock runtime, for a provider that boots runtimes; else null. */
    runtime?: string | null;
    /** vCPUs per sandbox, for a provider that sizes them; else null. */
    vcpus?: number | null;
    /** Memory per sandbox, paired with its vCPUs; else null. */
    memoryMiB?: number | null;
    egressMode?: string;
    concurrency: number;
    maxDurationMs: number;
  };
  updatedAt: number;
}

/** A sandbox provider as `project:settings-view` describes it. */
export interface SandboxProviderInfo {
  kind: string;
  label: string;
  allowedHere: boolean;
  connectionKind: string | null;
  options: {
    image: boolean;
    runtimes: { values: string[]; default: string } | null;
    vcpus: { min: number; max: number; default: number } | null;
  };
}

/** `project:settings-view`'s answer. */
export interface ProjectSettingsView {
  settings: ProjectSettings;
  providers?: SandboxProviderInfo[];
}

/** `project:settings-edit`'s answer. */
export interface ProjectSettingsEdited {
  settings: ProjectSettings;
  /** What the change leaves broken, e.g. a bot whose jobs will be refused. */
  warnings?: string[];
}

/** `project settings`'s flags, as commander parses them; `false` is a `--no-*`. */
export interface ProjectSettingsFlags {
  sandboxProvider?: string | false;
  sandboxImage?: string | false;
  sandboxRuntime?: string | false;
  sandboxVcpus?: string | false;
  sandboxEgress?: string | false;
  sandboxConcurrency?: string | false;
  sandboxMaxDuration?: string | false;
}

/**
 * Turn `project settings`'s flags into a `project:settings-edit` body: only
 * the fields given, and null for a `--no-*` (the deployment's default).
 * @param flags - What commander parsed.
 * @returns The body's fields; empty when only viewing.
 * @throws {Error} For a bad number, duration, or egress mode.
 */
export function projectSettingsBody(
  flags: ProjectSettingsFlags,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (flags.sandboxProvider !== undefined) {
    body.sandboxProvider = flags.sandboxProvider || null;
  }
  if (flags.sandboxImage !== undefined) {
    body.sandboxImage = flags.sandboxImage || null;
  }
  if (flags.sandboxRuntime !== undefined) {
    body.sandboxRuntime = flags.sandboxRuntime || null;
  }
  if (flags.sandboxVcpus !== undefined) {
    body.sandboxVcpus =
      flags.sandboxVcpus === false
        ? null
        : parseNumber(flags.sandboxVcpus, "--sandbox-vcpus");
  }
  if (flags.sandboxEgress !== undefined) {
    if (
      flags.sandboxEgress !== false &&
      !(SANDBOX_EGRESS_MODES as readonly string[]).includes(flags.sandboxEgress)
    ) {
      throw new Error(
        `--sandbox-egress takes one of ${SANDBOX_EGRESS_MODES.join(", ")}; got "${flags.sandboxEgress}".`,
      );
    }
    body.sandboxEgressMode = flags.sandboxEgress || null;
  }
  if (flags.sandboxConcurrency !== undefined) {
    body.sandboxConcurrency =
      flags.sandboxConcurrency === false
        ? null
        : parseNumber(flags.sandboxConcurrency, "--sandbox-concurrency");
  }
  if (flags.sandboxMaxDuration !== undefined) {
    body.sandboxMaxDurationMs =
      flags.sandboxMaxDuration === false
        ? null
        : parseDuration(flags.sandboxMaxDuration, "--sandbox-max-duration") *
          1000;
  }
  return body;
}

/**
 * A duration in milliseconds as a person reads it.
 * @param ms - The duration.
 * @returns e.g. `2h`, `45m`, `90s`.
 */
function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * Render a project's settings for a person: what is in effect, and whether it
 * is the project's own choice or the deployment's default. A provider that
 * boots stock runtimes shows its runtime and size; one that boots images
 * shows its image.
 * @param s - The settings.
 * @param warnings - What the server said the change leaves broken.
 * @param providers - The providers this deployment knows, when viewing.
 * @returns The lines.
 */
export function projectSettingsText(
  s: ProjectSettings,
  warnings: readonly string[] = [],
  providers: readonly SandboxProviderInfo[] = [],
): string {
  const own = (chosen: unknown) => (chosen == null ? " (default)" : "");
  const e = s.effectiveSandbox;
  const c = s.sandboxConfig ?? {};
  const lines = [
    `sandbox jobs for project ${s.projectId}`,
    `provider      ${e.provider}${own(s.sandboxProvider)}`,
  ];
  if (e.runtime != null) {
    lines.push(`runtime       ${e.runtime}${own(c.runtime)}`);
  } else {
    lines.push(
      `image         ${e.image ?? "the provider's own"}${own(c.image)}`,
    );
  }
  if (e.vcpus != null) {
    const memory =
      e.memoryMiB != null ? `, ${memoryText(e.memoryMiB)} memory` : "";
    lines.push(`size          ${e.vcpus} vCPUs${memory}${own(c.vcpus)}`);
  }
  if (e.egressMode !== undefined) {
    lines.push(
      `egress        ${e.egressMode === "allowlist" ? "allowlist (deny by default)" : "open-world"}${own(c.egressMode)}`,
    );
  }
  lines.push(
    `at once       ${e.concurrency}${own(s.sandboxConcurrency)}`,
    `longest       ${durationText(e.maxDurationMs)}${own(s.sandboxMaxDurationMs)}`,
  );
  if (providers.length > 0) {
    const named = providers.map((p) => {
      const notes = [
        p.allowedHere ? null : "not allowed here",
        p.connectionKind
          ? `needs a ${p.connectionKind} connection: hypotenuse connection create --kind ${p.connectionKind}`
          : null,
      ].filter(Boolean);
      return notes.length ? `${p.kind} (${notes.join("; ")})` : p.kind;
    });
    lines.push(`providers     ${named.join(", ")}`);
  }
  for (const w of warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

/**
 * A size in MiB as a person reads it.
 * @param mib - The size.
 * @returns e.g. `8 GiB`, `512 MiB`.
 */
function memoryText(mib: number): string {
  return mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

/**
 * The project a subcommand names, else the selected one.
 * @param ctx - The context.
 * @param selector - An id or slug, if the person gave one.
 * @returns The project id.
 */
async function targetProject(
  ctx: CliContext,
  selector?: string,
): Promise<number> {
  return selector
    ? resolveProjectId(ctx.signedInClient(), selector)
    : ctx.projectId();
}

/**
 * Render projects as a table.
 * @param projects - The projects.
 * @param selected - The id `project use` selected, marked in the table.
 * @returns The table.
 */
function projectTable(
  projects: ProjectSummary[],
  selected?: number | null,
): string {
  return table(
    projects.map((p) => ({
      " ": p.id === selected ? "*" : "",
      id: p.id,
      slug: p.slug,
      name: p.name,
      org: p.organizationId,
      standing: p.standing?.isAdmin ? "admin" : "member",
      created: when(p.createdAt),
    })),
    [
      { key: " " },
      { key: "id" },
      { key: "slug" },
      { key: "name", maxWidth: 40 },
      { key: "org" },
      { key: "standing" },
      { key: "created" },
    ],
  );
}

/** `project:overview`'s answer, as far as the table reads it. */
interface Overview {
  bots: {
    slug: string;
    counts: {
      working: number;
      hibernating: number;
      waitingTotal: number;
      endedToday: number;
    };
    needsPerson: number;
    spendToday: { usd: number; unpricedRecords: number };
  }[];
  inbox: { approval: number; help: number; "sandbox-question": number };
}

/**
 * Register `project list|view|use|create|edit|settings|delete`.
 * @param program - The root program.
 */
export function registerProjectCommands(program: Command): void {
  const project = program
    .command("project")
    .description("Your projects, and which one commands act on");

  withPaging(
    project
      .command("list")
      .description(
        "List the projects you can see (only one organization's with --org)",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      // Only an explicit --org narrows the list; a saved `org use` does not
      // hide projects a person can see.
      const organizationId = ctx.options.org
        ? await resolveOrganizationId(client, ctx.options.org)
        : undefined;
      const result = await client.request<
        Paginated<"projects", ProjectSummary>
      >("GET", "/projects", {
        query: { organizationId, ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          projectTable(result.projects, ctx.entry.project) +
          pageFooter(result.pagination),
      );
    });
  });

  project
    .command("view")
    .description("Show a project and your standing in it")
    .argument("[project]", "id or slug (default: the selected project)")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await targetProject(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<ProjectView>("GET", `/project/${projectId}`);
        emit(ctx, result, () =>
          [
            `${result.project.name} (${result.project.slug}, id ${result.project.id})`,
            `organization  ${result.organization.name} (${result.organization.slug})`,
            `standing      ${result.standing.isAdmin ? "admin" : "member"}${result.standing.viaOrganizationOwner ? " (organization owner)" : ""}`,
            `tags          ${result.callerTags.map((t) => t.name).join(", ") || "-"}`,
            `created       ${when(result.project.createdAt)}`,
          ].join("\n"),
        );
      });
    });

  project
    .command("overview")
    .description(
      "What the project's bots are doing now: conversations by state, today's spend, and what waits on a person",
    )
    .argument("[project]", "id or slug (default: the selected project)")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await targetProject(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<{ overview: Overview }>(
            "GET",
            `/project/${projectId}/overview`,
          );
        const o = result.overview;
        emit(
          ctx,
          result,
          () =>
            `${table(
              o.bots.map((b) => ({
                bot: b.slug,
                working: b.counts.working,
                waiting: b.counts.waitingTotal,
                resting: b.counts.hibernating,
                ended: b.counts.endedToday,
                inbox: b.needsPerson,
                spend: `$${b.spendToday.usd.toFixed(2)}${b.spendToday.unpricedRecords ? "+" : ""}`,
              })),
              [
                { key: "bot" },
                { key: "working" },
                { key: "waiting" },
                { key: "resting", header: "HIBERNATING" },
                { key: "ended", header: "ENDED TODAY" },
                { key: "inbox", header: "NEEDS A PERSON" },
                { key: "spend", header: "SPEND TODAY" },
              ],
            )}\ninbox: ${o.inbox.approval} approvals, ${o.inbox.help} help requests, ${o.inbox["sandbox-question"]} sandbox questions`,
        );
      });
    });

  project
    .command("use")
    .description("Select the project later commands act on")
    .argument("<project>", "id or slug")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        // Proves membership before saving, so `use` never selects a project
        // every later command would be refused.
        const { project: selected } = await client.request<ProjectView>(
          "GET",
          `/project/${projectId}`,
        );
        ctx.entry.project = selected.id;
        ctx.save();
        emit(
          ctx,
          { project: selected },
          () => `Using ${selected.name} (${selected.slug}, id ${selected.id})`,
        );
      });
    });

  project
    .command("create")
    .description(
      "Create a project in the selected organization; you become its admin",
    )
    .requiredOption("--name <name>", "the project's display name")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const organizationId = await ctx.organizationId();
        const result = await ctx
          .signedInClient()
          .request<{ project: ProjectSummary }>("PUT", "/project", {
            body: { organizationId, name },
          });
        emit(
          ctx,
          result,
          () =>
            `Created ${result.project.name} (${result.project.slug}, id ${result.project.id})`,
        );
      });
    });

  project
    .command("edit")
    .description("Rename a project (admin)")
    .argument("[project]", "id or slug (default: the selected project)")
    .requiredOption("--name <name>", "the new display name")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        const { name } = this.opts() as { name: string };
        const projectId = await targetProject(ctx, selector);
        const result = await ctx
          .signedInClient()
          .request<{ project: ProjectSummary }>(
            "POST",
            `/project/${projectId}`,
            { body: { name } },
          );
        emit(
          ctx,
          result,
          () => `Renamed project ${projectId} to ${result.project.name}`,
        );
      });
    });

  project
    .command("settings")
    .description(
      "Show a project's sandbox settings, or change them with flags (admin to change)",
    )
    .argument("[project]", "id or slug (default: the selected project)")
    .option(
      "--sandbox-provider <name>",
      "where sandbox jobs run, e.g. docker (development only)",
    )
    .option("--no-sandbox-provider", "the deployment's default provider")
    .option("--sandbox-image <image>", "the image a job's sandbox runs")
    .option("--no-sandbox-image", "the provider's own image")
    .option(
      "--sandbox-runtime <runtime>",
      "the stock runtime a job's sandbox boots, for a provider that boots runtimes (vercel: node24 or node22)",
    )
    .option("--no-sandbox-runtime", "the provider's default runtime")
    .option(
      "--sandbox-vcpus <n>",
      "vCPUs per sandbox, for a provider that sizes them (vercel: 1-8, 2 GiB each)",
    )
    .option("--no-sandbox-vcpus", "the provider's default size")
    .option(
      "--sandbox-egress <mode>",
      `how a job's network is held: ${SANDBOX_EGRESS_MODES.join(", ")} (allowlist needs a provider that can enforce one)`,
    )
    .option("--no-sandbox-egress", "the default, open-world")
    .option("--sandbox-concurrency <n>", "how many jobs may run at once (1-50)")
    .option("--no-sandbox-concurrency", "the deployment's default concurrency")
    .option(
      "--sandbox-max-duration <duration>",
      "the longest one job may run: seconds, or 30m, 2h; only lower than the deployment's",
    )
    .option("--no-sandbox-max-duration", "the deployment's ceiling")
    .action(async function (this: Command, selector?: string) {
      await runCommand(this, async (ctx) => {
        // Each `--no-*` follows its value flag, so commander leaves an
        // absent pair undefined: no flags at all means view.
        const body = projectSettingsBody(this.opts() as ProjectSettingsFlags);
        const projectId = await targetProject(ctx, selector);
        const client = ctx.signedInClient();
        const result: ProjectSettingsEdited & ProjectSettingsView =
          Object.keys(body).length === 0
            ? await client.request<ProjectSettingsView>(
                "GET",
                `/project/${projectId}/settings`,
              )
            : await client.request<ProjectSettingsEdited>(
                "POST",
                `/project/${projectId}/settings`,
                { body },
              );
        emit(ctx, result, () =>
          projectSettingsText(
            result.settings,
            result.warnings,
            result.providers,
          ),
        );
      });
    });

  project
    .command("delete")
    .description("Delete a project and everything in it (admin)")
    .argument("<project>", "id or slug")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(
          this,
          `Deleting a project cannot be undone. Re-run with --yes to delete ${selector}.`,
        );
        const client = ctx.signedInClient();
        const projectId = await resolveProjectId(client, selector);
        const result = await client.request("DELETE", `/project/${projectId}`);
        if (ctx.entry.project === projectId) {
          ctx.entry.project = null;
          ctx.save();
        }
        emit(ctx, result, () => `Deleted project ${selector}`);
      });
    });
}
