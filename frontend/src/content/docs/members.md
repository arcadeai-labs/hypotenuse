# Members

**Settings → Members** is a project's roster: everyone in it, and the tags each holds. Every member can read it;
admins manage it.

## Adding someone

Who you can add depends on whether they are already in the project's organization:

| The person | How they join |
|---|---|
| is a member of the organization | an admin adds them by email, at once |
| is not in the organization, or has no account yet | an admin **invites** them by email, optionally with tags; accepting joins them to the organization and the project |

An invitation appears under **Invites** for the person it is addressed to, the next time they sign in — or the moment
they sign up, if they had no account. It expires after five days. Pending invitations are listed under the members.

## Tags

An admin grants and revokes a member's tags from the same page. Tags are how a project says who may read or change a
bot; see [Tags](/docs/tags).

## Removing someone

An admin can remove a member from the project, which also revokes every tag they held in it. They stay in the
organization.

The project's **last admin** cannot be removed, and the `admin` tag cannot be revoked from them — give another member
the admin tag first. That rule counts the people who hold the tag; an organization owner keeps admin standing
regardless, but a project always keeps someone who is an admin by being in it.

## Organization owners

Owners of the organization have admin standing in this project even if they never joined it. They are listed only if
they did.
