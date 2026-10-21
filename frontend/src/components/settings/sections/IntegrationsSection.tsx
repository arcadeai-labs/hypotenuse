import type { IntegrationList } from "@backend/actions/integration/integration-list";
import type { TriggerType } from "@backend/schema/integrations";
import type { ActionResponse } from "keryx";
import { type ComponentType, useEffect, useState } from "react";
import { apiFetch } from "../../../utils/client";
import { useProjectSettings } from "../context";
import LinearIntegrationCard from "./LinearIntegrationCard";

/**
 * The card each kind of integration renders, keyed by its trigger type.
 * Typed as a complete record, so a type the backend adds without a card here
 * fails `tsc` rather than vanishing from Settings.
 */
export const INTEGRATION_CARDS: Record<TriggerType, ComponentType> = {
  linear: LinearIntegrationCard,
};

/**
 * Settings → Integrations: where a project connects the systems that start
 * agent work. Linear is the first kind; each kind gets its own card.
 *
 * Which kinds to show comes from `integration:list`'s `types` — every type the
 * deployment knows — so a server that knows a type this frontend has no card
 * for simply does not show it. Until that answer arrives (or if it fails), every
 * card this frontend knows renders; each card loads and reports on its own.
 * @returns The rendered section.
 */
export default function IntegrationsSection() {
  const { projectId } = useProjectSettings();
  const [types, setTypes] = useState<TriggerType[] | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<ActionResponse<IntegrationList>>(
      `/integrations?projectId=${projectId}`,
    )
      .then((answer) => {
        if (live) setTypes(answer.types.map((t) => t.type));
      })
      .catch(() => {
        if (live) setTypes(null);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const shown = (
    types ?? (Object.keys(INTEGRATION_CARDS) as TriggerType[])
  ).filter((type) => type in INTEGRATION_CARDS);

  return (
    <div className="d-flex flex-column gap-3" data-testid="integrations">
      {shown.map((type) => {
        const Card = INTEGRATION_CARDS[type];
        return <Card key={type} />;
      })}
    </div>
  );
}
