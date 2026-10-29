import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { and, desc, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import type { BotEdit } from "../../actions/bot/bot-edit";
import type { BotList } from "../../actions/bot/bot-list";
import type { BotView } from "../../actions/bot/bot-view";
import { auditLogs } from "../../schema/audit_logs";
import {
  buildTestUniverse,
  call,
  cookieHeader,
  createTag,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

let u: TestUniverse;
let castleStaffTagId: number;

beforeAll(async () => {
  u = await buildTestUniverse();
  // Mario holds `castle-staff`; Toad and Luigi do not.
  castleStaffTagId = await createTag(
    u.url,
    u.peach,
    u.projectId,
    "castle-staff",
  );
  const granted = await call(
    u.url,
    u.peach,
    "PUT",
    `/project/${u.projectId}/member/${u.mario.userId}/tag/${castleStaffTagId}`,
  );
  if (granted.status !== 200) throw new Error(JSON.stringify(granted.body));
  // Daisy becomes an owner of the Mushroom Kingdom without joining Castle.
  const promoted = await call(
    u.url,
    u.peach,
    "POST",
    `/organization/${u.organizationId}/member/${u.daisy.userId}`,
    { role: "owner" },
  );
  if (promoted.status !== 200) throw new Error(JSON.stringify(promoted.body));
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Create a bot in Castle.
 * @param user - Who creates it.
 * @param fields - The bot's fields; a persona is supplied if missing.
 * @returns The status and body.
 */
async function createBot(user: TestUser, fields: Record<string, unknown>) {
  return call<ActionResponse<BotCreate>>(
    u.url,
    user,
    "PUT",
    `/project/${u.projectId}/bot`,
    { persona: "You are helpful and brief.", ...fields },
  );
}

/**
 * Castle's bots as someone sees them.
 * @param user - Who lists.
 * @returns The list body.
 */
async function listBots(user: TestUser) {
  const res = await call<ActionResponse<BotList>>(
    u.url,
    user,
    "GET",
    `/project/${u.projectId}/bots`,
  );
  expect(res.status).toBe(200);
  return res.body;
}

/**
 * View a Castle bot.
 * @param user - Who views.
 * @param botId - The bot.
 * @returns The status and body.
 */
async function viewBot(user: TestUser, botId: number) {
  return call<ActionResponse<BotView>>(
    u.url,
    user,
    "GET",
    `/project/${u.projectId}/bot/${botId}`,
  );
}

/**
 * Edit a Castle bot.
 * @param user - Who edits.
 * @param botId - The bot.
 * @param fields - The fields to change.
 * @returns The status and body.
 */
async function editBot(
  user: TestUser,
  botId: number,
  fields: Record<string, unknown>,
) {
  return call<ActionResponse<BotEdit>>(
    u.url,
    user,
    "POST",
    `/project/${u.projectId}/bot/${botId}`,
    fields,
  );
}

/** The CRC-32 table PNG chunks are checked with. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/**
 * A CRC-32.
 * @param bytes - The bytes.
 * @returns The checksum.
 */
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A real, decodable, single-color PNG.
 * @param width - Its width.
 * @param height - Its height.
 * @param padTo - Pad the file (after `IEND`) to at least this many bytes.
 * @returns The file.
 */
function png(width: number, height: number, padTo = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return padTo > file.length
    ? Buffer.concat([file, Buffer.alloc(padTo - file.length)])
    : file;
}

/**
 * The header of a baseline JPEG: start of image, then a start-of-frame
 * segment naming its size. Enough for the server, which reads only that.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The bytes.
 */
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe("bot:create", () => {
  test("is member-level, with a generated slug and the name as display name", async () => {
    const res = await createBot(u.toad, {
      name: "Ada Lovelace",
      description: "Answers questions about the castle.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.bot).toMatchObject({
      name: "Ada Lovelace",
      slug: "ada-lovelace",
      displayName: "Ada Lovelace",
      modelAlias: "default",
      fastModelAlias: "fast",
      accessRead: [],
      accessWrite: [],
      helpNotifyTag: null,
      monthlyBudgetUsd: null,
      enabled: true,
      avatarUrl: null,
      createdByUserId: u.toad.userId,
    });
    expect(res.body.standing).toEqual({ canWrite: true });
    expect(JSON.stringify(res.body)).not.toContain('"avatar":');
  });

  test("a generated slug steps past one already taken; an explicit one is refused", async () => {
    const second = await createBot(u.toad, { name: "Ada Lovelace" });
    expect(second.body.bot.slug).toBe("ada-lovelace-2");
    const explicit = await createBot(u.toad, {
      name: "Another",
      slug: "ada-lovelace",
    });
    expect(explicit.status).toBe(406);
    expect(explicit.body.error?.key).toBe("slug");
    for (const slug of ["Has-Caps", "two--dashes", "-leading", "spa ce"]) {
      const bad = await createBot(u.toad, { name: "Bad slug", slug });
      expect(bad.status, slug).toBe(406);
    }
  });

  test("an outsider is refused, a signed-out caller is 401", async () => {
    expect((await createBot(u.bowser, { name: "Intruder" })).status).toBe(403);
    const anonymous = await call(
      u.url,
      null,
      "PUT",
      `/project/${u.projectId}/bot`,
      {
        name: "Nobody",
        persona: "x",
      },
    );
    expect(anonymous.status).toBe(401);
  });

  test("names every field's limits", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "" }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ name: "Ok", description: "x".repeat(281) }, "description"],
      [{ name: "Ok", persona: "" }, "persona"],
      [{ name: "Ok", accessRead: ["no-such-tag"] }, "accessRead"],
      [{ name: "Ok", helpNotifyTag: "no-such-tag" }, "helpNotifyTag"],
      [{ name: "Ok", modelAlias: "reasoning" }, "modelAlias"],
      [{ name: "Ok", monthlyBudgetUsd: -1 }, "monthlyBudgetUsd"],
    ];
    for (const [fields, key] of cases) {
      const res = await createBot(u.toad, fields);
      expect(res.status, JSON.stringify(fields)).toBe(406);
      expect(res.body.error?.key, JSON.stringify(fields)).toBe(key);
    }
  });

  test("stores a budget and a help tag", async () => {
    const res = await createBot(u.peach, {
      name: "Accountant",
      monthlyBudgetUsd: 125.5,
      helpNotifyTag: "Operators",
    });
    expect(res.status).toBe(200);
    expect(res.body.bot.monthlyBudgetUsd).toBe(125.5);
    expect(res.body.bot.helpNotifyTag).toBe("operators");
  });

  test("the creator must satisfy the lists they set, unless they are an admin", async () => {
    const lockedOut = await createBot(u.toad, {
      name: "Locked",
      accessWrite: ["castle-staff"],
    });
    expect(lockedOut.status).toBe(406);
    expect(lockedOut.body.error?.key).toBe("accessWrite");
    expect(lockedOut.body.error?.message).toContain(
      "Add one of your tags, or ask an admin",
    );
    const unreadable = await createBot(u.toad, {
      name: "Unreadable",
      accessRead: ["castle-staff"],
    });
    expect(unreadable.status).toBe(406);
    expect(unreadable.body.error?.key).toBe("accessRead");
    const admin = await createBot(u.peach, {
      name: "Admin-only writes",
      accessWrite: ["castle-staff"],
    });
    expect(admin.status).toBe(200);
  });
});

