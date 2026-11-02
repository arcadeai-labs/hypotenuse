# Schedules

A schedule lets a bot act without being asked: post a summary of open issues every Monday, check each morning
whether a customer has waited more than a day, review its own goals at the end of the week. **Cron decides when**
the bot wakes; an optional **guard** decides *whether*; and the bot itself decides whether anything is worth saying.

**Schedules** on a bot's page lists them, adds new ones, and shows what each slot did.

![A bot's schedules: one armed with a guard, a goal review, and the form that adds another](illustration:bot-schedules)

## A schedule

| Field | What it is |
|---|---|
| **Name** | a short label for people, e.g. *Monday issue summary* |
| **Kind** | **Follow an instruction**, or **Review its goals** (below) |
| **When (cron)** | five cron fields, read in the time zone — see [Cron](#cron) |
| **Time zone** | the IANA zone the cron is read in, e.g. `Europe/Berlin`. A new schedule starts in yours |
| **Where** | a **channel** (a new conversation there each slot), **one conversation** (a new turn in it), or **nowhere** (memory and goals only) |
| **After downtime** | **Run the latest missed slot once** (the default), or **Skip missed slots** |
| **Instruction** | what the bot should do at each slot, as you would ask it. Optional for a goal review |
| **Guard** | optional: a condition checked before the bot wakes, e.g. *only if there are new P0 issues* |

While you type the cron, the form says what it means in words and shows its next five slots **in your own time
zone**, so a schedule written for Berlin reads correctly from New York.

**Enable** and **Disable** arm and pause a schedule; **Run now** fires it once, outside its cron (its guard and the
checks below still apply — and it works on a disabled schedule, so you can try one before arming it); **Edit**
changes any field; **Delete** removes it and its run history. **Show runs** lists its recent slots.

## Cron

Five fields: minute, hour, day of month, month, day of week (0 or 7 is Sunday).

| Cron | When |
|---|---|
| `0 9 * * 1` | Mondays at 09:00 |
| `0 9 * * 1-5` | weekdays at 09:00 |
| `30 8 1 * *` | the first of every month at 08:30 |
| `0 */4 * * *` | every four hours, on the hour |
| `*/15 * * * *` | every fifteen minutes |

Two slots of one schedule are always at least **five minutes** apart; an expression that would run more often is
refused, and so is one with seconds or no future slot. A bot has at most **ten** schedules, proposals included.

**Daylight saving time** follows the zone: a schedule at 02:30 on the night clocks spring forward runs once, at
03:00; on the night they fall back, a time that happens twice runs once.

## What happens at a slot

1. The bot is woken once per slot — never twice, however many workers run.
2. If the schedule has a **guard**, the bot's [fast model](/docs/models) answers it first, with the bot's goals and
   what it remembers about the place. A *no* skips the slot with the model's reason, and nothing is posted. A guard
   costs one fast-model call per slot, not per step.
3. Otherwise the bot gets a message saying a schedule woke it, with the instruction and its active goals. Where it
   says it depends on **Where**:
   - **A channel**: a new conversation each slot. In Slack, its first message is a new top-level post in the
     channel, and that post's thread is the conversation — reply there and the bot answers as usual. The bot must be
     [bound](/docs/channels) in the channel. Linear projects and Pylon accounts have no place for a conversation of
     their own; schedule one of the bot's conversations there instead.
   - **One conversation**: a new turn in it — a reply in that Slack thread, a note on that Pylon issue, an activity
     on that Linear session while it is open.
   - **Nowhere**: a conversation on the bot's own internal channel, seen only in the dashboard. Useful for memory
     upkeep and goal reviews.

### Silent

A bot woken by a schedule may decide there is nothing worth saying and end its turn **silently**. That is a normal
outcome, not a failure: nothing is posted, and the run says **Nothing to say**. (Only a scheduled turn may end
silently; when a person asked, the bot always answers.)

### Runs

Each slot's run says what happened:

| Status | Meaning |
|---|---|
| **Pending**, **Checking guard** | about to wake the bot |
| **Working** | the bot is on it |
| **Posted** | it said something |
| **Nothing to say** | it ended silently |
| **Skipped** | the guard said no, or the place is no longer one the bot works in — the reason says which |
| **Failed** | the turn failed, or the guard could not answer — the reason says why |

### What a schedule never does

- **It never re-engages what a person stopped.** A conversation someone cancelled, a channel the bot was unbound
  from, an app that was uninstalled, or an archived channel skips the slot, saying so.
- **It never bursts.** After downtime it runs the newest missed slot once, or none.
- **It never arms itself.** See below.

## Goal review

A schedule of the kind **Review its goals** wakes the bot with its active goals and its conversations from the last
seven days, so it can update each goal's status and notes with `goal_update` (see [Goals](/docs/goals)) and post a
summary only if something changed. A weekly review — `0 17 * * 5`, Fridays at 17:00 — is a good start.

## A bot can propose, but not arm

In a conversation, a bot can suggest a schedule for itself (`schedule_propose`) — "shall I post this every Monday?"
A proposal is saved **disabled** and badged **Proposed by** the bot, and it never runs until a person enables it.
The bot can also list its schedules (`schedule_list`). It cannot enable, change, or delete one.

## From the command line

```bash
hypotenuse schedule add --bot ada --name "Monday summary" --cron "0 9 * * 1" --tz Europe/Berlin \
  --target channel --channel 12 --instruction "Summarize the open issues." --guard "only if there are open issues"
hypotenuse schedule list --bot ada
hypotenuse schedule enable 4
hypotenuse schedule run 4
hypotenuse schedule runs 4
```

See [the CLI](/docs/cli).

## Who may change schedules

Anyone who may [change a bot](/docs/bots#who-may-read-and-change-it) may add, edit, enable, run, and delete its
schedules; anyone who may read it sees them and their runs. Every change a person makes — enabling a bot's proposal
above all — is in the project's [audit log](/docs/audit).
