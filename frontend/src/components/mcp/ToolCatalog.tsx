import type { ReactNode } from "react";
import { Chip } from "../../ui";
import { annotationChips } from "../../utils/mcp";
import type { CatalogTool } from "./data";

/**
 * A server's tools as its last listing cached them: each tool's name, its
 * title when it has one, its description, and a chip per annotation hint the
 * server set — read-only, destructive, and so on. Annotations are the
 * server's claim about itself, which is why they are drawn as chips and
 * never as a verdict.
 * @param props.tools - The tools, from `mcp-server:view`.
 * @param props.trailing - Something to draw at the end of a tool's row, such as whether it would wait for approval.
 * @param props.testId - The list's `data-testid`.
 * @returns The list.
 */
export function ToolCatalog({
  tools,
  trailing,
  testId,
}: {
  tools: readonly CatalogTool[];
  trailing?: (tool: CatalogTool) => ReactNode;
  testId?: string;
}) {
  if (tools.length === 0) {
    return (
      <p className="text-meta mcp-catalog-empty" data-testid={testId}>
        It lists no tools. Refresh its tools after the server adds some.
      </p>
    );
  }
  return (
    <ul className="mcp-catalog" data-testid={testId}>
      {tools.map((tool) => (
        <li
          key={tool.name}
          className="mcp-catalog-tool"
          data-testid={`mcp-tool-${tool.name}`}
        >
          <div className="mcp-catalog-head">
            <span className="mono mcp-catalog-name">{tool.name}</span>
            {tool.title && (
              <span className="mcp-catalog-title">{tool.title}</span>
            )}
            {annotationChips(tool.annotations).map((chip) => (
              <Chip
                key={chip.key}
                className={chip.caution ? "mcp-chip-caution" : undefined}
                data-annotation={chip.key}
              >
                {chip.label}
              </Chip>
            ))}
            {trailing && (
              <span className="mcp-catalog-trailing">{trailing(tool)}</span>
            )}
          </div>
          {tool.description && (
            <p className="mcp-catalog-description">{tool.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
