# Getting started

Hypotenuse runs in two places: a hosted service you sign in to, and the `hypotenuse` daemon on the machines that do
the work. This page is the hosted half — your account and your project.

## Create an account

Open [Sign up](/sign-up) and enter your name, email, and a password of at least eight characters. Signing up does
three things at once:

- creates your account and signs you in,
- creates a project named after you (for example *Ada Lovelace's Project*), and
- makes you that project's **admin**.

You land on the project's home page. Rename the project under **Settings → General** whenever you like.

## Bring your team in

Open the project switcher at the top of the sidebar and choose **Invites**. Invite a teammate by email, optionally
with tags. They see the invitation the next time they sign in, and accepting it adds them to the project. See
[Members](/docs/members).

## Find your way around

- **⌘K** (Ctrl+K on Windows and Linux) opens the command palette. It reaches every page and every action you are
  allowed to take, such as *Invite member* or *Open audit log*.
- **?** lists every keyboard shortcut.
- The **bell** at the foot of the sidebar holds notifications addressed to you.
- The **account menu** below it switches between light, dark, and system themes, and signs you out.

## Connect Linear

An admin opens **Settings → Integrations** and connects the project to its Linear workspace. A Linear workspace
admin approves the `@hypotenuse` app on Linear's consent screen. See [Connecting Linear](/docs/connecting-linear).

## Install a runner

Work runs on your own machines. On each one, install the CLI, sign it in, register the machine, and start the
daemon:

```bash
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash   # or: npm i -g @arcadeai/hypotenuse
hypotenuse login
hypotenuse runner register
hypotenuse config init && hypotenuse config validate
hypotenuse daemon start          # or: hypotenuse service install, to start it with your login
```

See [runners](/docs/runners), [the daemon](/docs/daemon), and [the config file](/docs/config).

## Delegate an issue

In Linear, assign an issue to `@hypotenuse` as its delegate, or mention it in a comment. Within seconds the session
says it is finding a runner; a runner picks the work up in a fresh git worktree, and you watch its thinking, plan,
and tool calls in Linear's session panel. The project's **Sessions** page in the dashboard shows the same session
with what Linear cannot: the runner it is on, its turns, and why it is waiting if it is. See
[the dashboard](/docs/dashboard) and [routing](/docs/routing).

## What comes next

Read on: [accounts](/docs/accounts), [projects](/docs/projects), [managers and workers](/docs/manager-and-worker),
[members](/docs/members), [security](/docs/security), and the [audit log](/docs/audit).
