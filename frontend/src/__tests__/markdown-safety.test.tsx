import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MarkdownBlock } from "../components/MarkdownBlock";
import { sourceFiles, stripComments } from "./sourceScan";

describe("model-authored Markdown", () => {
  test("raw HTML in an agent's output is shown as text, never rendered", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MarkdownBlock>
          {
            'Done. <script>alert(1)</script> <img src=x onerror="alert(2)"> [click](javascript:alert(3))'
          }
        </MarkdownBlock>
      </MemoryRouter>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="javascript:/);
  });

  test("MarkdownBlock is the only importer of react-markdown, and nothing enables raw HTML", () => {
    for (const { path, body } of sourceFiles([".ts", ".tsx"])) {
      expect(stripComments(body), path).not.toMatch(
        /rehype-raw|dangerouslySetInnerHTML/,
      );
      if (body.includes('from "react-markdown"')) {
        expect(path).toEndWith("components/MarkdownBlock.tsx");
      }
    }
  });
});
