import type { BotSkillList } from "@backend/actions/bot-skill/bot-skill-list";
import type { GoalList } from "@backend/actions/goal/goal-list";
import type { PromptPreview } from "@backend/actions/prompt/prompt-preview";
import type { PromptSectionList } from "@backend/actions/prompt-section/prompt-section-list";
import type { PromptSectionVersions } from "@backend/actions/prompt-section/prompt-section-versions";
import type { SkillList } from "@backend/actions/skill/skill-list";
import type { SkillVersions } from "@backend/actions/skill/skill-versions";
import type { SkillView } from "@backend/actions/skill/skill-view";
import type { ActionResponse } from "keryx";

/** `prompt-section:list`'s answer. */
export type PromptSectionsResponse = ActionResponse<PromptSectionList>;

/** One prompt section, with its current text, as every section action serializes it. */
export type PromptSection = PromptSectionsResponse["promptSections"][number];

/** `prompt-section:versions`' answer, newest first. */
export type PromptSectionVersionsResponse =
  ActionResponse<PromptSectionVersions>;

/** One version of a section: its title and body then, and who wrote it. */
export type PromptSectionVersion =
  PromptSectionVersionsResponse["versions"][number];

/** `prompt:preview`'s prompt: the text, its hash, and what went into it. */
export type PromptPreviewResult = ActionResponse<PromptPreview>["prompt"];

/** `goal:list`'s answer. */
export type GoalsResponse = ActionResponse<GoalList>;

/** One goal of a bot. */
export type Goal = GoalsResponse["goals"][number];

/** `skill:list`'s answer; each skill carries the caller's `canWrite`. */
export type SkillsResponse = ActionResponse<SkillList>;

/** A row of the project's skill library. */
export type SkillRow = SkillsResponse["skills"][number];

/** `skill:view`'s skill: the row with its current body and `canWrite`. */
export type SkillDetail = ActionResponse<SkillView>["skill"];

/** One argument a skill takes. */
export type SkillArgument = SkillRow["arguments"][number];

/** `skill:versions`' answer, newest first. */
export type SkillVersionsResponse = ActionResponse<SkillVersions>;

/** One version of a skill. */
export type SkillVersion = SkillVersionsResponse["versions"][number];

/** `bot-skill:list`'s answer. */
export type BotSkillsResponse = ActionResponse<BotSkillList>;

/** One skill attached to a bot, with the version it uses. */
export type BotSkill = BotSkillsResponse["botSkills"][number];
