import { describe, expect, test } from "bun:test";
import { config } from "keryx";
import { sweepOrphans } from "../../ops/SandboxReapOps";
import type {
  CreateSandboxOptions,
  EgressPolicy,
  ExecEvent,
  Sandbox,
  SandboxProvider,
} from "../../sandbox/types";
import { SandboxNotFoundError } from "../../sandbox/types";

/**
 * **The provider-conformance suite**: one contract every sandbox provider
 * passes, so "works on Docker" means "works". Each case is named after the
 * `SandboxProvider` or `Sandbox` method it proves. A provider file runs it
 * with a {@link ConformanceTarget}: Docker in CI, the Vercel provider against
 * the in-process Vercel fake in CI, and the Vercel provider against a real
 * account nightly.
 *
 * The suite talks to providers only through the interface, and branches on
 * `capabilities`, never on a name — the same rule the rest of the code keeps.
 */

/** How a provider file plugs into the suite. */
export interface ConformanceTarget {
  /** The provider's name, for the describe block. */
  name: string;
  /** Whether it can run here; a target that cannot is skipped, said aloud. */
  enabled: boolean;
  /** How long one case may take. */
  timeoutMs: number;
  /**
   * A fresh provider instance. Called more than once on purpose: `attach`
   * and `connect` are proved from an instance that never saw the create.
   */
  provider(): SandboxProvider;
  /** What every sandbox in the suite is created with (an image, a runtime). */
  createOptions(): Partial<CreateSandboxOptions>;
  /**
   * The project whose account the orphan sweep reads, for a provider on
   * per-project accounts; `null` for one on the deployment's own.
   */
  sweepProjectId(): number | null;
  /**
   * Prove a sandbox is held to a policy, where the target can: a fake reads
   * back what it recorded, a real account tries the network. Absent where
   * nothing can be observed.
   */
  assertEgress?(sandbox: Sandbox, policy: EgressPolicy): Promise<void>;
}

/** Labels that mark the suite's sandboxes, apart from anyone else's. */
const SUITE_LABEL = { suite: "conformance" };

/**
 * Collect a handle's events until it exits.
 * @param events - The stream.
 * @returns Its stdout, stderr, and exit code.
 */
async function drain(events: AsyncIterable<ExecEvent>) {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  for await (const e of events) {
    if (e.type === "stdout") stdout += e.data;
    if (e.type === "stderr") stderr += e.data;
    if (e.type === "exit") exitCode = e.exitCode;
  }
  return { stdout, stderr, exitCode };
}

/**
 * Register the suite for one provider.
 * @param target - The provider and how to reach it.
 */
