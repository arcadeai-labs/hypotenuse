import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { cx } from "../ui/cx";
import { CopyButton } from "./CopyButton";

/**
 * Turn heading text into the id the "on this page" rail links to.
 * @param text - The heading's plain text.
 * @returns A lowercase, hyphenated slug.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Flatten rendered children back to their text.
 * @param node - React children.
 * @returns The concatenated text.
 */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}

/**
 * Render untrusted or authored markdown. This is the only importer of
 * `react-markdown` and it never enables raw HTML — that is what makes it safe
 * to render an agent's output into the DOM.
 * @param props - The markdown source; `internalLinks` keeps rooted links in-app.
 * @returns The rendered markdown.
 */
export function MarkdownBlock({
  children,
  internalLinks = false,
  className,
}: {
  children: string;
  internalLinks?: boolean;
  className?: string;
}) {
  const components: Components = {
    h2: ({ children: content }) => (
      <h2 id={slugify(textOf(content))}>{content}</h2>
    ),
    h3: ({ children: content }) => (
      <h3 id={slugify(textOf(content))}>{content}</h3>
    ),
    a: ({ href, children: content }: ComponentPropsWithoutRef<"a">) => {
      if (internalLinks && href?.startsWith("/") && !href.startsWith("//")) {
        return <Link to={href}>{content}</Link>;
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {content}
        </a>
      );
    },
    pre: ({ children: content }) => (
      <div className="markdown-code">
        <pre>{content}</pre>
        <CopyButton
          text={textOf(content).replace(/\n$/, "")}
          label="Copy code"
        />
      </div>
    ),
  };
  return (
    <div className={cx("markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
