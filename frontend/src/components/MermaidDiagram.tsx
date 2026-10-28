import { useEffect, useId, useRef, useState } from "react";

/**
 * The semantic tokens a diagram is painted with, keyed by the Mermaid theme
 * variable each one fills. Mermaid derives its other colors from these.
 */
const TOKEN_VARIABLES = {
  background: "--bg-panel",
  mainBkg: "--bg-raised",
  primaryColor: "--bg-raised",
  primaryTextColor: "--text-primary",
  primaryBorderColor: "--border-strong",
  nodeBorder: "--border-strong",
  secondaryColor: "--bg-sunken",
  tertiaryColor: "--bg-sunken",
  lineColor: "--text-tertiary",
  textColor: "--text-secondary",
  edgeLabelBackground: "--bg-panel",
} as const;

/**
 * The computed type properties the diagram inherits from the docs column, so
 * its labels match body text. Mermaid names each one in camel case.
 */
const FONT_PROPERTIES = ["font-family", "font-size"] as const;

/**
 * Resolve the current theme's tokens into the values Mermaid wants. Mermaid
 * computes derived shades from real colors, so it cannot take a `var(...)`;
 * reading the live custom properties keeps the tokens the only source.
 * @param element - An element inside the themed document, for its type.
 * @returns Mermaid `themeVariables`.
 */
function themeVariables(element: Element): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const here = getComputedStyle(element);
  const variables: Record<string, string> = {};
  for (const property of FONT_PROPERTIES) {
    const name = property.replace(/-(\w)/g, (_, letter) =>
      letter.toUpperCase(),
    );
    variables[name] = here.getPropertyValue(property);
  }
  for (const [name, token] of Object.entries(TOKEN_VARIABLES)) {
    variables[name] = root.getPropertyValue(token).trim();
  }
  return variables;
}

/**
 * A Mermaid diagram from authored docs. Mermaid itself is a dynamic import, so
 * it downloads only when a page actually has a diagram. Until it draws (and if
 * it cannot), the source shows as a plain code block. The diagram redraws when
 * `<html data-theme>` changes, after the new tokens apply.
 *
 * Only `MarkdownBlock`'s `diagrams` opt-in reaches this: bot output never
 * does. Mermaid runs at `securityLevel: "strict"` with SVG-only labels, and its
 * SVG is parsed as XML and adopted as nodes rather than written as HTML.
 * @param props - The diagram's Mermaid source.
 * @returns The diagram.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const container = useRef<HTMLDivElement>(null);
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let generation = 0;

    /** Draw (or redraw) the diagram in the current theme. */
    const draw = async () => {
      const mine = ++generation;
      const theme = document.documentElement.dataset.theme ?? "light";
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          theme: "base",
          themeVariables: {
            ...themeVariables(element),
            darkMode: theme === "dark",
          },
          flowchart: { useMaxWidth: true },
        });
        const { svg } = await mermaid.render(`${id}-${mine}`, source);
        if (mine !== generation) return;
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (parsed.querySelector("parsererror")) return;
        element.replaceChildren(
          document.importNode(parsed.documentElement, true),
        );
        setDrawn(theme);
      } catch {
        // Leave the source showing as code; a broken diagram is still readable.
      }
    };

    draw();
    const observer = new MutationObserver(() => draw());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      generation++;
      observer.disconnect();
    };
  }, [id, source]);

  return (
    <figure className="mermaid-diagram" data-testid="mermaid-diagram">
      <div
        ref={container}
        className="mermaid-diagram-svg"
        data-theme-variant={drawn ?? undefined}
        hidden={drawn === null}
      />
      {drawn === null && (
        <div className="markdown-code">
          <pre>
            <code className="language-mermaid">{source}</code>
          </pre>
        </div>
      )}
    </figure>
  );
}
