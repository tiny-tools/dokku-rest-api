import { ApiError, escapeData, printExecution, run } from "./lib.js";
run().catch((err) => {
    if (err instanceof ApiError)
        printExecution(err.body);
    console.log(`::error::${escapeData(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
});
