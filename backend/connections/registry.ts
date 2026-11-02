import type { ProviderConnection } from "../sandbox/types";
import { probeVercel } from "./probes/vercel";

/** One non-secret field a connection kind takes. */
export interface ConnectionField {
  /** The key in the connection's `config`, and the action input's name. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** What to enter, and where to find it. */
  description: string;
  /** A pattern the value must match, with what it means. */
  pattern?: { regex: RegExp; hint: string };
}

/**
 * A kind of `project_connections` row: what it is, the fields it takes, its
 * secret, and how to prove it works. Adding a kind is an entry here and a
 * probe in `probes/`; the actions and the settings page read this.
 */
export interface ConnectionDefinition {
  /** The registry key, stored in `project_connections.kind`. */
  kind: string;
  /** Human-readable name. */
  label: string;
  /** One line on what it connects. */
  description: string;
  /** The secret's label, e.g. "Access token". */
  secretLabel: string;
  /** Where to get the secret. */
  secretDescription: string;
  /** The non-secret fields, in the order a form shows them. */
  fields: ConnectionField[];
  /**
   * Prove the connection reaches its service, without creating anything.
   * @returns A sentence on what it found.
   * @throws {TypedError} The service's refusal, with no secret in it.
   */
  probe(connection: ProviderConnection): Promise<string>;
}

/** Every connection kind, by kind. */
export const CONNECTION_DEFINITIONS: Record<string, ConnectionDefinition> = {
  vercel: {
    kind: "vercel",
    label: "Vercel",
    description:
      "A Vercel team and project that sandbox jobs run in, as Vercel Sandboxes billed to that team.",
    secretLabel: "Access token",
    secretDescription:
      "A Vercel access token scoped to the team (Account Settings → Tokens). Stored encrypted; never shown again.",
    fields: [
      {
        key: "teamId",
        label: "Team id",
        description: "The team's id, under Team Settings → General (team_…).",
        pattern: { regex: /^team_[A-Za-z0-9]+$/, hint: "a team id, team_…" },
      },
      {
        key: "projectId",
        label: "Project id",
        description:
          "The Vercel project sandboxes belong to, under Project Settings → General (prj_…).",
        pattern: { regex: /^prj_[A-Za-z0-9]+$/, hint: "a project id, prj_…" },
      },
    ],
    probe: probeVercel,
  },
};

/** The registered connection kinds. */
export const CONNECTION_KINDS = Object.keys(CONNECTION_DEFINITIONS);

/**
 * Describe the kinds for an answer: everything but the probe.
 * @returns One entry per kind.
 */
export function describeConnectionKinds() {
  return CONNECTION_KINDS.map((kind) => {
    const d = CONNECTION_DEFINITIONS[kind];
    return {
      kind: d.kind,
      label: d.label,
      description: d.description,
      secretLabel: d.secretLabel,
      secretDescription: d.secretDescription,
      fields: d.fields.map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description,
      })),
    };
  });
}
