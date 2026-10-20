# Why Hypotenuse

Linear already knows what needs doing. Your machines already have the code, the model logins, and the git keys.
Hypotenuse is the shortest path between the two.

## Agents where your code is

A hosted agent has to be given everything: a checkout, credentials, a toolchain. An agent on your own machine
already has them. Hypotenuse starts it in a fresh git worktree, so the work never touches the checkout you are
using.

## Bring any agent

Every agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) works the same way, so you
choose the agent per role and per repository rather than per vendor.

## Credentials stay where they belong

- Your model logins and git keys never leave your machine.
- Linear's tokens stay on the hosted service. Runners and agents reach Linear only through narrowly scoped tools.

## Built for teams

Many people and many runners share a project. Work goes to the person who asked first, sticks to the machine that
holds its worktree, and otherwise goes to whoever has free capacity.

## A manager and its workers

A **manager** agent can own a whole project: it writes the PRD, files the tickets, hands them to **worker** agents,
and reviews what comes back.
