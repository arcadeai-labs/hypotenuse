# Security

Hypotenuse sits between your Linear workspace and machines your team runs. It is built so that each party holds
only the credentials it needs, and so that a lost laptop costs as little as possible.

## Where every credential lives

| Credential | Lives | Scope | Revoked by |
|---|---|---|---|
| Linear access and refresh tokens (the `@hypotenuse` app) | the hosted service only, encrypted at rest | the teams a Linear admin granted the app | **Disconnect**, or uninstalling the app in Linear |
| Linear webhook signing secret and OAuth client secret | the hosted service's environment | verifying Linear's deliveries; exchanging and renewing tokens | rotating them in Linear and in the deployment |
| Your dashboard session | a cookie in your browser | everything you may do in your projects | signing out, or its expiry |
| CLI token (`hyp_cli_…`) | `credentials.json` on your machine (readable only by you); the service keeps only a hash | what you may do — never what a runner does | **Account → CLI sign-ins → Revoke**, `hypotenuse logout`, or 90 days unused |
| Runner token (`hyp_rt_…`) | `credentials.json` on the runner (readable only by its user); the service keeps only a hash | one runner in one project, with its owner's standing at the time of each request | **Revoke** on the Runners page, `hypotenuse runner revoke`, or the owner leaving the project |
| Coding-agent model credentials (Claude login, `OPENAI_API_KEY`, …) | the runner's machine | the agent | you |
| Git credentials | the runner's machine | your repositories | you |

**Linear credentials never leave the service.** No page, CLI command, or API answer contains a Linear token or
secret. A runner, the coding agent on it, and the agent's tools reach Linear only through the service, which checks
on every call that the request is about the issue that runner was handed, in that project.

**Hypotenuse never holds your model or git credentials.** The agent runs on your machine as you, with your own
logins — that is the point of a local runner.

## What a runner token can do

A runner token is for the daemon, and only the daemon:

| It can | It cannot |
|---|---|
| report the machine's capabilities and heartbeat to its one project | act in any other project |
| claim work routed to it, and report what its agent did | do anything a person can: list members, change settings, register runners, read other sessions |
| reach Linear through the service, scoped to the session it is working on, with the tools its role allows | hold a Linear token, or touch an issue it was not handed |

A person's sign-in cannot do what a runner does either: the two are kept apart by the service, not by convention.
The coding agent never sees the runner token — its tools talk to the daemon, which talks to the service.

If a runner's machine is lost or its token leaks, the damage is bounded by the issues routed to that runner while
the token lived.

## Revoking

- **A runner**: its owner or a project admin revokes it on the Runners page or with `hypotenuse runner revoke`.
  The token stops working on its next request, the daemon is told to stop, and its work goes back to the queue for
  another runner. `hypotenuse runner register --name <name> --replace` revokes a leaked token and issues a new one
  in one step.
- **A person**: removing someone from the project revokes every runner they registered there, in the same moment.
- **A CLI**: **Account → CLI sign-ins** lists every CLI signed in as you; **Revoke** ends one at once.
- **Linear**: **Disconnect** under Settings → Integrations revokes the app's tokens at Linear and removes
  `@hypotenuse` from the workspace. Uninstalling the app in Linear does the same from the other side.

Every one of these is a decision a person made, and each appears in the project's [audit log](/docs/audit) with
who made it.