describe("canReadBot", () => {
  let secretId: number;

  beforeAll(async () => {
    const res = await createBot(u.mario, {
      name: "Castle Secret",
      accessRead: ["castle-staff"],
      accessWrite: ["castle-staff"],
    });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    secretId = res.body.bot.id;
  });

  test("hides the bot from Toad in the list, its count included", async () => {
    const toad = await listBots(u.toad);
    expect(toad.bots.map((b) => b.name)).not.toContain("Castle Secret");
    const mario = await listBots(u.mario);
    expect(mario.bots.map((b) => b.name)).toContain("Castle Secret");
    expect(mario.pagination.total).toBe(toad.pagination.total + 1);
  });

  test("answers Toad the same 404 as a bot that does not exist", async () => {
    const hidden = await viewBot(u.toad, secretId);
    const missing = await viewBot(u.toad, 999_999);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.error?.message).toBe(missing.body.error!.message);
    const avatar = await fetch(
      `${u.url}/api/project/${u.projectId}/bot/${secretId}/avatar`,
      { headers: cookieHeader(u.toad.sessionId) },
    );
    expect(avatar.status).toBe(404);
    const edit = await editBot(u.toad, secretId, { name: "Mine" });
    expect(edit.status).toBe(404);
    const del = await call(
      u.url,
      u.toad,
      "DELETE",
      `/project/${u.projectId}/bot/${secretId}`,
    );
    expect(del.status).toBe(404);
  });

  test("Peach, an explicit admin, sees and edits it", async () => {
    const view = await viewBot(u.peach, secretId);
    expect(view.status).toBe(200);
    expect(view.body.standing.canWrite).toBe(true);
    const edit = await editBot(u.peach, secretId, {
      description: "Edited by the princess.",
    });
    expect(edit.status).toBe(200);
  });

  test("an organization owner who never joined the project does too", async () => {
    const list = await listBots(u.daisy);
    expect(list.bots.map((b) => b.name)).toContain("Castle Secret");
    const edit = await editBot(u.daisy, secretId, { enabled: false });
    expect(edit.status).toBe(200);
    expect(edit.body.bot.enabled).toBe(false);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "bot:edit"),
          eq(auditLogs.userId, u.daisy.userId),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.metadata).toMatchObject({ standing: "organization-owner" });
  });

  test("Bowser, outside the project, is refused before any bot is read", async () => {
    const res = await call(
      u.url,
      u.bowser,
      "GET",
      `/project/${u.projectId}/bots`,
    );
    expect(res.status).toBe(403);
  });
});

