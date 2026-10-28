#!/usr/bin/env bun
import { buildProgram } from "./program";

await buildProgram().parseAsync(process.argv);
