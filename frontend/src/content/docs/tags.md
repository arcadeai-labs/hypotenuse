# Tags

A tag is a role you name: `support`, `eng`, `finance`. An admin creates a project's tags under **Settings → Tags** and
grants them to members under **Settings → Members**. A tag means nothing on its own; it means something when an
**access list** names it.

Every project has one reserved tag, `admin`, which makes its holder an admin of the project. It cannot be renamed or
deleted, and no other tag can be named `admin`.

Tag names are compared without regard to case or surrounding spaces, so `Finance` and `finance` are the same tag, and a
project cannot have both. No tag can be named `*`, which an access list reads as "every member".

## Access lists

Some things in a project — bots first — carry two lists of tag names: who may **read** it, and who may **write** it.
Who satisfies a list:

| The list | Who passes |
|---|---|
| anything, and you are an admin (or an owner of the organization) | you |
| empty | every member of the project |
| contains `*` | every member of the project |
| names tags | members who hold at least one of them |

So a bot readable by `["support", "eng"]` is visible to anyone holding either tag, and to every admin. Admins always
pass, so a list can never lock everyone out of the thing it protects.

## Renaming and deleting a tag

Renaming a tag updates every access list that names it, so nobody's access changes.

Deleting a tag is refused while any access list still names it, and the refusal says which. Remove the tag from those
lists first. Deleting it from the lists for you would quietly change who has access — a list naming only that tag
would become empty, and an empty list means *everyone*.
