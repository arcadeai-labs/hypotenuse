# @arcadeai/hypotenuse

The `hypotenuse` command line: sign in to a [Hypotenuse](https://github.com/arcadeai-labs/hypotenuse)
server through your browser, manage projects, members, invites, tags, and the audit log, register
this machine as a runner, and keep itself up to date. Later releases add the runner daemon that runs
coding agents on your machine for Linear agent sessions.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.sh | bash   # macOS, Linux
irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex          # Windows
npm i -g @arcadeai/hypotenuse   # needs Bun on PATH
bun i -g @arcadeai/hypotenuse
```

The install scripts fetch a self-contained binary. The npm package is a Bun bundle, so npm and bun
installs need [Bun](https://bun.sh) on the machine.

## Use

```bash
hypotenuse login              # approve in the browser; --no-browser for SSH
hypotenuse project use my-team
hypotenuse member list
hypotenuse integration connect linear  # a Linear workspace admin approves in the browser
hypotenuse runner register --name my-laptop  # saves a runner token for the daemon
hypotenuse --json audit list --since 7d | jq
hypotenuse upgrade
```

`hypotenuse --help` lists every command. The user docs are at
[`/docs/cli`](https://www.hypotenuse.cloud/docs/cli).
