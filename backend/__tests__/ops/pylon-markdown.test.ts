import { describe, expect, test } from "bun:test";
import {
  markdownToPylonHtml,
  pylonHtmlToText,
} from "../../ops/PylonMarkdownOps";

/**
 * Text between Hypotenuse and Pylon: what the bot writes is escaped before a
 * closed set of markdown becomes tags, and what Pylon sends is read as text —
 * any entity it carries, even one that names no character, without throwing.
 */
describe("PylonMarkdownOps", () => {
  test("entities decode, and one past U+10FFFF (or NUL) stays as written instead of throwing", () => {
    expect(pylonHtmlToText("<p>a &amp; b &#39;c&#39; &#x1F600;</p>")).toBe(
      "a & b 'c' 😀",
    );
    expect(pylonHtmlToText("<p>&#x110000; &#99999999; &#0;</p>")).toBe(
      "&#x110000; &#99999999; &#0;",
    );
  });

  test("nothing the model writes becomes a tag, an attribute, or a javascript: link", () => {
    const html = markdownToPylonHtml(
      '**bold** <script>x</script> [ok](https://a.test) [no](javascript:alert(1)) "q"',
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://a.test">ok</a>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&quot;q&quot;");
  });
});
