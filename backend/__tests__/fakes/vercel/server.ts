import { randomBytes } from "node:crypto";

/**
 * **The Vercel Sandbox fake**: Vercel's Sandbox API as `@vercel/sandbox`
 * speaks it, in process, over the real wire protocol — JSON requests, the
 * `application/x-ndjson` streams a waited command and its logs come back on,
 * the gzipped tarball `fs/write` takes, and the `application/octet-stream`
 * `fs/read` answers. Every answer is shaped to pass the SDK's own zod
 * validators, so a shape we got wrong fails in the SDK, as it would against
 * Vercel.
 *
 * Each sandbox is a **real container** on the local Docker daemon, so the
 * commands a test runs really run: `exec`, a detached command and its logs,
 * `kill`, files written as a tarball and read back. What the fake cannot do
 * is enforce a network policy — it records each one (with the commands run
 * under it) in {@link FakeVercel.sandboxes}, and the nightly suite against a
 * real account proves enforcement.
 *
 * Auth is Vercel's: `Authorization: Bearer <token>` and `?teamId=` on every
 * request, and a sandbox lives in one Vercel project. A wrong token or team
 * is a 403; a wrong project is a 404.
 *
 * Test controls (never part of Vercel's API, and called in process):
 * {@link FakeVercel.failNext} makes the next request fail with a status and
 * a message; with `echoAuthorization`, the message carries the request's
 * `Authorization` header, as a careless upstream might — the case the
 * provider's token scrubbing exists for.
 */

/** A network policy as Vercel's API carries it on a request. */
type ApiPolicy =
  | { mode: "allow-all" | "deny-all" }
  | {
      allow?: string[] | Record<string, unknown[]>;
      subnets?: { allow?: string[]; deny?: string[] };
    };

/** A command the fake ran, as recorded for assertions. */
export interface FakeCommandRecord {
  id: string;
  command: string;
  args: string[];
  sudo: boolean;
  /** The sandbox's network policy when the command started. */
  policy: ApiPolicy;
}

/** One chunk of a command's output. */
interface Chunk {
  stream: "stdout" | "stderr";
  data: string;
}

/** A command in a fake sandbox. */
interface FakeCommand {
  id: string;
  name: string;
  args: string[];
  cwd: string;
  startedAt: number;
  exitCode: number | null;
  durationMs?: number;
  chunks: Chunk[];
  listeners: Set<() => void>;
  done: Promise<void>;
}

/** A sandbox as the fake keeps it. */
export interface FakeSandbox {
  name: string;
  sessionId: string;
  projectId: string;
  containerId: string;
  runtime: string;
  vcpus: number;
  timeout: number;
  tags: Record<string, string>;
  createdAt: number;
  status: "running" | "stopped";
  /** Every network policy the sandbox has had, oldest first. */
  policies: ApiPolicy[];
  /** Every command it ran, oldest first. */
  commandLog: FakeCommandRecord[];
  commands: Map<string, FakeCommand>;
  env: Record<string, string>;
}

/** Where a fake sandbox's commands start, as Vercel's do. */
const SANDBOX_CWD = "/vercel/sandbox";

/** The label every fake container carries, so a suite can clean up after it. */
export const FAKE_VERCEL_LABEL = "hypotenuse.vercel-fake";

/**
 * Run `docker` and collect its output.
 * @param args - Arguments to `docker`.
 * @param stdin - Bytes to write to its stdin.
 * @returns The exit code and streams.
 */
