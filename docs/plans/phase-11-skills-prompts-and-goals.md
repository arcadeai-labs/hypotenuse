# Phase 11 — Skills, prompts, and goals

> **Goal:** A bot's character and purpose are structured data that people can edit, and that the bot can edit
> within limits. Its prompt is assembled from sections that load always or only when relevant. A project shares
> a library of skills (reusable, parameterized procedures) among its bots. Each bot has goals it works toward
> and reviews. Every change to what the model was told is visible in the transcript of the step it applied to.

> **Status: planned, not built.** Builds on [model providers and bots](./phase-07-model-providers-and-bots.md)
> (the bot row, its identity and first instructions), the [durable agent loop](./phase-08-durable-agent-loop.md)
> (the prompt assembler stub, `promptHash`, `context_update` entries), and
> [shared MCP servers](./phase-10-shared-mcp-servers.md) (the generated capabilities text).

[07](./phase-07-model-providers-and-bots.md) gives a bot a name, an identity, and the text that tells it who it
is. That is enough to talk, and not enough to run a team agent for months. A support bot and an engineering bot
in the same project should share how the company writes release notes, but not their personas. A bot that
learns "this team calls staging *preprod*" should be able to write that down where it shapes every future turn,
without being able to rewrite its own guardrails. And when a bot behaves differently on Tuesday, someone has to
be able to see which words changed.

