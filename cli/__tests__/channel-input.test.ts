import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/client";
import { botBody, parseAutoBind } from "../src/commands/bot";
import {
  audienceText,
  type Binding,
  bindingText,
  flagWords,
} from "../src/commands/channel";
import { installationStatus } from "../src/commands/installation";

/**
 * A binding with defaults for the fields a test does not care about.
 * @param fields - The fields that matter.
 * @returns The binding.
 */
function binding(fields: Partial<Binding> = {}): Binding {
  return {
    id: 1,
    projectId: 1,
    botId: 1,
    channelId: 1,
    mode: "mentions",
    defaultDelivery: "steer",
    approvalPolicy: "dashboard",
    approverExternalIds: [],
    allowPromotion: false,
    allowShared: false,
    enabled: true,
    autoBound: false,
    createdByUserId: null,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

describe("parseAutoBind", () => {
  test("names the kinds that bind themselves; none is none", () => {
    expect(parseAutoBind("public, dm")).toEqual({
      public: true,
      private: false,
      dm: true,
    });
    expect(parseAutoBind("none")).toEqual({
      public: false,
      private: false,
      dm: false,
    });
    expect(parseAutoBind("")).toEqual({
      public: false,
      private: false,
      dm: false,
    });
  });

  test("refuses a kind that is not one", () => {
    expect(() => parseAutoBind("public,group")).toThrow('got "group"');
  });

  test("botBody sends the edit-only channel settings", () => {
    expect(
      botBody({
        autoBind: "private",
        participantRateLimit: "10",
        channelRateLimit: "60",
      }),
    ).toEqual({
      autoBind: { public: false, private: true, dm: false },
      participantRateLimit: 10,
      channelRateLimit: 60,
    });
  });
});

describe("channel and binding text", () => {
  test("a channel's audience", () => {
    expect(
      audienceText({ isPrivate: false, isShared: false, archived: false }),
    ).toBe("public");
    expect(
      audienceText({ isPrivate: true, isShared: true, archived: true }),
    ).toBe("private, shared, archived");
  });

  test("a binding's settings on one line", () => {
    expect(bindingText(binding())).toBe(
      "mentions, steer, approvals: dashboard",
    );
    expect(
      bindingText(
        binding({
          mode: "all",
          enabled: false,
          defaultDelivery: "queue",
          approvalPolicy: "listed",
          approverExternalIds: ["U1", "U2"],
          allowPromotion: true,
          autoBound: true,
        }),
      ),
    ).toBe(
      "all (disabled), queue, approvals: listed (U1, U2), promotes, auto-bound",
    );
  });

  test("an installation's status carries its error", () => {
    expect(installationStatus({ status: "active", lastError: null })).toBe(
      "active",
    );
    expect(installationStatus({ status: "error", lastError: "HTTP 500" })).toBe(
      "error: HTTP 500",
    );
  });
});

describe("flagWords", () => {
  test("a refusal naming an input names the flag instead", () => {
    const said = flagWords(
      new ApiError(
        '"secret" is private. Pass confirmAudience: true if that is what you mean.',
        406,
        "CONNECTION_ACTION_PARAM_VALIDATION",
      ),
    ) as ApiError;
    expect(said).toBeInstanceOf(ApiError);
    expect(said.message).toBe(
      '"secret" is private. Pass --confirm-audience if that is what you mean.',
    );
    expect(said.status).toBe(406);
  });

  test("anything else passes through untouched", () => {
    const other = new ApiError("Channel not found in this project", 404);
    expect(flagWords(other)).toBe(other);
    const plain = new Error("boom");
    expect(flagWords(plain)).toBe(plain);
  });
});
