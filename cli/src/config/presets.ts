/**
 * The coding agents the daemon knows how to launch by name. A preset is the
 * command that starts an ACP agent speaking stdio; `[agents.<id>] preset =
 * "claude"` uses it, and a role whose `agent` names a preset with no
 * `[agents.*]` table gets it with defaults.
 */

/** One preset's launch command. */
export interface AgentPreset {
  /** The full command, the binary first. */
  command: readonly string[];
  /** Environment the daemon sets for it (the agent's own `env` wins). */
  env?: Readonly<Record<string, string>>;
}

/** Every preset, by name. The table in `docs/CONFIG.md` lists the same. */
export const AGENT_PRESETS = {
  claude: { command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"] },
  codex: {
    command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
    env: { NO_BROWSER: "1" },
  },
  gemini: { command: ["npx", "-y", "@google/gemini-cli", "--acp"] },
  copilot: { command: ["npx", "-y", "@github/copilot", "--acp"] },
  goose: { command: ["goose", "acp"] },
  opencode: { command: ["opencode", "acp"] },
  cursor: { command: ["cursor-agent", "acp"] },
  qwen: {
    command: [
      "npx",
      "-y",
      "@qwen-code/qwen-code",
      "--acp",
      "--experimental-skills",
    ],
  },
  cline: { command: ["npx", "-y", "cline", "--acp"] },
  auggie: {
    command: ["npx", "-y", "@augmentcode/auggie", "--acp"],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
  },
  kilo: { command: ["npx", "-y", "@kilocode/cli", "acp"] },
} as const satisfies Record<string, AgentPreset>;

/** A preset's name. */
export type PresetName = keyof typeof AGENT_PRESETS;

/** Every preset name, in the order the docs list them. */
export const PRESET_NAMES = Object.keys(AGENT_PRESETS) as [
  PresetName,
  ...PresetName[],
];

/**
 * Whether a name is a preset.
 * @param name - A name from the config file.
 * @returns True for a preset name.
 */
export function isPreset(name: string): name is PresetName {
  return Object.hasOwn(AGENT_PRESETS, name);
}
