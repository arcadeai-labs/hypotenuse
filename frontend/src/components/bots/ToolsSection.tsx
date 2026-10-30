import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Chip, Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  parsePatterns,
  previewAllowances,
  samePatterns,
  type ToolAllowance,
  toolCountLabel,
} from "../../utils/mcp";
import { GatedButton } from "../GatedButton";
import type {
  BotMcpServer,
  BotMcpServers,
  CatalogTool,
  MatchResult,
  McpServer,
  McpServerDetail,
} from "../mcp/data";
import { McpStatusGlyph } from "../mcp/McpStatusGlyph";
import { ToolCatalog } from "../mcp/ToolCatalog";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { Bot } from "./data";

/** See {@link ToolsSection}. */
export interface ToolsSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change this bot's servers, or `undefined`. */
  denied: string | undefined;
}

/**
 * The bot's MCP servers: which of the project's servers it has, and for each
 * the allowlist — the patterns naming calls that run without a person —
 * previewed live against the server's catalog, and whether tools the server
 * calls read-only run unasked. Under them, the capabilities text the bot's
 * prompt carries, which is regenerated whenever what it can reach changes.
 *
 * Everything the preview says comes from the server: `mcp-server:match-tools`
 * runs the gate's own matcher, so the page never re-implements the patterns.
 * @param props - See {@link ToolsSectionProps}.
 * @returns The section.
 */