export function describeProviderConformance(target: ConformanceTarget): void {
  const run = target.enabled ? describe : describe.skip;
  const t = target.timeoutMs;
  const created: Sandbox[] = [];

  /**
   * Create a sandbox the suite cleans up.
   * @param extra - More labels.
   * @returns The sandbox.
   */
  const create = async (extra: Record<string, string> = {}) => {
    const sandbox = await target.provider().create({
      timeoutMs: 15 * 60 * 1000,
      ...target.createOptions(),
      labels: { ...SUITE_LABEL, ...extra },
    });
    created.push(sandbox);
    return sandbox;
  };

  run(`provider conformance: ${target.name}`, () => {
    let sandbox: Sandbox;

    test(
      "create: a live sandbox with a writable /work",
      async () => {
        sandbox = await create({ case: "main" });
        expect(sandbox.id).toBeTruthy();
        const work = await sandbox.exec("/bin/sh", [
          "-c",
          "test -d /work && test -w /work && echo ok",
        ]);
        expect(work.stdout.trim()).toBe("ok");
      },
      t,
    );

    test(
      "list: answers our sandbox with its labels, narrows by label, and nothing of anyone else's",
      async () => {
        const provider = target.provider();
        const all = await provider.list();
        const mine = all.find((l) => l.id === sandbox.id);
        expect(mine).toBeDefined();
        expect(mine?.labels?.suite).toBe("conformance");
        expect(mine?.labels?.case).toBe("main");
        const narrowed = await provider.list({ case: "main" });
        expect(narrowed.map((l) => l.id)).toContain(sandbox.id);
        expect(await provider.list({ case: "no-such-case" })).toEqual([]);
      },
      t,
    );

    test(
      "connect: finds a sandbox by id from another instance; an unknown id is SandboxNotFoundError",
      async () => {
        const again = await target.provider().connect(sandbox.id);
        expect(again.id).toBe(sandbox.id);
        const r = await again.exec("/bin/sh", ["-c", "echo connected"]);
        expect(r.stdout.trim()).toBe("connected");
        await expect(
          target.provider().connect("hypotenuse-no-such-sandbox"),
        ).rejects.toBeInstanceOf(SandboxNotFoundError);
      },
      t,
    );

    test(
      "writeFiles: nested paths, contents, and modes",
      async () => {
        await sandbox.writeFiles([
          {
            path: "/work/conf/deep/run.sh",
            content: "#!/bin/sh\necho ran-$1\n",
            mode: 0o755,
          },
          { path: "/work/conf/plain.txt", content: "plain" },
          {
            path: "/work/conf/bytes.bin",
            content: Buffer.from([0, 1, 2, 250, 255]),
          },
        ]);
        const r = await sandbox.exec("/work/conf/deep/run.sh", ["x"]);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe("ran-x");
        const mode = await sandbox.exec("/bin/sh", [
          "-c",
          "stat -c %a /work/conf/deep/run.sh",
        ]);
        expect(mode.stdout.trim()).toBe("755");
      },
      t,
    );

    test(
      "readFile: bytes back exactly; a missing file is null",
      async () => {
        expect(
          (await sandbox.readFile("/work/conf/plain.txt"))?.toString(),
        ).toBe("plain");
        expect([
          ...((await sandbox.readFile("/work/conf/bytes.bin")) ?? []),
        ]).toEqual([0, 1, 2, 250, 255]);
        expect(await sandbox.readFile("/work/conf/missing")).toBeNull();
      },
      t,
    );

    test(
      "mkdir: creates parents",
      async () => {
        await sandbox.mkdir("/work/a/b/c");
        const r = await sandbox.exec("/bin/sh", ["-c", "test -d /work/a/b/c"]);
        expect(r.exitCode).toBe(0);
      },
      t,
    );

    test(
      "exec: exit code, both streams, cwd, env, and sudo",
      async () => {
        const r = await sandbox.exec(
          "/bin/sh",
          ["-c", 'echo "out:$PWD:$CONF_VAR"; echo err >&2; exit 3'],
          { cwd: "/work/conf", env: { CONF_VAR: "v1" } },
        );
        expect(r.exitCode).toBe(3);
        expect(r.stdout.trim()).toBe("out:/work/conf:v1");
        expect(r.stderr.trim()).toBe("err");
        const root = await sandbox.exec("id", ["-u"], { sudo: true });
        expect(root.stdout.trim()).toBe("0");
      },
      t,
    );

    test(
      "spawn: events stream both outputs and the exit; wait answers the exit code",
      async () => {
        const handle = await sandbox.spawn("/bin/sh", [
          "-c",
          "echo one; sleep 1; echo two >&2; exit 4",
        ]);
        expect(handle.id).toBeTruthy();
        const seen = await drain(handle.events());
        expect(seen.stdout).toContain("one");
        expect(seen.stderr).toContain("two");
        expect(seen.exitCode).toBe(4);
        expect((await handle.wait()).exitCode).toBe(4);
      },
      t,
    );

    test(
      "kill: stops a running command",
      async () => {
        const handle = await sandbox.spawn("/bin/sh", ["-c", "sleep 120"]);
        await Bun.sleep(1_000);
        await handle.kill("SIGKILL");
        const { exitCode } = await handle.wait();
        expect(exitCode).not.toBe(0);
      },
      t,
    );

    test(
      "attach: a dropped handle is found again by id, from another instance, output replayed",
      async () => {
        const handle = await sandbox.spawn("/bin/sh", [
          "-c",
          "echo before; sleep 2; echo after",
        ]);
        const id = handle.id;
        // The handle is dropped: a worker restart. A new instance reconnects.
        const again = await (
          await target.provider().connect(sandbox.id)
        ).attach(id);
        expect(again.id).toBe(id);
        const seen = await drain(again.events());
        expect(seen.stdout).toContain("before");
        expect(seen.stdout).toContain("after");
        expect(seen.exitCode).toBe(0);
      },
      t,
    );

    test(
      "setEgress: honoured where the provider can hold a list; refused where it cannot",
      async () => {
        const policy: EgressPolicy = {
          mode: "deny-all",
          allowDomains: ["example.org"],
        };
        const provider = target.provider();
        if (provider.capabilities.domainEgressAllowlist) {
          await sandbox.setEgress(policy);
          await target.assertEgress?.(sandbox, policy);
          await sandbox.setEgress({ mode: "allow-all" });
        } else {
          await expect(sandbox.setEgress(policy)).rejects.toThrow(
            /cannot enforce/,
          );
          // Allow-all is always honoured.
          await sandbox.setEgress({ mode: "allow-all" });
        }
      },
      t,
    );

    test(
      "extendTimeout: pushes the deadline out without disturbing the sandbox",
      async () => {
        await sandbox.extendTimeout(30 * 60 * 1000);
        const r = await sandbox.exec("/bin/sh", ["-c", "echo alive"]);
        expect(r.stdout.trim()).toBe("alive");
      },
      t,
    );

    test(
      "destroy: idempotent, and the sandbox is gone",
      async () => {
        await sandbox.destroy();
        await sandbox.destroy();
        const listed = await target.provider().list({ case: "main" });
        expect(listed.map((l) => l.id)).not.toContain(sandbox.id);
      },
      t,
    );

    test(
      "orphan sweep: a sandbox of ours the ledger never heard of is collected",
      async () => {
        const projectId = target.sweepProjectId();
        const orphan = await create({
          case: "orphan",
          ...(projectId !== null ? { project: String(projectId) } : {}),
        });
        const grace = config.sandbox.orphanGraceMs;
        config.sandbox.orphanGraceMs = 0;
        try {
          const swept = await sweepOrphans();
          expect(swept.provider).toBeGreaterThanOrEqual(1);
        } finally {
          config.sandbox.orphanGraceMs = grace;
        }
        const listed = await target.provider().list({ case: "orphan" });
        expect(listed.map((l) => l.id)).not.toContain(orphan.id);
      },
      t,
    );

    test(
      "cleanup",
      async () => {
        for (const s of created) await s.destroy().catch(() => {});
      },
      t,
    );
  });
}
