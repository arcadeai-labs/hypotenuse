import { assemblePrompt } from "../../ops/PromptOps";
import { fullInputs } from "./inputs";

// Run in a separate process by assemble.test.ts: prints the hash of the shared
// inputs, assembled at a fixed time.
process.stdout.write(
  assemblePrompt(fullInputs(), new Date("2026-06-01T00:00:00Z")).hash,
);
