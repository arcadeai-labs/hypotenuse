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

  const fence = "```mermaid\nflowchart TD\n  a --> b\n```";

  test("an agent's mermaid fence stays a plain code block", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MarkdownBlock>{fence}</MarkdownBlock>
      </MemoryRouter>,
    );
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).not.toContain("mermaid-diagram");
  });

  test("authored docs opt in to diagrams, and nothing else does", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MarkdownBlock diagrams>{fence}</MarkdownBlock>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="mermaid-diagram"');
    const optIns = sourceFiles([".tsx"])
      .filter(({ body }) => /<MarkdownBlock\b[^>]*\bdiagrams\b/.test(body))
      .map(({ path }) => path.replace(/^.*\/src\//, ""));
    expect(optIns).toEqual(["pages/docs/DocsPage.tsx"]);
  });

  test("mermaid is only ever a dynamic import, from MermaidDiagram", () => {
    for (const { path, body } of sourceFiles([".ts", ".tsx"])) {
      const code = stripComments(body);
      expect(code, path).not.toMatch(/from "mermaid"/);
      if (code.includes('import("mermaid")')) {
        expect(path).toEndWith("components/MermaidDiagram.tsx");
      }
    }
  });
});
