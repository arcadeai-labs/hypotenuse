# @arcadeai/hypotenuse

The `hypotenuse` command line: sign in to a [Hypotenuse](https://github.com/arcadeai-labs/hypotenuse)
server through your browser, manage organizations, projects, members, invites, tags, model
connections, bots, and the audit log over the same HTTP API the dashboard uses, and keep itself up to date.

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
hypotenuse login                 # approve in the browser; --device for SSH
hypotenuse org use mushroom-kingdom
hypotenuse project use castle
hypotenuse member list
hypotenuse model connection add --name anthropic --provider anthropic --api-key-env ANTHROPIC_API_KEY
hypotenuse bot create --name Ada --persona-file ada.md
hypotenuse audit list --since 7d --json
hypotenuse upgrade
```

The full guide is at `/docs/cli` on the Hypotenuse site. `skills/hypotenuse.md` teaches a coding
agent to drive the CLI.

Upgrading from `0.x`? Version 2 is a new product: the runner daemon is gone. `hypotenuse upgrade`
will not cross a major version without `--major`. The `0.x` CLI lives on the
[`v1` branch](https://github.com/arcadeai-labs/hypotenuse/tree/v1).
