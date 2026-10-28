import { useState } from "react";
import { Chip, ListGroup, ListRow, PlatformChip } from "../../ui";
import { DecayMeter } from "./DecayMeter";
import type { MemoryScope } from "./types";

/**
 * The memory explorer: a scope (the project, or one channel), then a
 * document, then its versions — each with provenance back to the conversation
 * entry that wrote it, and how faded it is.
 * @param props - Every scope, and the decay indicator to draw.
 * @returns The explorer.
 */
export function MemoryExplorer({
  scopes,
  decay = "bar",
}: {
  scopes: MemoryScope[];
  decay?: "bar" | "glyph";
}) {
  const [scopeId, setScopeId] = useState(scopes[0]?.id);
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const [documentId, setDocumentId] = useState(scope?.documents[0]?.id);
  const document =
    scope?.documents.find((d) => d.id === documentId) ?? scope?.documents[0];

  return (
    <div className="memory-explorer" data-testid="memory-explorer">
      <nav className="memory-scopes" aria-label="Memory scopes">
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            className="memory-scope"
            aria-pressed={s.id === scope?.id}
            onClick={() => {
              setScopeId(s.id);
              setDocumentId(s.documents[0]?.id);
            }}
          >
            {s.platform ? <PlatformChip platform={s.platform} /> : null}
            <span>{s.label}</span>
            <span className="text-meta tabular">{s.documents.length}</span>
          </button>
        ))}
      </nav>
      <ListGroup title="Documents" count={scope?.documents.length ?? 0}>
        {scope?.documents.map((d) => (
          <ListRow
            key={d.id}
            title={d.title}
            selected={d.id === document?.id}
            onClick={() => setDocumentId(d.id)}
            trailing={
              <>
                <span className="text-meta tabular">
                  v{d.versions[0]?.version ?? 0}
                </span>
                <DecayMeter freshness={d.freshness} variant={decay} />
              </>
            }
          />
        ))}
      </ListGroup>
      {document && (
        <ol className="memory-versions" aria-label="Versions">
          {document.versions.map((v) => (
            <li key={v.version} className="memory-version">
              <span className="tabular">v{v.version}</span>
              <span className="text-meta">{v.written}</span>
              <span>
                by <strong>{v.bot}</strong> in{" "}
                <a href={v.provenance.href}>{v.provenance.label}</a>
              </span>
              {v.promotedFrom && (
                <Chip tone="accent">Promoted from {v.promotedFrom}</Chip>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
