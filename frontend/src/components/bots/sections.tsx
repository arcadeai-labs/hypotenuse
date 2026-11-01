import type { ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import { botWriteDenied } from "../../utils/bots";
import { AccessSection } from "./AccessSection";
import { ApprovalSettingsSection } from "./ApprovalSettingsSection";
import { BudgetSection } from "./BudgetSection";
import { CallbackSecretSection } from "./CallbackSecretSection";
import { ChannelsSection } from "./ChannelsSection";
import { CodeSection } from "./CodeSection";
import type { Bot, BotStanding, useAccessTags, useModelAliases } from "./data";
import { GoalsSection } from "./GoalsSection";
import { IdentitySection } from "./IdentitySection";
import { ListeningSection } from "./ListeningSection";
import { MemorySection } from "./MemorySection";
import { ModelSection } from "./ModelSection";
import { PromptSettingsSection } from "./PromptSettingsSection";
import { SandboxSection } from "./SandboxSection";
import { SkillsSection } from "./SkillsSection";
import { ToolsSection } from "./ToolsSection";

/**
 * What the bot page hands every section, through the router's outlet context.
 * The page holds it back until `bot:view` has answered, so a section never
 * renders against a guessed bot or standing.
 */
export interface BotSectionContext {
  /** The active project. */
  projectId: number;
  /** The bot as the server last returned it. */
  bot: Bot;
  /** The caller's standing on this bot, as `bot:view` decided it. */
  standing: BotStanding;
  /** Why `bot:edit` is refused for this person on this bot, if it is. */
  editDenied: string | undefined;
  /** Why an action is refused in this project, or `undefined`. */
  reason: (actionName: string) => string | undefined;
  /** Take an edit's answer as the page's bot. */
  onSaved: (answer: { bot: Bot; standing: BotStanding }) => void;
  /** The project's model aliases. */
  aliases: ReturnType<typeof useModelAliases>["data"];
  /** The project's tags, for the access and approval pickers. */
  tags: ReturnType<typeof useAccessTags>;
}

/** Which heading a bot section sits under in the sidebar. */
export type BotSectionGroup = "Bot" | "Behavior" | "Tools" | "Platforms";

/** One entry in the bot page's sidebar: a deep-linked page of cards. */
export interface BotSection {
  /** The URL segment: `/bots/:botId/<slug>`. Never `prompt`, `chat`, `conversations`, or `memory` — those are other pages. */
  slug: string;
  /** What the sidebar calls it. */
  label: string;
  /** The heading it sits under. */
  group: BotSectionGroup;
  /**
   * The cards on this page, in order.
   * @param ctx - The bot page's context.
   * @returns The cards.
   */
  render: (ctx: BotSectionContext) => ReactNode;
}

/**
 * The props every bot-editing card takes.
 * @param ctx - The bot page's context.
 * @returns The shared props.
 */
function editProps(ctx: BotSectionContext) {
  return {
    projectId: ctx.projectId,
    bot: ctx.bot,
    denied: ctx.editDenied,
    onSaved: ctx.onSaved,
  };
}

/**
 * The bot page's sections, in sidebar order. Related cards share a page, so
 * the sidebar stays short and each page fits on a screen.
 */
export const BOT_SECTIONS: readonly BotSection[] = [
  {
    slug: "general",
    label: "General",
    group: "Bot",
    render: (ctx) => (
      <>
        <IdentitySection {...editProps(ctx)} />
        <AccessSection {...editProps(ctx)} tags={ctx.tags} />
      </>
    ),
  },
  {
    slug: "model",
    label: "Model & budget",
    group: "Bot",
    render: (ctx) => (
      <>
        <ModelSection {...editProps(ctx)} aliases={ctx.aliases} />
        <PromptSettingsSection {...editProps(ctx)} />
        <BudgetSection {...editProps(ctx)} />
      </>
    ),
  },
  {
    slug: "goals",
    label: "Goals",
    group: "Behavior",
    render: (ctx) => (
      <GoalsSection
        projectId={ctx.projectId}
        bot={ctx.bot}
        denied={botWriteDenied(ctx.reason("goal:create"), ctx.standing)}
      />
    ),
  },
  {
    slug: "skills",
    label: "Skills",
    group: "Behavior",
    render: (ctx) => (
      <SkillsSection
        projectId={ctx.projectId}
        bot={ctx.bot}
        denied={botWriteDenied(ctx.reason("bot-skill:attach"), ctx.standing)}
      />
    ),
  },
  {
    // Not `memory`: `/bots/:botId/memory` is the old address of the memory
    // explorer, and still redirects there.
    slug: "retention",
    label: "Memory",
    group: "Behavior",
    render: (ctx) => <MemorySection {...editProps(ctx)} />,
  },
  {
    slug: "tools",
    label: "Tools & code",
    group: "Tools",
    render: (ctx) => (
      <>
        <ToolsSection
          projectId={ctx.projectId}
          bot={ctx.bot}
          denied={botWriteDenied(
            ctx.reason("bot-mcp-server:set"),
            ctx.standing,
          )}
        />
        <CodeSection {...editProps(ctx)} />
        <SandboxSection {...editProps(ctx)} />
      </>
    ),
  },
  {
    slug: "approvals",
    label: "Approvals",
    group: "Tools",
    render: (ctx) => (
      <ApprovalSettingsSection {...editProps(ctx)} tags={ctx.tags} />
    ),
  },
  {
    slug: "channels",
    label: "Channels",
    group: "Platforms",
    render: (ctx) => (
      <>
        <ChannelsSection
          projectId={ctx.projectId}
          bot={ctx.bot}
          denied={botWriteDenied(
            ctx.reason("channel-binding:create"),
            ctx.standing,
          )}
          settingsDenied={ctx.reason("pylon:settings-edit")}
        />
        <ListeningSection {...editProps(ctx)} />
      </>
    ),
  },
  {
    slug: "callback",
    label: "Callback",
    group: "Platforms",
    render: (ctx) => (
      <CallbackSecretSection
        {...editProps(ctx)}
        denied={botWriteDenied(
          ctx.reason("bot:rotate-callback-secret"),
          ctx.standing,
        )}
      />
    ),
  },
] as const;

/** The section `/bots/:botId` opens. */
export const DEFAULT_BOT_SECTION = "general";

/**
 * Find a bot section by its slug.
 * @param slug - The URL segment.
 * @returns The section, or `undefined` when there is none by that name.
 */
export function findBotSection(slug: string | undefined) {
  return BOT_SECTIONS.find((section) => section.slug === slug);
}

/**
 * Read the bot page's context inside a section.
 * @returns The context the bot page provides.
 */
export function useBotSection(): BotSectionContext {
  return useOutletContext<BotSectionContext>();
}
