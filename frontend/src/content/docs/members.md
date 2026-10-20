# Members and tags

People get into a project by invitation, and what they may do there is decided by two levels and any tags they
hold.

## Members and admins

There is no ladder of roles. There are two gates:

| Level | Means |
|---|---|
| **Member** | Belongs to the project |
| **Admin** | Belongs to it **and** holds the reserved `admin` tag |

| A member may | Only an admin may |
|---|---|
| see the project, its members, and its tags | rename or delete the project |
| accept or reject invitations addressed to them | invite people, add and remove members |
| read notifications addressed to them | create, rename, and delete tags, and grant or revoke them |
| change their own account | read the audit log |

Signing up makes you the admin of your first project. A project always keeps at least one admin: removing the last
one — or taking the `admin` tag from them — is refused, so there is always someone who can recover it.

## Inviting people

Open **Invites** from the project switcher (or **Invite member** in ⌘K). Enter an email address and, optionally,
tick the tags they should hold. Then:

- the invitation shows up on the **Invites** page of whoever signs in with that email — even if they have no project
  yet;
- they **accept** or **reject** it; accepting adds them to the project with those tags;
- an unanswered invitation **expires after five days**.

The Invites page also lists every invitation the project has sent and where each one stands. Someone who already has
an account can be added straight away under **Settings → Members**.

## Tags

A tag is a project-scoped label for a group of members — `operators`, `reviewers`, `on-call`. Admins create and
delete them under **Settings → Tags**, and grant or revoke them per person under **Settings → Members**.

Tag names are matched trimmed and lowercase. The reserved `admin` tag cannot be created, renamed, or deleted: holding
it is what makes someone an admin.

## How the dashboard decides what to show

`GET /api/actions/permissions` reports, for every action, whether it needs nothing, membership, or admin. The
dashboard reads that map together with your standing in the project, so a button is shown exactly when the server
would accept it. A control you cannot use is hidden; a page you cannot read says so.