describe("canWriteBot", () => {
  let operatorsBotId: number;

  beforeAll(async () => {
    const res = await createBot(u.mario, {
      name: "Plumbing",
      accessWrite: ["operators"],
    });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    operatorsBotId = res.body.bot.id;
  });

  test("a reader who is not a writer sees it, is told so, and cannot change it", async () => {
    const view = await viewBot(u.luigi, operatorsBotId);
    expect(view.status).toBe(200);
    expect(view.body.standing.canWrite).toBe(false);
    const listed = (await listBots(u.luigi)).bots.find(
      (b) => b.id === operatorsBotId,
    );
    expect(listed?.standing.canWrite).toBe(false);
    const edit = await editBot(u.luigi, operatorsBotId, { name: "Luigi's" });
    expect(edit.status).toBe(403);
    expect(edit.body.error?.message).toContain('"operators"');
    const del = await call(
      u.url,
      u.luigi,
      "DELETE",
      `/project/${u.projectId}/bot/${operatorsBotId}`,
    );
    expect(del.status).toBe(403);
  });

  test("the lockout guard: a writer cannot save a write list without their tags", async () => {
    const res = await editBot(u.mario, operatorsBotId, {
      accessWrite: ["viewers"],
    });
    expect(res.status).toBe(406);
    expect(res.body.error?.key).toBe("accessWrite");
    expect(res.body.error?.message).toContain(
      "Add one of your tags, or ask an admin",
    );
    const kept = await editBot(u.mario, operatorsBotId, {
      accessWrite: ["viewers", "operators"],
    });
    expect(kept.status).toBe(200);
  });

  test("an admin may save any list", async () => {
    const res = await editBot(u.peach, operatorsBotId, {
      accessWrite: ["viewers"],
    });
    expect(res.status).toBe(200);
    expect(
      (await viewBot(u.mario, operatorsBotId)).body.standing.canWrite,
    ).toBe(false);
    expect(
      (await viewBot(u.luigi, operatorsBotId)).body.standing.canWrite,
    ).toBe(true);
  });

  test("a writer deletes it, and it is gone", async () => {
    const res = await call(
      u.url,
      u.luigi,
      "DELETE",
      `/project/${u.projectId}/bot/${operatorsBotId}`,
    );
    expect(res.status).toBe(200);
    expect((await viewBot(u.peach, operatorsBotId)).status).toBe(404);
  });
});

