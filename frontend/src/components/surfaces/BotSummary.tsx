import { PLATFORM_LABELS, PLATFORMS } from "../../../../design/states";
import {
  Avatar,
  Card,
  Chip,
  PlatformChip,
  PropertiesPanel,
  Property,
} from "../../ui";
import type { BotProfile } from "./types";

/**
 * A yes or no, as a chip: on in the accent tint, off in neutral.
 * @param props - The flag and what it is called.
 * @returns The chip.
 */
function Toggle({ on, label }: { on: boolean; label: string }) {
  return (
    <Chip tone={on ? "accent" : "subtle"} data-on={on}>
      {label} · {on ? "on" : "off"}
    </Chip>
  );
}

/**
 * The bot page's body: identity, where it listens, its tools, its model, and
 * who may read and change it. The avatar always carries the bot badge.
 * @param props - The bot.
 * @returns The summary.
 */
export function BotSummary({ bot }: { bot: BotProfile }) {
  return (
    <div className="bot-summary" data-testid="bot-summary">
      <Card className="bot-identity">
        <Card.Body>
          <Avatar name={bot.name} src={bot.avatar} bot size={40} />
          <p className="bot-persona">{bot.persona}</p>
        </Card.Body>
      </Card>

      <section className="bot-section">
        <h3 className="bot-section-title">Where it listens</h3>
        {PLATFORMS.map((platform) => {
          const here = bot.bindings.filter((b) => b.platform === platform);
          return (
            <div key={platform} className="bot-binding-row">
              <PlatformChip platform={platform} />
              {here.length === 0 ? (
                <span className="text-meta">
                  Not bound in {PLATFORM_LABELS[platform]}
                </span>
              ) : (
                here.map((b) => <Chip key={b.channel}>{b.channel}</Chip>)
              )}
            </div>
          );
        })}
      </section>

      <section className="bot-section">
        <h3 className="bot-section-title">Tools</h3>
        <div className="sg-chips">
          <Toggle on={bot.tools.memory} label="Memory" />
          <Toggle on={bot.tools.codeMode} label="Code mode" />
          <Toggle on={bot.tools.sandboxes} label="Sandboxes" />
        </div>
        <PropertiesPanel>
          <Property label="MCP servers">
            {bot.tools.mcpServers.join(", ") || "None"}
          </Property>
          <Property label="Skills">
            {bot.tools.skills.join(", ") || "None"}
          </Property>
          <Property label="Model">
            {bot.model.name}{" "}
            <span className="text-meta">via {bot.model.connection}</span>
          </Property>
          <Property label="Who may read">
            {bot.accessRead.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </Property>
          <Property label="Who may change">
            {bot.accessWrite.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </Property>
        </PropertiesPanel>
      </section>
    </div>
  );
}
