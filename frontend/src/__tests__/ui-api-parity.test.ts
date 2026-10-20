import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as core from "../ui/core";

// The UI kit is ToolExec's, restyled. Pages ported from ToolExec rely on its
// prop surface, so every name below — frozen from ToolExec's
// `frontend/src/ui/core.tsx` and its one-line re-export modules — has to keep
// existing here, and the props those pages pass have to keep doing what they
// did. A rename or a dropped prop fails this suite instead of a ported page.

/** Top-level runtime exports of ToolExec's `ui/core.tsx`. */
const CORE_EXPORTS = [
  "UI_VARIANT_TONES",
  "Button",
  "Alert",
  "Badge",
  "Card",
  "Container",
  "Row",
  "Col",
  "Dropdown",
  "Form",
  "ListGroup",
  "Modal",
  "Nav",
  "Navbar",
  "Pagination",
  "ProgressBar",
  "Spinner",
  "Table",
] as const;

/** Sub-parts ToolExec hangs off those exports (`Card.Body`, `Form.Control.Feedback`, …). */
const SUB_PARTS = [
  "Alert.Heading",
  "Card.Header",
  "Card.Body",
  "Card.Footer",
  "Card.Title",
  "Card.Text",
  "Dropdown.Toggle",
  "Dropdown.Menu",
  "Dropdown.Item",
  "Dropdown.Header",
  "Dropdown.Divider",
  "Form.Group",
  "Form.Label",
  "Form.Control",
  "Form.Control.Feedback",
  "Form.Select",
  "Form.Check",
  "Form.Text",
  "ListGroup.Item",
  "Modal.Header",
  "Modal.Title",
  "Modal.Body",
  "Modal.Footer",
  "Nav.Link",
  "Nav.Item",
  "Navbar.Brand",
  "Navbar.Toggle",
  "Navbar.Collapse",
  "Pagination.Item",
  "Pagination.First",
  "Pagination.Prev",
  "Pagination.Next",
  "Pagination.Last",
  "Pagination.Ellipsis",
] as const;

/** ToolExec's one-line modules, each default-exporting the same-named component. */
const DEFAULT_MODULES = [
  "Alert",
  "Badge",
  "Button",
  "Card",
  "Col",
  "Container",
  "Dropdown",
  "Form",
  "ListGroup",
  "Modal",
  "Nav",
  "Navbar",
  "Pagination",
  "ProgressBar",
  "Row",
  "Spinner",
  "Table",
] as const;

/**
 * Walk a dotted path from the core module.
 * @param path - `Card.Body`, `Form.Control.Feedback`, ….
 * @returns Whatever is there, or `undefined`.
 */
function resolve(path: string): unknown {
  let value: unknown = core;
  for (const key of path.split(".")) {
    value = (value as Record<string, unknown> | undefined)?.[key];
  }
  return value;
}

/**
 * Render an element to markup.
 * @param element - The element.
 * @returns Its static HTML.
 */
function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("ToolExec's ui API is preserved", () => {
  test.each(CORE_EXPORTS)("core exports %s", (name) => {
    expect(core[name]).toBeDefined();
  });

  test.each(SUB_PARTS)("%s is still a component", (path) => {
    expect(typeof resolve(path)).toBe("function");
  });

  test.each(DEFAULT_MODULES)(
    "ui/%s default-exports the core component",
    async (name) => {
      const mod = await import(`../ui/${name}`);
      expect(mod.default).toBe(core[name]);
    },
  );

  test("the props ported pages pass still reach the markup", () => {
    const { Button, Badge, Alert, Table, ProgressBar, Form, Card } = core;
    // `variant`, `size`, and `data-testid` on a button; `outline-` tones.
    const button = html(
      createElement(
        Button,
        { variant: "outline-danger", size: "sm", "data-testid": "go" } as never,
        "Go",
      ),
    );
    expect(button).toContain('data-testid="go"');
    expect(button).toContain("ui-variant-outline-danger");
    expect(button).toContain("ui-button-sm");
    expect(button).toContain('type="button"');

    expect(html(createElement(Badge, { bg: "success", pill: true }))).toContain(
      "ui-badge-pill",
    );
    expect(
      html(createElement(Alert, { variant: "warning", dismissible: true })),
    ).toContain('aria-label="Close"');
    expect(
      html(createElement(Table, { hover: true, size: "sm", responsive: true })),
    ).toContain("ui-table-hover");
    expect(html(createElement(ProgressBar, { now: 50 }))).toContain(
      'aria-valuenow="50"',
    );
    expect(
      html(
        createElement(
          Form.Group,
          { controlId: "name" },
          createElement(Form.Label, null, "Name"),
          createElement(Form.Control, { isInvalid: true }),
        ),
      ),
    ).toMatch(/for="name".*id="name".*is-invalid/);
    expect(html(createElement(Card, { border: "danger" }))).toContain(
      "ui-card-border-danger",
    );
  });

  test("a plain ListGroup is unchanged by the grouped-list extension", () => {
    const plain = html(createElement(core.ListGroup, { variant: "flush" }));
    expect(plain).toContain("ui-list-group-flush");
    expect(plain).not.toContain("ui-list-group-header");
  });
});