describe("avatars", () => {
  let botId: number;

  beforeAll(async () => {
    const res = await createBot(u.toad, { name: "Portrait" });
    botId = res.body.bot.id;
  });

  test("a square PNG is stored, served with its type, and summarized in the audit row", async () => {
    const image = png(64, 64);
    const res = await editBot(u.toad, botId, {
      avatar: image.toString("base64"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.bot.avatarMimeType).toBe("image/png");
    expect(res.body.bot.avatarUrl).toStartWith(
      `/project/${u.projectId}/bot/${botId}/avatar?v=`,
    );

    const served = await fetch(`${u.url}/api${res.body.bot.avatarUrl}`, {
      headers: cookieHeader(u.luigi.sessionId),
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(image)).toBe(true);

    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "bot:edit"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row.metadata).toMatchObject({
      avatar: {
        bytes: image.length,
        mimeType: "image/png",
        width: 64,
        height: 64,
      },
    });
    expect(
      (row.metadata as { avatar: { sha256: string } }).avatar.sha256,
    ).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(
      image.toString("base64").slice(0, 40),
    );
  });

  test("a data: URL of a square JPEG is accepted", async () => {
    const res = await editBot(u.toad, botId, {
      avatar: `data:image/jpeg;base64,${jpeg(128, 128).toString("base64")}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.bot.avatarMimeType).toBe("image/jpeg");
  });

  test("a non-square, oversized, or non-image avatar is refused", async () => {
    const cases: [string, string][] = [
      [png(64, 32).toString("base64"), "square"],
      [png(64, 64, 600 * 1024).toString("base64"), "512 KB"],
      [Buffer.from("GIF89a....").toString("base64"), "PNG or JPEG"],
      ["not base64 at all!", "base64"],
    ];
    for (const [avatar, says] of cases) {
      const res = await editBot(u.toad, botId, { avatar });
      expect(res.status, says).toBe(406);
      expect(res.body.error?.key, says).toBe("avatar");
      expect(res.body.error?.message, says).toContain(says);
    }
  });

  test("null removes it", async () => {
    const res = await editBot(u.toad, botId, { avatar: null });
    expect(res.status).toBe(200);
    expect(res.body.bot.avatarUrl).toBeNull();
    const served = await fetch(
      `${u.url}/api/project/${u.projectId}/bot/${botId}/avatar`,
      { headers: cookieHeader(u.toad.sessionId) },
    );
    expect(served.status).toBe(404);
  });
});

describe("tags a bot names", () => {
  test("follow a rename, help tag included, and block deletion", async () => {
    const tagId = await createTag(u.url, u.peach, u.projectId, "stewards");
    const created = await createBot(u.peach, {
      name: "Steward",
      accessRead: ["stewards"],
      helpNotifyTag: "stewards",
    });
    expect(created.status).toBe(200);

    const refused = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${tagId}`,
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain('bot "Steward"');

    const renamed = await call(
      u.url,
      u.peach,
      "POST",
      `/project/${u.projectId}/tag/${tagId}`,
      { name: "Wardens" },
    );
    expect(renamed.status).toBe(200);
    const view = await viewBot(u.peach, created.body.bot.id);
    expect(view.body.bot.accessRead).toEqual(["wardens"]);
    expect(view.body.bot.helpNotifyTag).toBe("wardens");
  });

  test("a tag named only as a help tag also blocks deletion", async () => {
    const tagId = await createTag(u.url, u.peach, u.projectId, "on-call");
    await createBot(u.peach, { name: "Pager", helpNotifyTag: "on-call" });
    const refused = await call(
      u.url,
      u.peach,
      "DELETE",
      `/project/${u.projectId}/tag/${tagId}`,
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain('bot "Pager"');
  });
});

describe("bot:list", () => {
  test("pages by name over readable bots only", async () => {
    const res = await call<ActionResponse<BotList>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}/bots?limit=2&page=1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.bots).toHaveLength(2);
    const names = res.body.bots.map((b) => b.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(res.body.pagination.pages).toBe(
      Math.ceil(res.body.pagination.total / 2),
    );
  });

  test("another project's bots are never listed", async () => {
    const own = await call<ActionResponse<BotList>>(
      u.url,
      u.bowser,
      "GET",
      `/project/${u.bowser.projectId}/bots`,
    );
    expect(own.status).toBe(200);
    expect(own.body.bots).toEqual([]);
  });
});
