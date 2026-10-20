# Audit log

The audit log answers *who changed what, and when*. Every action that changes something a person decided —
renaming a project, inviting someone, granting a tag, removing a member — writes one audit row **in the same database
transaction** as the change. If the change did not happen, neither did the row; if the row is there, so is the
change.

## Reading it

Admins open it from the project switcher (**Audit log**) or with **Open audit log** in ⌘K. Members who open it are
told it is for admins.

Each row shows when it happened, who did it, the action, and what it touched. **Details** expands a row into the
fields that changed — before on the left, after on the right — and the parameters the action was called with.

Filter by a date range and by action name; the action box suggests every action the server knows. Changing a filter,
pressing **Reset**, or switching projects starts again on page one.

## What is recorded

- **Recorded:** decisions a person made — creating, editing, or deleting projects, memberships, tags, and
  invitations, accepting or rejecting an invitation, and editing an account.
- **Not recorded:** reads; signing in and out; machine traffic and housekeeping, such as delivering notifications or
  sweeping expired invitations. Those leave their own records where they happen.

Secrets never reach the log. Before a row is written, every parameter whose name marks it as a credential —
passwords, tokens, client secrets, and the like — is removed, however deeply it is nested.

## Retention

Audit rows are kept for **90 days** and then deleted by a daily sweep. A project's audit rows outlive the project
itself until then, so deleting a project does not erase the record of who deleted it.
