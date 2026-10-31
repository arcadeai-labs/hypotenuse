/**
 * Prove code mode runs here: Run's worker thread starts, its QuickJS
 * WebAssembly loads, TypeScript is stripped, and a program interrupts and
 * resumes. The container build runs it in the production image
 * (`backend/Dockerfile`), so an image that cannot run code mode fails to
 * build. Needs no Postgres, Redis, or configuration.
 *
 *   bun scripts/code-self-test.ts
 */
import { selfTest } from "../ops/code/runtime";

const result = await selfTest();
console.log(`code mode self-test passed: ${JSON.stringify(result)}`);
process.exit(0);
