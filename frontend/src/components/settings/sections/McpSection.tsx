import { useEffect, useRef, useState } from "react";
import { Button, Form } from "../../../ui";
import SectionCard from "../../sections/SectionCard";
import { useProjectSettings } from "../context";

/**
 * The MCP endpoint an external client connects to.
 *
 * The address, not a secret. Anyone connecting gets their own OAuth session and
 * sees only what their own tags allow, so the URL is safe on a section every member
 * can read — what it is worth is saving somebody from guessing it. It comes from
 * the server rather than being assembled from `window.location`, because the browser
 * knows the origin it was *served* from and the API is on a different host in every
 * deployed configuration.
 * @returns The rendered section.
 */
export default function McpSection() {
  const { mcp } = useProjectSettings();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A section unmounts on a sidebar click: without this, copying and
  // immediately navigating away sets state on an unmounted component two
  // seconds later.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <SectionCard
      title="MCP endpoint"
      testId="mcp"
      idPrefix="settings"
      cardTestId="mcp-card"
      intro={
        <>
          Point an MCP client here to manage this project from a model. It
          authenticates with OAuth as the person who signed in, and can do what
          they can do.
        </>
      }
    >
      {/* No loading branch, and that is a property of the shell rather than an
          omission: `SettingsPage` withholds the whole outlet context until
          `project:view` has answered, so `mcp` is never "not yet" by the time
          this mounts. What it can be is *absent* — the deployment reported no
          endpoint — which is the branch below. */}
      {mcp?.enabled === false ? (
        <p className="text-warning mb-0" data-testid="mcp-disabled">
          The MCP server is switched off in this deployment, so this endpoint
          answers nothing.
        </p>
      ) : !mcp?.url ? (
        <p className="text-warning mb-0" data-testid="mcp-unavailable">
          This deployment did not report an MCP endpoint.
        </p>
      ) : (
        <div className="d-flex gap-2 align-items-center">
          <Form.Control
            readOnly
            value={mcp?.url ?? ""}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="MCP endpoint URL"
            data-testid="mcp-url"
          />
          <Button
            variant="outline-primary"
            disabled={!mcp?.url}
            onClick={async () => {
              if (!mcp?.url) return;
              await navigator.clipboard.writeText(mcp.url);
              setCopied(true);
              if (resetTimer.current) clearTimeout(resetTimer.current);
              resetTimer.current = setTimeout(() => setCopied(false), 2000);
            }}
            data-testid="mcp-copy"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
