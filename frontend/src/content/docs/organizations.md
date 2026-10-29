# Organizations

An organization is a company, or a part of one: it holds **members** and **projects**, and nothing else. Everything a
bot uses — its platform apps, model keys, MCP servers, memory, and skills — belongs to a project. A team usually gets
its own project, with its own Slack workspace install and its own people.

## Owners and members

Everyone in an organization is either an **owner** or a **member**.

| An organization member may | Only an owner may |
|---|---|
| see the organization and its member list | see and administer **every** project in it |
| see the projects they have been added to | create projects |
| leave the organization | rename the organization, change its slug, or delete it |
| | invite people to the organization, make someone an owner, or remove a member |

Being a member of an organization shows you **none of its projects** on its own. A project is invisible to you until
someone adds you to it.

## Owners administer every project

An owner has admin standing in every project of their organization, whether or not they have joined it. Anything a
project admin can do, an owner can do in any of the organization's projects. The project's page says so when that is
where your standing comes from, and so does every audit record of what you changed there — so it is never unclear
who could act, or why.

## Inviting people

Owners invite people to the organization itself from **Organization → Members**. A project admin can also invite
someone straight into a project (see [Members](/docs/members)): accepting a project invitation adds the person to the
organization as a member too, so they see that one project and nothing else.

## Removing people and leaving

An owner can remove a member from **Organization → Members**, and anyone can leave. Leaving or being removed takes
you out of **every project** in the organization at once, along with your tags in them, and withdraws every
invitation into the organization still waiting for you.

Two things are refused, so an organization is never left without someone in charge:

- the **last owner** cannot leave, be removed, or be made a member — make someone else an owner first;
- someone who is the **last admin of one of its projects** cannot leave or be removed — give another member of that
  project the admin tag first.

## Creating and deleting

Owners create projects from **Organization → Projects**, and become the new project's first admin. Anyone signed in
can start a new organization — **New organization** in the organization switcher, or in the command palette (⌘K). It
starts with no projects and with you as its owner, and it becomes the active organization so you can create its first
project.

An organization can be deleted only once it has no projects. Delete each project first; that is a decision made, and
recorded, one project at a time.
