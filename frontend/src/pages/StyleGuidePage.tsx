import {
  CONVERSATION_STATUS,
  CONVERSATION_STATUS_ORDER,
  conversationStatusFromKey,
  GLYPH_KINDS,
  PLATFORMS,
  SANDBOX_JOB_STATES,
  SANDBOX_JOB_STATUS,
} from "../../../design/states";
import { DetailLayout } from "../components/layouts/DetailLayout";
import { BotSummary } from "../components/surfaces/BotSummary";
import { ConversationList } from "../components/surfaces/ConversationList";
import { DecayMeter } from "../components/surfaces/DecayMeter";
import { MemoryExplorer } from "../components/surfaces/MemoryExplorer";
import { Transcript } from "../components/surfaces/Transcript";
import {
  Alert,
  Avatar,
  Badge,
  BotBadge,
  Button,
  Chip,
  Form,
  GLYPH_COMPONENTS,
  Kbd,
  Mark,
  PlatformChip,
  PropertiesPanel,
  Property,
  SandboxJobGlyph,
  StaleGlyph,
  StatusGlyph,
  UI_VARIANT_TONES,
} from "../ui";
import {
  FIXTURE_BOT,
  FIXTURE_CONVERSATIONS,
  FIXTURE_MEMORY,
  FIXTURE_TRANSCRIPT,
} from "./styleGuideFixtures";

const TONES = [...UI_VARIANT_TONES];

/**
 * One labelled block of the style guide.
 * @param props - Title and content.
 * @returns The section.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sg-section">
      <h3 className="sg-section-title">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Everything the style guide shows, once. Rendered inside each theme container.
 * @returns The content.
 */
function StyleGuideContent() {
  return (
    <>
      <Section title="Buttons">
        <div className="sg-row">
          {TONES.map((tone) => (
            <Button key={tone} variant={tone}>
              {tone}
            </Button>
          ))}
        </div>
        <div className="sg-row">
          {TONES.filter((t) => t !== "link").map((tone) => (
            <Button key={tone} variant={`outline-${tone}`} size="sm">
              {tone}
            </Button>
          ))}
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges and chips">
        <div className="sg-row">
          {TONES.filter((t) => t !== "link").map((tone) => (
            <Badge key={tone} bg={tone}>
              {tone}
            </Badge>
          ))}
        </div>
        <div className="sg-row">
          <Chip>acme/api</Chip>
          <Chip tone="accent">In development</Chip>
          {PLATFORMS.map((platform) => (
            <PlatformChip key={platform} platform={platform} />
          ))}
          <BotBadge name="Ada" />
        </div>
      </Section>

      <Section title="Avatars and keys">
        <div className="sg-row">
          <Avatar name="Grace Hopper" />
          <Avatar name="Ada" bot />
          <Avatar name="Kit" bot size={28} />
          <Kbd keys="mod+k" />
          <Kbd keys="g c" />
          <Kbd keys="?" />
        </div>
      </Section>

      <Section title="Conversation states">
        <div className="sg-row" data-testid="sg-conversation-glyphs">
          {CONVERSATION_STATUS_ORDER.map((key) => (
            <span key={key} className="sg-glyph">
              <StatusGlyph {...conversationStatusFromKey(key)} />{" "}
              {CONVERSATION_STATUS[key].label}
            </span>
          ))}
          <span className="sg-glyph">
            <StaleGlyph /> Lease expired
          </span>
        </div>
        <div className="sg-row">
          {SANDBOX_JOB_STATES.map((state) => (
            <span key={state} className="sg-glyph">
              <SandboxJobGlyph state={state} /> Sandbox ·{" "}
              {SANDBOX_JOB_STATUS[state].label}
            </span>
          ))}
        </div>
        <div className="sg-row">
          {Object.entries(GLYPH_KINDS).map(([kind, { unicode }]) => {
            const Shape = GLYPH_COMPONENTS[kind as keyof typeof GLYPH_KINDS];
            return (
              <span key={kind} className="sg-glyph">
                <Shape size={20} label={kind} />
                <code>{unicode}</code>
              </span>
            );
          })}
        </div>
      </Section>

      <Section title="Alerts">
        {["info", "success", "warning", "danger"].map((tone) => (
          <Alert key={tone} variant={tone}>
            {tone === "info" ? "An" : "A"} {tone} alert says what happened and
            what to do next.
          </Alert>
        ))}
      </Section>

      <Section title="Form controls">
        <Form className="sg-form">
          <Form.Group controlId="sg-name">
            <Form.Label>Bot name</Form.Label>
            <Form.Control placeholder="Ada" />
          </Form.Group>
          <Form.Group controlId="sg-invalid">
            <Form.Label>Daily budget (USD)</Form.Label>
            <Form.Control isInvalid defaultValue="0" />
            <Form.Text>Use at least 1.</Form.Text>
          </Form.Group>
          <Form.Group controlId="sg-model">
            <Form.Label>Model</Form.Label>
            <Form.Select defaultValue="support-default">
              <option value="support-default">support-default</option>
              <option value="fast">fast</option>
            </Form.Select>
          </Form.Group>
          <Form.Check id="sg-check" label="Code mode" defaultChecked />
        </Form>
      </Section>

      <Section title="Conversations">
        <ConversationList conversations={FIXTURE_CONVERSATIONS} />
      </Section>

      <Section title="Transcript">
        <DetailLayout
          title="ENG-142 · Add retry to webhook ingress"
          properties={
            <PropertiesPanel>
              <Property label="State">
                <StatusGlyph state="working" /> Working
              </Property>
              <Property label="Bot">
                <Avatar name="Kit" bot size={18} />
              </Property>
              <Property label="Where">
                <PlatformChip platform="linear" /> ENG
              </Property>
              <Property label="Linear">
                <a href="#session">Session ↗</a>
              </Property>
            </PropertiesPanel>
          }
        >
          <Transcript entries={FIXTURE_TRANSCRIPT} />
        </DetailLayout>
      </Section>

      <Section title="Bot">
        <BotSummary bot={FIXTURE_BOT} />
      </Section>

      <Section title="Memory">
        <MemoryExplorer scopes={FIXTURE_MEMORY} />
        <div className="sg-row" data-testid="sg-decay">
          <span className="text-meta">Decay, as a bar or a glyph:</span>
          {[0.92, 0.55, 0.21].map((freshness) => (
            <span key={freshness} className="sg-glyph">
              <DecayMeter freshness={freshness} />
              <DecayMeter freshness={freshness} variant="glyph" />
            </span>
          ))}
        </div>
      </Section>
    </>
  );
}

/**
 * Every primitive and fixture surface, in both themes side by side, so a
 * reviewer compares light and dark at once. Drawn under the style guide's
 * docs page; each half paints its own theme whatever the reader's is.
 * @returns The page.
 */
export function StyleGuidePage() {
  return (
    <div className="sg-page" data-testid="style-guide">
      {(["light", "dark"] as const).map((theme) => (
        <div
          key={theme}
          className="sg-theme"
          data-theme={theme}
          data-testid={`style-guide-${theme}`}
        >
          <h2 className="sg-title">
            <Mark size={18} label={null} />{" "}
            {theme === "light" ? "Light" : "Dark"}
          </h2>
          <StyleGuideContent />
        </div>
      ))}
    </div>
  );
}