async function docker(
  args: string[],
  stdin?: Uint8Array,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * A JSON answer.
 * @param body - The body.
 * @param status - The status.
 * @returns The response.
 */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * An error in Vercel's shape, which the SDK reads into `APIError.message`.
 * @param status - The status.
 * @param code - Vercel's error code.
 * @param message - What went wrong.
 * @returns The response.
 */
function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** The fake. */
export class FakeVercel {
  /** The base URL to put in `SANDBOX_VERCEL_API_URL`. */
  url = "";
  /** The token every request must carry. */
  readonly token = `vcp_${randomBytes(12).toString("hex")}`;
  /** The team every request must name. */
  readonly teamId = `team_${randomBytes(6).toString("hex")}`;
  /** The Vercel project sandboxes are created in. */
  readonly projectId = `prj_${randomBytes(6).toString("hex")}`;
  /** Every sandbox ever created, deleted ones included, by name. */
  readonly sandboxes = new Map<string, FakeSandbox>();
  /** Names of deleted sandboxes. */
  readonly deleted = new Set<string>();
  /** The image each sandbox's container runs. */
  image: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private failure: {
    status: number;
    message: string;
    echoAuthorization: boolean;
  } | null = null;

  /** @param image - The image a sandbox's container runs. */
  constructor(image: string) {
    this.image = image;
  }

  /**
   * Start serving on a free loopback port.
   * @returns This fake.
   */
  async start(): Promise<this> {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    this.url = `http://127.0.0.1:${this.server.port}/api`;
    return this;
  }

  /** Stop serving and remove every container. */
  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = null;
    await this.removeContainers();
  }

  /** Remove every container any fake started. */
  async removeContainers(): Promise<void> {
    const listed = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=${FAKE_VERCEL_LABEL}=true`,
    ]);
    const ids = listed.stdout.split("\n").filter(Boolean);
    if (ids.length > 0) await docker(["rm", "-f", ...ids]);
  }

  /**
   * Make the next request fail (a test control).
   * @param status - The status to answer.
   * @param message - The error's message.
   * @param echoAuthorization - Append the request's `Authorization` header.
   */
  failNext(status: number, message: string, echoAuthorization = false): void {
    this.failure = { status, message, echoAuthorization };
  }

  /**
   * A sandbox by name, or the only one.
   * @param name - Its name; omitted for the single live one.
   * @returns The sandbox.
   */
  sandbox(name?: string): FakeSandbox {
    if (name) {
      const found = this.sandboxes.get(name);
      if (!found) throw new Error(`no fake sandbox ${name}`);
      return found;
    }
    const live = [...this.sandboxes.values()].filter(
      (s) => !this.deleted.has(s.name),
    );
    if (live.length !== 1) {
      throw new Error(`expected one live fake sandbox, found ${live.length}`);
    }
    return live[0];
  }

  /**
   * Route one request.
   * @param req - The request.
   * @returns The answer.
   */
  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    if (this.failure) {
      const { status, message, echoAuthorization } = this.failure;
      this.failure = null;
      return apiError(
        status,
        "forced",
        echoAuthorization ? `${message} (${auth})` : message,
      );
    }
    if (auth !== `Bearer ${this.token}`) {
      return apiError(403, "forbidden", "Not authorized");
    }
    if (url.searchParams.get("teamId") !== this.teamId) {
      return apiError(403, "forbidden", "You don't have access to this team");
    }
    const path = url.pathname.replace(/^\/api/, "");
    const m = (re: RegExp) => path.match(re);
    try {
      let match: RegExpMatchArray | null;
      if (req.method === "POST" && m(/^\/v[23]\/sandboxes$/)) {
        return await this.create(
          (await req.json()) as Parameters<FakeVercel["create"]>[0],
        );
      }
      if (req.method === "GET" && m(/^\/v2\/sandboxes$/)) {
        return this.list(url);
      }
      match = m(/^\/v2\/sandboxes\/sessions\/([^/]+)\/(.+)$/);
      if (match) {
        const sandbox = [...this.sandboxes.values()].find(
          (s) => s.sessionId === match?.[1] && !this.deleted.has(s.name),
        );
        if (!sandbox) {
          return apiError(404, "not_found", "Session not found");
        }
        return await this.session(sandbox, match[2], req, url);
      }
      match = m(/^\/v2\/sandboxes\/([^/]+)$/);
      if (match) {
        const name = decodeURIComponent(match[1]);
        const sandbox = this.sandboxes.get(name);
        const projectId =
          url.searchParams.get("projectId") ?? url.searchParams.get("project");
        if (
          !sandbox ||
          this.deleted.has(name) ||
          (projectId && projectId !== sandbox.projectId)
        ) {
          return apiError(404, "not_found", `Sandbox ${name} not found`);
        }
        if (req.method === "GET") {
          return json({
            sandbox: this.sandboxBody(sandbox),
            session: this.sessionBody(sandbox),
            routes: [],
          });
        }
        if (req.method === "DELETE") {
          this.deleted.add(name);
          await docker(["rm", "-f", sandbox.containerId]);
          return json({ sandbox: this.sandboxBody(sandbox) });
        }
      }
      return apiError(404, "not_found", `No route ${req.method} ${path}`);
    } catch (e) {
      return apiError(
        500,
        "internal",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * `POST /v2/sandboxes` (a runtime) or `/v3/sandboxes` (an image).
   * @param body - The request body.
   * @returns The sandbox and its session.
   */
  private async create(body: {
    projectId?: string;
    runtime?: string;
    image?: string;
    timeout?: number;
    resources?: { vcpus?: number };
    tags?: Record<string, string>;
    env?: Record<string, string>;
    networkPolicy?: ApiPolicy;
  }): Promise<Response> {
    if (body.projectId !== this.projectId) {
      return apiError(404, "not_found", "Project not found");
    }
    if (Object.keys(body.tags ?? {}).length > 5) {
      return apiError(400, "bad_request", "At most 5 tags");
    }
    const name = `sbx_${randomBytes(6).toString("hex")}`;
    const args = [
      "run",
      "-d",
      "--label",
      `${FAKE_VERCEL_LABEL}=true`,
      "--network",
      "host",
    ];
    for (const [key, value] of Object.entries(body.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      "--entrypoint",
      "/bin/sh",
      this.image,
      "-c",
      "while true; do sleep 1; done",
    );
    const run = await docker(args);
    if (run.exitCode !== 0) {
      return apiError(500, "internal", run.stderr.trim());
    }
    const containerId = run.stdout.trim();
    // Vercel's sandbox user owns its working directory; so does the
    // image's default user here.
    const owner = (
      await docker([
        "exec",
        containerId,
        "/bin/sh",
        "-c",
        'echo "$(id -u):$(id -g)"',
      ])
    ).stdout.trim();
    await docker([
      "exec",
      "-u",
      "0",
      containerId,
      "/bin/sh",
      "-c",
      `mkdir -p ${SANDBOX_CWD} && chown ${owner} ${SANDBOX_CWD}`,
    ]);
    const sandbox: FakeSandbox = {
      name,
      sessionId: `sess_${randomBytes(6).toString("hex")}`,
      projectId: body.projectId,
      containerId,
      runtime: body.runtime ?? body.image ?? "node24",
      vcpus: body.resources?.vcpus ?? 2,
      timeout: body.timeout ?? 5 * 60 * 1000,
      tags: body.tags ?? {},
      createdAt: Date.now(),
      status: "running",
      policies: [body.networkPolicy ?? { mode: "allow-all" }],
      commandLog: [],
      commands: new Map(),
      env: body.env ?? {},
    };
    this.sandboxes.set(name, sandbox);
    return json({
      sandbox: this.sandboxBody(sandbox),
      session: this.sessionBody(sandbox),
      routes: [],
    });
  }

  /**
   * `GET /v2/sandboxes`, filtered by project and one `key:value` tag.
   * @param url - The request URL.
   * @returns A page with every match.
   */
  private list(url: URL): Response {
    const project = url.searchParams.get("project");
    const tags = url.searchParams.getAll("tags");
    const found = [...this.sandboxes.values()].filter((s) => {
      if (this.deleted.has(s.name)) return false;
      if (project && s.projectId !== project) return false;
      return tags.every((t) => {
        const i = t.indexOf(":");
        return s.tags[t.slice(0, i)] === t.slice(i + 1);
      });
    });
    return json({
      sandboxes: found.map((s) => this.sandboxBody(s)),
      pagination: { count: found.length, next: null },
    });
  }

  /**
   * Everything under `/v2/sandboxes/sessions/:id/`.
   * @param sandbox - The session's sandbox.
   * @param rest - The path after the session id.
   * @param req - The request.
   * @param url - Its URL.
   * @returns The answer.
   */
  private async session(
    sandbox: FakeSandbox,
    rest: string,
    req: Request,
    url: URL,
  ): Promise<Response> {
    if (rest === "cmd" && req.method === "POST") {
      const body = (await req.json()) as {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        sudo?: boolean;
        wait?: boolean;
      };
      const command = this.run(sandbox, body);
      if (!body.wait)
        return json({ command: this.commandBody(sandbox, command) });
      return this.ndjson(sandbox, command, true);
    }
    let match = rest.match(/^cmd\/([^/]+)$/);
    if (match && req.method === "GET") {
      const command = sandbox.commands.get(match[1]);
      if (!command) return apiError(404, "not_found", "Command not found");
      if (url.searchParams.get("wait") === "true") await command.done;
      return json({ command: this.commandBody(sandbox, command) });
    }
    match = rest.match(/^cmd\/([^/]+)\/logs$/);
    if (match) {
      const command = sandbox.commands.get(match[1]);
      if (!command) return apiError(404, "not_found", "Command not found");
      return this.ndjson(sandbox, command, false);
    }
    match = rest.match(/^cmd\/([^/]+)\/kill$/);
    if (match) {
      const command = sandbox.commands.get(match[1]);
      if (!command) return apiError(404, "not_found", "Command not found");
      const { signal = "SIGTERM" } = (await req.json()) as { signal?: string };
      await docker([
        "exec",
        "-u",
        "0",
        sandbox.containerId,
        "/bin/sh",
        "-c",
        `kill -${String(signal).replace(/^SIG/, "")} "$(cat /tmp/.vfake/${command.id}.pid)" 2>/dev/null || true`,
      ]);
      return json({ command: this.commandBody(sandbox, command) });
    }
    if (rest === "fs/mkdir") {
      const { path } = (await req.json()) as { path: string };
      const r = await docker([
        "exec",
        sandbox.containerId,
        "mkdir",
        "-p",
        path,
      ]);
      if (r.exitCode !== 0) return apiError(400, "bad_request", r.stderr);
      return json({});
    }
    if (rest === "fs/write") {
      const dir = req.headers.get("x-cwd") || "/";
      const bytes = new Uint8Array(await req.arrayBuffer());
      const r = await docker(
        [
          "exec",
          "-i",
          sandbox.containerId,
          "tar",
          "-xzf",
          "-",
          "-C",
          dir,
          "--no-same-owner",
        ],
        bytes,
      );
      if (r.exitCode !== 0) return apiError(400, "bad_request", r.stderr);
      return json({});
    }
    if (rest === "fs/read") {
      const { path } = (await req.json()) as { path: string };
      const r = await docker([
        "exec",
        sandbox.containerId,
        "/bin/sh",
        "-c",
        `[ -f '${path.replaceAll("'", "'\\''")}' ] && base64 < '${path.replaceAll("'", "'\\''")}' || exit 66`,
      ]);
      if (r.exitCode === 66)
        return apiError(404, "not_found", "File not found");
      if (r.exitCode !== 0) return apiError(400, "bad_request", r.stderr);
      return new Response(Buffer.from(r.stdout.replace(/\s+/g, ""), "base64"), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (rest === "stop") {
      sandbox.status = "stopped";
      await docker(["stop", "-t", "0", sandbox.containerId]);
      return json({
        session: this.sessionBody(sandbox),
        sandbox: this.sandboxBody(sandbox),
      });
    }
    if (rest === "network-policy") {
      sandbox.policies.push((await req.json()) as ApiPolicy);
      return json({ session: this.sessionBody(sandbox) });
    }
    if (rest === "extend-timeout") {
      const { duration } = (await req.json()) as { duration: number };
      sandbox.timeout += duration;
      return json({ session: this.sessionBody(sandbox) });
    }
    return apiError(404, "not_found", `No route ${req.method} ${rest}`);
  }

  /**
   * Start a command in a sandbox's container, collecting its output.
   * @param sandbox - The sandbox.
   * @param body - The command.
   * @param body.command - The executable.
   * @param body.args - Its arguments.
   * @param body.cwd - Where to run it.
   * @param body.env - Extra environment.
   * @param body.sudo - Run as root.
   * @returns The command.
   */
  private run(
    sandbox: FakeSandbox,
    body: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      sudo?: boolean;
    },
  ): FakeCommand {
    const id = `cmd_${randomBytes(6).toString("hex")}`;
    const args = ["exec", "-w", body.cwd || SANDBOX_CWD];
    if (body.sudo) args.push("-u", "0");
    for (const [key, value] of Object.entries(body.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      sandbox.containerId,
      "/bin/sh",
      "-c",
      `mkdir -p /tmp/.vfake 2>/dev/null; chmod 1777 /tmp/.vfake 2>/dev/null; echo $$ > /tmp/.vfake/${id}.pid; exec "$@"`,
      "sh",
      body.command,
      ...(body.args ?? []),
    );
    const proc = Bun.spawn(["docker", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const command: FakeCommand = {
      id,
      name: body.command,
      args: body.args ?? [],
      cwd: body.cwd || SANDBOX_CWD,
      startedAt: Date.now(),
      exitCode: null,
      chunks: [],
      listeners: new Set(),
      done: Promise.resolve(),
    };
    const notify = () => {
      for (const l of command.listeners) l();
    };
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      name: "stdout" | "stderr",
    ) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        const data = decoder.decode(bytes, { stream: true });
        if (data) {
          command.chunks.push({ stream: name, data });
          notify();
        }
      }
    };
    command.done = (async () => {
      await Promise.all([
        pump(proc.stdout, "stdout"),
        pump(proc.stderr, "stderr"),
      ]);
      command.exitCode = await proc.exited;
      command.durationMs = Date.now() - command.startedAt;
      notify();
    })();
    sandbox.commands.set(id, command);
    sandbox.commandLog.push({
      id,
      command: body.command,
      args: body.args ?? [],
      sudo: body.sudo === true,
      policy: sandbox.policies[sandbox.policies.length - 1],
    });
    return command;
  }

  /**
   * Stream a command as ndjson: for a waited command, its record first and
   * its finished record last; for logs, the output alone. Output is replayed
   * from the beginning, then followed until the command exits.
   * @param sandbox - The sandbox.
   * @param command - The command.
   * @param waited - Whether this is a waited `cmd` call.
   * @returns The streaming response.
   */
  private ndjson(
    sandbox: FakeSandbox,
    command: FakeCommand,
    waited: boolean,
  ): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const line = (value: unknown) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        if (waited) {
          line({
            command: { ...this.commandBody(sandbox, command), exitCode: null },
          });
        }
        let sent = 0;
        const flush = () => {
          while (sent < command.chunks.length) {
            line(command.chunks[sent]);
            sent++;
          }
          if (command.exitCode !== null) {
            command.listeners.delete(flush);
            if (waited) line({ command: this.commandBody(sandbox, command) });
            controller.close();
          }
        };
        command.listeners.add(flush);
        flush();
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  /**
   * A command record as the API answers it.
   * @param sandbox - Its sandbox.
   * @param c - The command.
   * @returns The record.
   */
  private commandBody(sandbox: FakeSandbox, c: FakeCommand) {
    return {
      id: c.id,
      name: c.name,
      args: c.args,
      cwd: c.cwd,
      sessionId: sandbox.sessionId,
      exitCode: c.exitCode,
      ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
      startedAt: c.startedAt,
    };
  }

  /**
   * A policy as the API answers it: a mode, or the older `custom` shape.
   * @param p - The policy as stored.
   * @returns The response form.
   */
  private policyBody(p: ApiPolicy) {
    if ("mode" in p) return { mode: p.mode };
    const allow = Array.isArray(p.allow) ? p.allow : Object.keys(p.allow ?? {});
    return {
      mode: "custom" as const,
      allowedDomains: allow,
      ...(p.subnets?.allow ? { allowedCIDRs: p.subnets.allow } : {}),
      ...(p.subnets?.deny ? { deniedCIDRs: p.subnets.deny } : {}),
    };
  }

  /**
   * A session as the API answers it.
   * @param s - The sandbox.
   * @returns The session record.
   */
  private sessionBody(s: FakeSandbox) {
    return {
      id: s.sessionId,
      memory: s.vcpus * 2048,
      vcpus: s.vcpus,
      region: "iad1",
      runtime: s.runtime,
      timeout: s.timeout,
      status: s.status,
      requestedAt: s.createdAt,
      startedAt: s.createdAt,
      createdAt: s.createdAt,
      cwd: SANDBOX_CWD,
      updatedAt: Date.now(),
      networkPolicy: this.policyBody(s.policies[s.policies.length - 1]),
    };
  }

  /**
   * A sandbox as the API answers it.
   * @param s - The sandbox.
   * @returns The sandbox record.
   */
  private sandboxBody(s: FakeSandbox) {
    return {
      name: s.name,
      persistent: false,
      region: "iad1",
      vcpus: s.vcpus,
      memory: s.vcpus * 2048,
      runtime: s.runtime,
      timeout: s.timeout,
      networkPolicy: this.policyBody(s.policies[s.policies.length - 1]),
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      expiresAt: s.createdAt + s.timeout,
      currentSessionId: s.sessionId,
      status: s.status,
      cwd: SANDBOX_CWD,
      tags: s.tags,
    };
  }
}
