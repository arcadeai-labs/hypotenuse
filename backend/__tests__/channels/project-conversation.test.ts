import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api, config } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import {
  type AgentStage,
  buildAgentStage,
  runTicks,
  startConversation,
} from "../agent/harness";
import { call, createTag, HOOK_TIMEOUT } from "../setup";

/**
 * The gate on `project:<id>:conversation:<id>`: a session, member standing,
 * and read access to the conversation's bot — the rule `conversation:entries`
 * applies. A refused subscriber receives nothing, and a frame never carries
 * content: a tick's step reaches the subscriber as `{event: "conversation"}`.
 */
let stage: AgentStage;
let vaultConversation: number;

/**
 * Open a socket with a session.
 * @param session - The session id, if any.
 * @returns The socket and its message log.
 */
async function openSocket(session?: string) {
  const socket = new WebSocket(stage.u.url.replace(/^http/, "ws"), {
    headers: session
      ? { Cookie: `${config.session.cookieName}=${session}` }
      : {},
  });
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  return { socket, messages };
}

/**
 * Subscribe and report the answer.
 * @param socket - The socket.
 * @param messages - Its log.
 * @param channel - The channel.
 * @returns Whether it was accepted, and the refusal if not.
 */
async function subscribe(
  socket: WebSocket,
  messages: unknown[],
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  socket.send(JSON.stringify({ messageType: "subscribe", channel }));
  const deadline = Date.now() + 5_000;
  for (;;) {
    for (const raw of messages) {
      const m = raw as {
        subscribed?: { channel: string };
        error?: { message?: string };
      };
      if (m.subscribed?.channel === channel) return { ok: true };
      if (m.error) return { ok: false, error: m.error.message };
    }
    if (Date.now() > deadline) return { ok: false, error: "no answer" };
    await Bun.sleep(20);
  }
}

/**
 * The broadcast payloads a socket received, past Keryx's own presence
 * frames (`join` / `leave`).
 * @param messages - Its log.
 * @returns Each frame's parsed payload.
 */
function frames(messages: unknown[]): unknown[] {
  return messages.flatMap((raw) => {
    const frame = raw as { message?: { message?: string } };
    if (typeof frame.message?.message !== "string") return [];
    const payload = JSON.parse(frame.message.message) as { event?: string };
    return payload.event === "join" || payload.event === "leave"
      ? []
      : [payload];
  });
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  const { u } = stage;
  const staff = await createTag(u.url, u.peach, u.projectId, "vault-staff");
  await call(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/member/${u.mario.userId}/tag/${staff}`,
  );
  const vault = await call<ActionResponse<BotCreate>>(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/bot`,
    { name: "Vault", persona: "Guard.", accessRead: ["vault-staff"] },
  );
  const res = await call<{ conversation: { id: number } }>(
    u.url,
    u.mario,
    "PUT",
    `/project/${u.projectId}/bot/${vault.body.bot.id}/conversation`,
    { text: "Secret." },
  );
  vaultConversation = res.body.conversation.id;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("project:<id>:conversation:<id>", () => {
  test("a reader subscribes and a tick's steps arrive as content-free pings", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Pong." } }] },
    ]);
    const res = await startConversation(stage, "Ping?");
    const id = res.body.conversation.id;
    const { socket, messages } = await openSocket(stage.u.toad.sessionId);
    try {
      const channel = `project:${stage.u.projectId}:conversation:${id}`;
      expect((await subscribe(socket, messages, channel)).ok).toBe(true);
      await runTicks();
      const deadline = Date.now() + 5_000;
      while (frames(messages).length === 0 && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(frames(messages).length).toBeGreaterThan(0);
      for (const frame of frames(messages)) {
        expect(frame).toEqual({ event: "conversation" });
      }
    } finally {
      socket.close();
    }
  });

  test("a member who cannot read the bot, a missing conversation, an outsider, and no session are refused alike", async () => {
    const cases = [
      [stage.u.toad.sessionId, vaultConversation],
      [stage.u.toad.sessionId, 2_000_000_000],
      [stage.u.bowser.sessionId, vaultConversation],
    ] as const;
    const refusals: string[] = [];
    for (const [session, id] of cases) {
      const { socket, messages } = await openSocket(session);
      try {
        const result = await subscribe(
          socket,
          messages,
          `project:${stage.u.projectId}:conversation:${id}`,
        );
        expect(result.ok).toBe(false);
        refusals.push(String(result.error));
      } finally {
        socket.close();
      }
    }
    expect(new Set(refusals).size).toBe(1);
    const anonymous = await openSocket();
    try {
      const result = await subscribe(
        anonymous.socket,
        anonymous.messages,
        `project:${stage.u.projectId}:conversation:${vaultConversation}`,
      );
      expect(result.ok).toBe(false);
    } finally {
      anonymous.socket.close();
    }
  });
});
