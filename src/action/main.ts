import { ApiError, escapeData, printExecution, run, type Execution } from "./lib.js";

run().catch((err: unknown) => {
  if (err instanceof ApiError) printExecution(err.body as Execution);
  console.log(`::error::${escapeData(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
