#!/usr/bin/env node
// Entry point: install the warning filter before anything loads node:sqlite,
// then load the real CLI dynamically so the filter is active at link time.
import "./runtime/sqliteWarning.js";

await import("./cliMain.js");
