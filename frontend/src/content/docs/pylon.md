# Pylon

In Pylon, a bot works your support queue **as its own teammate**: it has its own name and icon in Pylon, it reads
new issues, works out an answer from what it remembers about the customer and from your shared tools, and writes
what it found as an **internal note** for your team. **Nothing it writes reaches a customer unless you allow it.**
It remembers each customer company across all of that company's issues.

Connecting a bot takes a few minutes on its page, under **Channels → Platforms → Pylon**, and needs the bot's write
access. A **Pylon admin** creates its token, its webhook, and the Triggers that feed it. Choosing whether the bot may
reply to customers is a **project admin's** decision.

## 1. Set it up in Pylon

**Get the setup** shows, once:

- **the webhook URL** — private to the bot. Copy it now: asking again makes a new URL and stops the old one;
- **the token** to create: in Pylon, **Settings → Integrations & dev → API tokens**, create a token **with its own
  identity**, named after the bot (that name is how your team mentions it and how its notes are signed), with a role
  that may read issues, accounts, and contacts and write internal notes;
- **four Triggers**, each with the body to paste.

Then, as a Pylon admin:

1. **Settings → Integrations & dev → Webhooks → Create Webhook**, pointing at the URL. Pylon shows the webhook's
   **secret** once: copy it.
2. **Settings → Workflows → Triggers**: create the four Triggers — *New issue created*, *Issue has a new message*,
   *Issue assigned*, and *Issue status changed* — each with a **Send webhook** action to that webhook and the body
   shown for it. The bodies carry only ids; the bot reads the issue itself.

## 2. Connect it

Choose the **region** your Pylon organization is in (US or EU), give the token's name, paste the **API token** and
the **webhook secret**, and **Connect**. Hypotenuse asks Pylon who the token is at once: a token from the other
region, or one Pylon refuses, is said in the block. Secrets are stored encrypted and never shown again.

**Test** asks Pylon again. The block shows when the last delivery from Pylon arrived — if there is none, check the
webhook and its Triggers.

![A bot's Pylon block on its Channels section: connected, with its customer reply policy and triggers](illustration:bot-pylon)

## What starts the bot

Each is a setting on the block:

- **Every new issue** (auto-triage) — optionally only issues with certain **tags** or in certain **teams**.
- **An internal note that mentions the bot** by its token's name (`@Ada, which plan are they on?`).
- **An issue assigned to the bot.**

Once the bot works an issue, a new message from the customer continues it. Other internal notes, and your team's own
replies to the customer, are left alone.

## What your team sees

Everything goes in **one internal thread per issue**, named after the bot:

- **"Looking into this."** as soon as it starts;
- **its findings** — what it found and a suggested reply — with the steps it took as a checklist, one note per turn;
- **a pull request** a sandbox job opened, as a note linking it;
- **a question for the team** when it needs one: answer in a note that mentions the bot;
- **an approval request** when it wants to run something that needs a person — answer with a note `approve 41` or
  `deny 41`, or decide in Hypotenuse.

The bot's own notes never wake it.

## Replies to customers

A project admin chooses, on the block:

| Policy | What happens |
|---|---|
| **Never** (the default) | Customers never hear from the bot. It writes notes, with a suggested reply your team can send |
| **With approval** | The bot drafts a reply. It appears as a draft on the issue and in a note quoting it; a teammate writes `approve <number>` (or approves in Hypotenuse) and **exactly that text** is sent |
| **Automatically when low-risk** | The bot's fast model reads each reply first. A plainly informational answer — where a setting is, how to do something — is sent at once; anything about refunds, money, legal or security matters, promises, or an upset customer waits for approval as above. Each reply sent this way is in the audit log as the decision of the admin who chose this policy |

A customer can never approve a reply, whatever they write. Changing the policy is in the audit log.

The bot can also update the issue — its state, tags, assignee, or custom fields — and each update waits for a person
to approve it. Merging issues and marking spam stay with people.

## Memory follows the customer

Each **customer account** is a channel, with its own memory: what the bot learns about a customer on one issue, it
uses on that customer's other issues — and **never** on another customer's. Issues with no account share one channel
of their own. A fact can be promoted to project memory only if it names no customer: a fact that mentions the
customer's name or domain is refused, so write a general version first.

## Stopping the bot

**Closing the issue** stops the bot on it. If the bot was **assigned** the issue, assigning it to someone else stops
it too. From Hypotenuse, cancel the conversation from its page (see
[Stopping a bot](/docs/conversations#stopping-a-bot)).

## Troubleshooting

| Symptom | What to do |
|---|---|
| A new issue does nothing | Is auto-triage on, and is the issue in a listened tag and team? The project's **Events** page shows every delivery and what it decided (`auto-triage-off`, `not-listened`) |
| Nothing arrives at all | The block says no delivery was received: check the webhook's URL and that each Trigger sends to it |
| Connecting says the token belongs to the other region | Choose the other region and connect again |
| A mention is ignored | The note must name the bot as its token is named in Pylon (the block shows the name); Events shows `note-not-addressed` |
| Notes arrive slowly in a burst | Pylon allows 30 notes a minute; the bot spaces them out rather than lose any |

Every step — connecting, the policy, and every approval decided in a note — is in the [audit log](/docs/audit), with
the secrets left out. From the command line, the same steps are `hypotenuse pylon setup|connect|settings` (see
[the CLI](/docs/cli#platforms-and-channels-from-the-command-line)).