Botholomew solved most of this for one person: prompt files with `loading: always | contextual` and an
`agent-modification` flag, skills as parameterized markdown, and goals the agent edits itself
([`docs/prompts.md`](https://github.com/evantahler/botholomew/blob/main/docs/prompts.md),
[`docs/skills.md`](https://github.com/evantahler/botholomew/blob/main/docs/skills.md)). This phase moves those
into tables with versions, RBAC, and audit, and adds the part a shared service needs: the rendered prompt is
hashed per step, so a transcript records exactly what the model saw (pi-durable's rule).

## Scope

**In:**

1. `prompt_sections`: per-bot sections, plus project-wide sections that every bot includes. Each has
   `loading` (`always` or `contextual`), `keywords`, `agentEditable`, `position`, and versions in
   `prompt_section_versions`.
2. `goals`: per bot, each `active`, `achieved`, or `dropped`, with a priority, notes, and a review cadence.
3. `skills` (project library) and `bot_skills` (attachment). A skill has a name, description, `arguments[]`, a
   template body, and versions.
4. **The prompt assembler:** fixed order, contextual matching, size budget, and a rendered hash per step. A
   `context_update` entry carries the section ids and versions that changed.
5. Model tools:
   - `prompt_list`, `prompt_read`, `prompt_edit`, `prompt_create`, limited to agent-editable sections of the
     bot's own prompt;
   - `goal_list`, `goal_update`;
   - `skill_list`, `use_skill`.
6. A person invoking a skill from a channel: a message that starts `/<skill-name>` expands the template as the
   turn's instruction.
7. The *capabilities* section from [10](./phase-10-shared-mcp-servers.md) and a fixed *style rules* section.
8. Human actions, the bot editor's Prompt, Goals, and Skills tabs, CLI commands, and user docs.
9. Migrating [07](./phase-07-model-providers-and-bots.md)'s instruction text and goals into rows of these tables.

**Out:**

- Reflection loops ("dreaming"). Botholomew's field notes found they "fixate on themes rather than facts". Facts
  go to memory through [09](./phase-09-memory.md)'s consolidation instead.
- Bots editing skills. Skills are shared, so a bot editing one changes every bot that uses it; skills are written
  by people.
- Scheduled goal reviews: [20](./phase-20-schedules.md). This phase reviews goals at turn start and on demand.
- Import and export of a bot's whole configuration as a file. That belongs with the CLI's dump/apply, after
  [21](./phase-21-dashboard.md).

## What already exists

| Thing | Where | Use here |
|---|---|---|
| botholomew's prompt files | [`docs/prompts.md`](https://github.com/evantahler/botholomew/blob/main/docs/prompts.md), [`src/worker/prompt.ts`](https://github.com/evantahler/botholomew/blob/main/src/worker/prompt.ts) | Strict frontmatter (title, loading, agent-modification), contextual loading by keyword overlap, fixed appended sections (the store's instructions, style rules), and a `context_update` interaction logged on every self-edit |
| botholomew's skills | [`docs/skills.md`](https://github.com/evantahler/botholomew/blob/main/docs/skills.md) | `name`, `description`, `arguments[]` with `required` and `default`; `$1`, `$ARGUMENTS`, `$<name>` substitution; the last positional argument takes the rest |
| botholomew's line patches | [`src/fs/patches.ts`](https://github.com/evantahler/botholomew/blob/main/src/fs/patches.ts) | One `LinePatchSchema` for every edit tool, shared with `memory_edit` |
| botholomew's capabilities | [`docs/tools.md`](https://github.com/evantahler/botholomew/blob/main/docs/tools.md) | An LLM-written, thematic summary with tool names deliberately left out |
| pi-durable's prompt sections | [the post](https://earendil.com/posts/pi-durable/) | Sections are rebuilt before each request and changes are recorded in the transcript, so replays and forks see what the model saw |
| ToolExec's component registries | [`docs/plans/phase-07-agent-management.md`](https://github.com/arcadeai-labs/toolexec/blob/main/docs/plans/phase-07-agent-management.md) | Shared, versioned project components attached to agents, with `accessRead`/`accessWrite` inherited from the agent |

## What this must not weaken

1. **A bot can edit only what a person marked `agentEditable`, and only on itself.** Project-wide sections,
   skills, identity, and safety sections are never writable by a tool.
2. **Every version is kept.** A self-edit is a new version with the conversation and entry that caused it. A
   person can see and revert it.
3. **The model never sees a prompt the transcript cannot reproduce.** Each step's `promptHash` resolves, through
   the section versions recorded in the nearest `context_update`, to the exact text sent.
4. **Prompt assembly does not call a model.** Contextual matching is deterministic, so replay and tests are
   exact. The only model-written section, capabilities, is generated ahead of time and stored.

## Design

### 1. Sections

A section is a titled markdown body with:

- `loading`:
  - `always`: included in every step.
  - `contextual`: included when its keywords overlap the turn's *context terms*. Those are the words longer
    than 3 characters in the conversation title, the latest inbound message, and the channel name, with stop
    words removed (botholomew's `extractKeywords`). `keywords` defaults to the section's title words and can be
    set explicitly.
- `agentEditable`: whether `prompt_edit` may change it.
- `position`: ordering within its group.
- `scope`: `bot` (with `botId`) or `project` (included in every bot's prompt).

A new bot gets seed sections, as botholomew's `init` seeds files:

- *Identity*: always, not editable.
- *How I work*: always, editable.
- *Things I have learned*: always, editable.

Their text comes from [07](./phase-07-model-providers-and-bots.md)'s fields, migrated here.

### 2. Assembly order

`PromptOps.assemble(bot, conversation)` returns `{system, sections: [{id, version}], hash}`:

| # | Part | Source | Editable by the bot |
|---|---|---|---|
| 1 | Identity | the bot's name, its platform identity in this channel ("You are @acme-support in Slack #billing"), and the *Identity* section | no |
| 2 | Project sections (`always`) | `prompt_sections` with scope `project` | no |
| 3 | Bot sections (`always`) | `prompt_sections` with scope `bot` | per section |
| 4 | Contextual sections that matched | both scopes | per section |
| 5 | Goals | active `goals`, by priority, with notes | through `goal_update` only |
| 6 | Skills index | name and one-line description of each attached skill | no |
| 7 | Capabilities | [10](./phase-10-shared-mcp-servers.md)'s generated summary | no |
| 8 | Channel context | platform, channel, conversation title, participant display names, the interactive surface's capabilities ([13](./phase-13-channel-framework.md)) | no |
| 9 | Tool primers | short fixed text for memory, MCP, code mode, and terminal tools ("End every turn with `reply_and_wait`, …") | no |
| 10 | Style rules | fixed anti-sycophancy and brevity rules, from botholomew's `STYLE_RULES` | no |

- **Budget.** The system prompt has a token budget (`bots.promptBudgetTokens`, 8 000 by default). Contextual
  sections are dropped lowest-position first until it fits, and each drop is noted in the `context_update`.
  `always` sections are never dropped; a bot whose `always` sections exceed the budget is refused at save time
  with a message.
- **Hash and transcript.** The hash is sha256 of the final system text. When it differs from the previous step's
  `promptHash`, the tick writes a `context_update` entry: `{added: [{id, version}], removed: [...], changed:
  [...]}`.

### 3. Self-editing

| Tool | Replay | Does |
|---|---|---|
| `prompt_list` | safe | Lists the bot's sections: id, title, loading, editable |
| `prompt_read` | safe | Returns a section's body with line numbers, and its version |
| `prompt_edit` | unsafe | Applies `patches: LinePatch[]` against `baseVersion` to an `agentEditable` bot section |
| `prompt_create` | unsafe | Creates a new bot section, always `agentEditable` and `contextual` by default. Capped at `bots.maxAgentSections` (10) |

- Each edit writes a `prompt_section_versions` row with `source: "agent"`, plus `conversationId` and `entryId`.
  The next step's `context_update` shows the change. That is an unaudited machine write, recorded in the
  transcript and the version row, on [05](./phase-05-audit-logging.md)'s closed list.
- A person reverts with `prompt-section:revert`, which is audited.
- `prompt_edit` on a non-editable section returns an error naming who can change it.

### 4. Goals

A goal has `title`, `description`, `status`, `priority` (`low`, `medium`, or `high`), `notes`, `reviewEvery`
(an interval, optional), and `lastReviewedAt`.

- People create and edit goals.
- The bot reads its goals in the prompt. It can update `status` and `notes` with `goal_update`, the edit
  botholomew allows on its own `goals.md`.
- It cannot create, delete, or retitle goals.
- When a goal's review is due, the turn's prompt includes "Review goal …". [20](./phase-20-schedules.md) can
  start a turn for it.

### 5. Skills

- A skill is a project-wide procedure:

  ```yaml
  name: release-notes
  description: Write release notes from merged pull requests
  arguments:
    - { name: since, description: "date or tag", required: true }
    - { name: audience, required: false, default: "customers" }
  ```

  Its body is a template using `$1`, `$ARGUMENTS`, and `$<name>`.
- A bot sees attached skills in its prompt index. It calls `use_skill(name, arguments)`, which returns the
  rendered body as the tool result. The model then follows it within the same turn. `use_skill` is replay-safe.
- A person can start a turn with a skill: a message whose text starts `/<name> args…` (after the bot's mention,
  if any) is expanded before delivery. The transcript keeps the original message and adds the expansion as a
  `context_update`.
- Skills are versioned. Attaching a skill attaches the latest version unless `pinnedVersion` is set.
- Edits need the project's `admin`, or the skill's `accessWrite` tags.

## Schema sketch

```ts
// backend/schema/prompt_sections.ts
prompt_sections: id serial pk, projectId, scope text ('bot'|'project'), botId int null,
  key text,                                   // unique (projectId, coalesce(botId,0), key)
  title text, loading text ('always'|'contextual'), keywords jsonb default '[]',
  agentEditable bool, position int, currentVersion int, archived bool default false,
  createdAt tstz, updatedAt tstz

prompt_section_versions: id serial pk, sectionId, version int, body text,
  source text ('person'|'agent'|'seed'|'revert'), userId int null,
  conversationId int null, entryId int null, changeNote text null, createdAt tstz
  unique (sectionId, version)

// backend/schema/goals.ts
goals: id serial pk, projectId, botId, title text, description text,
  status text ('active'|'achieved'|'dropped'), priority text, notes text default '',
  reviewEvery interval null, lastReviewedAt tstz null, position int,
  createdByUserId int, createdAt tstz, updatedAt tstz

// backend/schema/skills.ts
skills: id serial pk, projectId, name text,     // unique (projectId, name)
  description text, arguments jsonb, currentVersion int,
  accessRead jsonb default '[]', accessWrite jsonb default '[]', createdAt tstz, updatedAt tstz
skill_versions: id serial pk, skillId, version int, body text, arguments jsonb,
  userId int, changeNote text null, createdAt tstz

// backend/schema/bot_skills.ts
bot_skills: id serial pk, botId, skillId, pinnedVersion int null, createdAt tstz  // unique (botId, skillId)
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `prompt-section:create` | `PUT /prompt-section` | bot scope: `canWriteBot`; project scope: admin | yes | yes |
| `prompt-section:edit` | `POST /prompt-section/:id` | same | yes | yes |
| `prompt-section:revert` | `POST /prompt-section/:id/revert` | same | yes | yes |
| `prompt-section:delete` | `DELETE /prompt-section/:id` | same | yes | yes |
| `prompt-section:list` / `view` / `versions` | `GET …` | `canReadBot` (project sections: member) | yes | no |
| `prompt:preview` | `GET /bot/:id/prompt-preview` | `canReadBot` | yes | no |
| `goal:create` / `edit` / `delete` | `PUT` / `POST` / `DELETE /goal…` | `canWriteBot` | yes | yes |
| `goal:list` / `view` | `GET …` | `canReadBot` | yes | no |
| `skill:create` / `edit` / `delete` | `PUT` / `POST` / `DELETE /skill…` | admin or the skill's `accessWrite` | yes | yes |
| `skill:list` / `view` / `versions` | `GET …` | member, filtered by `accessRead` | yes | no |
| `bot-skill:attach` / `detach` | `PUT` / `DELETE /bot/:id/skill` | `canWriteBot` and `skill.accessRead` | yes | yes |

`prompt:preview` takes a sample message and returns the assembled system prompt, the sections included and
dropped, and the hash. It is what the editor shows, and what a person uses to debug "why did it say that".

## Frontend and user docs

- **Bot → Prompt tab:**
  - sections in assembly order, with loading badges and an "editable by the bot" toggle;
  - version history per section with a diff, and agent edits marked with a link to their conversation;
  - a preview pane backed by `prompt:preview`.
- **Bot → Goals tab.**
- **Project → Skills library,** and **Bot → Skills** (attach, pin).
- **The transcript** renders `context_update` entries as a compact "prompt changed" row that expands to the
  diff.
- **User docs:** `frontend/src/content/docs/{prompts,goals,skills}.md`.
- **CLI:** `hypotenuse prompt list|view|edit|preview`, `hypotenuse goal …`, `hypotenuse skill …`.

## Steps

### 1. Schema and migration — `backend/schema/{prompt_sections,goals,skills,bot_skills}.ts`, `backend/drizzle/*`

The migration turns each existing bot's instruction text into seed sections.

### 2. Assembler — `backend/ops/PromptOps.ts`

`assemble`, `contextTerms`, `fitBudget`, `hash`, `diffSections`. Replaces [08](./phase-08-durable-agent-loop.md)'s
stub.

### 3. Ops — `backend/ops/{PromptSectionOps,GoalOps,SkillOps}.ts`

`renderSkill` implements the substitution rules; `serializeX` for each.

### 4. Tools — `backend/tools/{prompt-list,prompt-read,prompt-edit,prompt-create,goal-list,goal-update,skill-list,use-skill}.ts`

### 5. Inbound skill expansion — `backend/ops/InboxOps.ts`

`/<name>` detection at delivery.

### 6. Actions — `backend/actions/{prompt-section,goal,skill,bot-skill}/*.ts`, `backend/actions/prompt/prompt-preview.ts`

### 7. Frontend, CLI, docs — as above

## Test plan

- `__tests__/prompt/assemble.test.ts`:
  - The exact order.
  - Contextual sections in and out by keyword.
  - The budget drops contextual sections and records it.
  - An `always` overflow is refused at save.
  - The hash is stable across processes.
- `__tests__/prompt/transcript.test.ts`:
  - An edit between two steps produces one `context_update` with the right versions.
  - The model server's recorded request for the second step contains the new text.
  - Replaying a transcript's prompt from the recorded versions reproduces the hash.
- `__tests__/prompt/self-edit.test.ts`:
  - `prompt_edit` on an editable section succeeds, and records `source: agent` with provenance.
  - Editing a non-editable or project section is refused with the hint.
  - A stale `baseVersion` is refused.
  - `prompt_create` is capped.
- `__tests__/goals.test.ts`: `goal_update` changes only status and notes; RBAC and audit for the human actions.
- `__tests__/skills.test.ts`:
  - Substitution: `$1`, `$ARGUMENTS`, `$name`, defaults, a missing required argument giving an error envelope,
    and the last positional argument taking the rest.
  - `use_skill` for attached skills only.
  - Pinned versions.
  - A `/release-notes since:v2` message expands.
- `__tests__/actions/{prompt-section,goal,skill}.test.ts`: RBAC, audit, and pagination for every list.

## Verification

```bash
cd backend && bun test __tests__/prompt __tests__/goals.test.ts __tests__/skills.test.ts
bun run --cwd cli hypotenuse prompt preview --bot 1 --message "how do we deploy?"
```

## Definition of done

- [ ] Sections, versions, goals, skills, and attachments are migrated, with existing bots' text moved into seed
      sections.
- [ ] The assembler implements the order, contextual matching, and budget, and records `promptHash` and
      `context_update`.
- [ ] Self-edit tools are limited to editable bot sections, with provenance and person revert.
- [ ] Skills render with botholomew's substitution rules, from `use_skill` and from a `/name` message.
- [ ] `prompt:preview` matches what the tick sends, byte for byte, in a test.
- [ ] The editor tabs, transcript rendering, CLI, and docs ship; both themes are checked.

## Open questions

- Whether contextual matching should use embeddings (the memory embedder) instead of keyword overlap. Keyword
  matching is deterministic and testable; revisit if people report misses.
- Whether project sections should be overridable per bot. The proposal: no; a bot section can only add.

## Learnings from the build

Not built yet.