export function ToolsSection({ projectId, bot, denied }: ToolsSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [bindings, setBindings] = useState<BotMcpServers | null>(null);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [adding, setAdding] = useState("");
  const locked = denied !== undefined;
  const base = `/project/${projectId}/bot/${bot.id}`;

  const reload = useCallback(async () => {
    try {
      const [mine, all] = await Promise.all([
        apiFetch<BotMcpServers>(`${base}/mcp-servers?limit=100`),
        apiFetch<{ mcpServers: McpServer[] }>(
          `/project/${projectId}/mcp-servers?limit=100`,
        ),
      ]);
      setBindings(mine);
      setServers(all.mcpServers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tools.");
    }
  }, [base, projectId, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  const bound = new Set(bindings?.botMcpServers.map((b) => b.mcpServerId));
  const offered = (servers ?? []).filter((s) => !bound.has(s.id));

  /** Give the bot the chosen server, with nothing allowlisted. */
  async function onAdd() {
    const server = offered.find((s) => String(s.id) === adding);
    if (!server) return;
    const ok = await save(
      () =>
        apiFetch(`${base}/mcp-server`, {
          method: "PUT",
          body: JSON.stringify({ mcpServerId: server.id }),
        }),
      `${bot.name} has ${server.name}. Every call waits for approval until you allowlist some.`,
    );
    if (ok) {
      setAdding("");
      await reload();
    }
  }

  return (
    <SectionCard
      title="Tools"
      testId="bot-tools"
      idPrefix="bot"
      intro={
        <>
          The project's <Link to="/settings/mcp-servers">MCP servers</Link> this
          bot may call. A call that no pattern allows waits in{" "}
          <Link to="/approvals">Approvals</Link> until a person decides it.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      loading={bindings === null && error === null}
      loadingBlocks={2}
    >
      {bindings?.botMcpServers.length === 0 && (
        <p className="text-muted" data-testid="bot-tools-empty">
          {bot.name} has no MCP servers.{" "}
          {servers?.length === 0
            ? "An admin connects one in Settings → MCP servers first."
            : "Give it one below."}
        </p>
      )}
      <div className="bot-tools-servers">
        {bindings?.botMcpServers.map((binding) => (
          <BindingEditor
            key={binding.id}
            projectId={projectId}
            bot={bot}
            binding={binding}
            denied={denied}
            reload={reload}
          />
        ))}
      </div>

      <Form
        className="bot-tools-add"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <Form.Group controlId="bot-tools-add" className="mb-0">
          <Form.Label>Give it a server</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={adding}
            disabled={busy || locked || offered.length === 0}
            title={denied}
            onChange={(e) => setAdding(e.target.value)}
            data-testid="bot-tools-add-select"
          >
            <option value="">
              {offered.length === 0
                ? "No other servers in this project"
                : "Choose a server"}
            </option>
            {offered.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {toolCountLabel(s.toolCount)}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <GatedButton
          size="sm"
          type="submit"
          variant="outline-primary"
          disabled={busy || adding === ""}
          deniedReason={denied}
          data-testid="bot-tools-add-submit"
        >
          Add server
        </GatedButton>
      </Form>

      <div className="bot-capabilities" data-testid="bot-capabilities">
        <h3 className="bot-capabilities-title">
          What its prompt says it can do
        </h3>
        {bindings?.capabilities ? (
          <pre className="bot-capabilities-text">{bindings.capabilities}</pre>
        ) : (
          <p className="text-meta mb-0">
            Nothing yet. It is written from the tools of the servers it has, and
            rewritten whenever they change.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

/** The live preview's state. */
type Preview =
  | { state: "idle" }
  | { state: "loaded"; result: MatchResult }
  | { state: "invalid"; message: string };

/**
 * One server the bot has: its patterns, the read-only switch, a live preview
 * of what runs and what waits, and Save and Remove.
 * @param props - The binding and the page's context.
 * @returns The editor.
 */
function BindingEditor({
  projectId,
  bot,
  binding,
  denied,
  reload,
}: {
  projectId: number;
  bot: Bot;
  binding: BotMcpServer;
  denied: string | undefined;
  reload: () => Promise<void>;
}) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [text, setText] = useState(binding.allowedTools.join("\n"));
  const [readOnly, setReadOnly] = useState(binding.autoAllowReadOnly);
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const locked = busy || denied !== undefined;
  const server = binding.server;
  const patterns = parsePatterns(text);
  const changed =
    !samePatterns(patterns, binding.allowedTools) ||
    readOnly !== binding.autoAllowReadOnly;
  const serverPath = `/project/${projectId}/mcp-server/${server.id}`;

  useEffect(() => {
    setText(binding.allowedTools.join("\n"));
    setReadOnly(binding.autoAllowReadOnly);
  }, [binding]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<McpServerDetail>(serverPath)
      .then((res) => {
        if (!cancelled) setTools(res.tools);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverPath]);

  // Ask the server what the patterns match, a moment after typing stops.
  const key = patterns.join("\n");
  useEffect(() => {
    if (key === "") {
      setPreview({ state: "loaded", result: { matches: [], gated: [] } });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<MatchResult>(
        `${serverPath}/match?patterns=${encodeURIComponent(key)}`,
      )
        .then((result) => {
          if (!cancelled) setPreview({ state: "loaded", result });
        })
        .catch((err) => {
          if (!cancelled)
            setPreview({
              state: "invalid",
              message:
                err instanceof Error ? err.message : "That pattern is invalid.",
            });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, serverPath]);

  /** Save the patterns and the read-only switch. */
  async function onSave() {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/bot/${bot.id}/mcp-server`, {
          method: "PUT",
          body: JSON.stringify({
            mcpServerId: server.id,
            allowedTools: patterns,
            autoAllowReadOnly: readOnly,
          }),
        }),
      "Saved.",
    );
    if (ok) await reload();
  }

  /** Take the server away from the bot. */
  async function onRemove() {
    const ok = await save(
      () =>
        apiFetch(
          `/project/${projectId}/bot/${bot.id}/mcp-server/${server.id}`,
          {
            method: "DELETE",
          },
        ),
      `Removed ${server.name}.`,
    );
    if (ok) await reload();
  }

  const allowances =
    preview.state === "loaded" && tools
      ? new Map(
          previewAllowances(tools, preview.result.matches, readOnly).map(
            (a) => [a.name, a.allowance],
          ),
        )
      : null;
  const runs = allowances
    ? [...allowances.values()].filter((a) => a.runs).length
    : null;

  return (
    <section
      className="bot-tools-server"
      data-testid={`bot-tools-server-${server.name}`}
      aria-label={server.name}
    >
      <header className="bot-tools-server-head">
        <McpStatusGlyph status={server.status} enabled={server.enabled} />
        <span className="bot-tools-server-name">{server.name}</span>
        <span className="text-meta tabular">
          {toolCountLabel(server.toolCount)}
        </span>
        <GatedButton
          size="sm"
          variant="outline-danger"
          className="bot-tools-remove"
          disabled={busy}
          deniedReason={denied}
          onClick={onRemove}
          aria-label={`Remove ${server.name} from ${bot.name}`}
          data-testid={`bot-tools-remove-${server.name}`}
        >
          Remove
        </GatedButton>
      </header>
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid={`bot-tools-error-${server.name}`}
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid={`bot-tools-notice-${server.name}`}
        >
          {notice}
        </Alert>
      )}
      <div className="bot-tools-server-body">
        <div className="bot-tools-patterns">
          <Form.Group
            controlId={`bot-tools-patterns-${server.id}`}
            className="mb-0"
          >
            <Form.Label>Runs without asking</Form.Label>
            <Form.Control
              as="textarea"
              rows={4}
              size="sm"
              className="mono"
              placeholder={`${server.name}/read_inbox\n${server.name}/*`}
              value={text}
              disabled={locked}
              title={denied}
              onChange={(e) => {
                setText(e.target.value);
                setNotice(null);
              }}
              data-testid={`bot-tools-patterns-${server.name}`}
            />
            <Form.Text className="text-meta">
              One pattern a line: <span className="mono">server/tool</span>,{" "}
              <span className="mono">server/*</span>,{" "}
              <span className="mono">*/tool</span>, or{" "}
              <span className="mono">/regex/</span>. Empty means every call
              waits for approval.
            </Form.Text>
          </Form.Group>
          <Form.Check
            type="switch"
            id={`bot-tools-read-only-${server.id}`}
            label="Run tools the server marks read-only without asking"
            checked={readOnly}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setReadOnly(e.target.checked);
              setNotice(null);
            }}
            data-testid={`bot-tools-read-only-${server.name}`}
          />
          {readOnly && (
            <Alert
              variant="warning"
              className="mb-0"
              data-testid={`bot-tools-read-only-warning-${server.name}`}
            >
              Read-only is the server's own claim about its tools. Hypotenuse
              cannot check it: turn this on only for a server you trust to label
              its tools honestly.
            </Alert>
          )}
          <div>
            <GatedButton
              size="sm"
              variant="primary"
              disabled={busy || !changed || preview.state === "invalid"}
              deniedReason={denied}
              onClick={onSave}
              data-testid={`bot-tools-save-${server.name}`}
            >
              Save
            </GatedButton>
          </div>
        </div>
        <div
          className="bot-tools-preview"
          data-testid={`bot-tools-preview-${server.name}`}
        >
          <div className="bot-tools-preview-head">
            <span>Preview</span>
            {runs !== null && tools && (
              <span
                className="text-meta tabular"
                data-testid={`bot-tools-preview-count-${server.name}`}
              >
                {runs} of {toolCountLabel(tools.length)} run without asking
              </span>
            )}
          </div>
          {preview.state === "invalid" && (
            <Alert
              variant="danger"
              className="mb-2"
              data-testid={`bot-tools-pattern-error-${server.name}`}
            >
              {preview.message}
            </Alert>
          )}
          {tools === null ? (
            <p className="text-meta">Loading its tools…</p>
          ) : (
            <ToolCatalog
              tools={tools}
              trailing={(tool) => (
                <AllowanceChip allowance={allowances?.get(tool.name)} />
              )}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Whether a tool would run unasked, and why — or that it waits.
 * @param props.allowance - The preview's answer, or `undefined` while it is asked.
 * @returns The chip.
 */
function AllowanceChip({
  allowance,
}: {
  allowance: ToolAllowance | undefined;
}) {
  if (!allowance) return null;
  if (allowance.runs) {
    return (
      <Chip
        className="mcp-chip-runs"
        data-allowance="runs"
        title={
          allowance.via === "pattern"
            ? `Allowed by ${allowance.pattern}`
            : "Allowed because the server marks it read-only"
        }
      >
        {allowance.via === "pattern" ? "Runs" : "Runs · read-only"}
      </Chip>
    );
  }
  return (
    <Chip className="mcp-chip-waits" data-allowance="waits">
      Waits for approval
    </Chip>
  );
}
