import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "../ui";
import { sourceFiles } from "./sourceScan";

describe("the bot badge", () => {
  test("a bot avatar always carries the badge, with the bot's name beside it", () => {
    const markup = renderToStaticMarkup(
      createElement(Avatar, { name: "Ada", bot: true }),
    );
    expect(markup).toContain('aria-label="Ada (bot)"');
    expect(markup).toContain('class="ui-bot-badge-tag">bot<');
    expect(markup).toContain('data-bot="Ada"');
    expect(markup).toContain("ui-avatar-bot");
  });

  test("a bot without a picture is a monogram, never a person-like default", () => {
    const markup = renderToStaticMarkup(
      createElement(Avatar, { name: "Kit", bot: true }),
    );
    expect(markup).toContain(">K<");
    expect(markup).not.toContain("<img");
  });

  test("a bot with a picture still carries the badge", () => {
    const markup = renderToStaticMarkup(
      createElement(Avatar, { name: "Kit", bot: true, src: "/kit.png" }),
    );
    expect(markup).toContain("<img");
    expect(markup).toContain("ui-bot-badge");
  });

  test("nothing outside the kit draws an avatar, so nothing can drop the badge", () => {
    // Avatar has no prop that hides the badge; the other way to lose it would
    // be a page painting `ui-avatar` itself.
    const offenders = sourceFiles([".tsx", ".ts"])
      .filter(({ path }) => path !== join("ui", "Avatar.tsx"))
      .filter(({ body }) => /["'` ]ui-avatar(-bot)?["'` ]/.test(body))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  test("a person's avatar never carries it", () => {
    const markup = renderToStaticMarkup(
      createElement(Avatar, { name: "Ada Lovelace" }),
    );
    expect(markup).not.toContain("ui-bot-badge");
    expect(markup).toContain(">AL<");
    expect(markup).toContain('aria-label="Ada Lovelace"');
  });
});
