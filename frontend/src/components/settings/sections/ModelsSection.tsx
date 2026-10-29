import type { ModelConnectionList } from "@backend/actions/model-connection/model-connection-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { AliasesCard } from "../../models/AliasesCard";
import {
  ConnectionsCard,
  type ModelConnection,
} from "../../models/ConnectionsCard";
import { useProjectSettings } from "../context";

/**
 * Settings → Models: the project's model connections, then the names bots
 * choose models by. Every member reads both; the controls are an admin's, and
 * a member sees them disabled with the reason.
 *
 * The connections are read here rather than in their card because the model
 * names' form offers them too, and a connection added above should be
 * choosable below without a reload.
 * @returns The section.
 */
export function ModelsSection() {
  const { projectId, reason } = useProjectSettings();
  const [connections, setConnections] = useState<ModelConnection[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<ActionResponse<ModelConnectionList>>(
        `/project/${projectId}/model-connections?limit=100`,
      );
      setConnections(res.modelConnections);
      setLoadError(null);
    } catch (err) {
      setConnections((current) => current ?? []);
      setLoadError(
        err instanceof Error ? err.message : "Could not load connections.",
      );
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div data-testid="settings-models">
      {loadError && (
        <Alert variant="danger" data-testid="model-connections-load-error">
          {loadError}
        </Alert>
      )}
      <ConnectionsCard
        projectId={projectId}
        connections={connections}
        reload={reload}
        reason={reason}
      />
      <AliasesCard
        projectId={projectId}
        connections={connections}
        reason={reason}
      />
    </div>
  );
}
