import { Link } from "react-router-dom";
import {
  AgentBadge,
  Avatar,
  Button,
  CapacityBar,
  Card,
  Chip,
  PresenceDot,
  RoleChip,
} from "../../ui";
import {
  availableAgents,
  capacitySegments,
  type HeldSession,
  type ListedRunner,
  presenceOf,
} from "../../utils/runners";
import { relativeTime } from "../NotificationBell";

/** See {@link RunnerCard}. */
export interface RunnerCardProps {
  runner: ListedRunner;
  held: HeldSession[];
  busy: boolean;
  onEdit: (runner: ListedRunner) => void;
  onTogglePause: (runner: ListedRunner) => void;
  onRevoke: (runner: ListedRunner) => void;
}

/**
 * One runner as a card: name, owner, presence, version, the capacity bar
 * whose filled segments link to the sessions they hold, agents, roles,
 * repositories, and the last heartbeat. Manage controls only for its owner
 * or an admin (`standing.canManage`, the server's answer).
 * @param props - See {@link RunnerCardProps}.
 * @returns The card.
 */
export function RunnerCard({
  runner,
  held,
  busy,
  onEdit,
  onTogglePause,
  onRevoke,
}: RunnerCardProps) {
  const stranded = runner.status === "offline" && held.length > 0;
  return (
    <Card
      className={stranded ? "runner-card runner-card-stranded" : "runner-card"}
      data-testid={`runner-card-${runner.id}`}
    >
      <Card.Body>
        <div className="runner-card-head">
          <PresenceDot presence={presenceOf(runner.status)} />
          <strong>{runner.name}</strong>
          {!runner.enabled && <Chip>Paused</Chip>}
          {runner.owner && <Avatar name={runner.owner.name} />}
          <span className="text-meta">
            {runner.daemonVersion ? `v${runner.daemonVersion}` : ""}
            {runner.platform ? ` · ${runner.platform}` : ""}
          </span>
        </div>
        <CapacityBar
          label="Slots"
          segments={capacitySegments(runner, held)}
          data-testid={`runner-capacity-${runner.id}`}
        />
        {stranded && (
          <p
            className="runner-card-alert"
            data-testid={`runner-stranded-${runner.id}`}
          >
            Went offline holding{" "}
            {held.map((h, i) => (
              <span key={h.id}>
                {i > 0 && ", "}
                <Link to={`/sessions/${h.id}`}>
                  {h.issueIdentifier ?? `#${h.id}`}
                </Link>
              </span>
            ))}
            .
          </p>
        )}
        <div className="runner-card-chips">
          {availableAgents(runner).map((agent) => (
            <AgentBadge key={agent} kind={agent} />
          ))}
          {runner.roles.map((role) => (
            <RoleChip key={role} role={role} />
          ))}
          {runner.repositories.map((repo) => (
            <Chip key={repo.remote}>
              {repo.remote.split("/").slice(-2).join("/")}
            </Chip>
          ))}
        </div>
        <div className="runner-card-foot">
          <span className="text-meta tabular">
            {runner.lastHeartbeatAt === null
              ? "never heartbeated"
              : `last heartbeat ${relativeTime(runner.lastHeartbeatAt)}`}
          </span>
          {runner.standing?.canManage && (
            <span className="runner-card-actions">
              <Button
                size="sm"
                variant="link"
                disabled={busy}
                onClick={() => onEdit(runner)}
                data-testid={`rename-runner-${runner.id}`}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="link"
                disabled={busy}
                onClick={() => onTogglePause(runner)}
                data-testid={`pause-runner-${runner.id}`}
              >
                {runner.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="outline-danger"
                disabled={busy}
                onClick={() => onRevoke(runner)}
                data-testid={`revoke-runner-${runner.id}`}
              >
                Revoke
              </Button>
            </span>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}
