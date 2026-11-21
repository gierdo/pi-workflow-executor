#!/usr/bin/env -S node --experimental-strip-types
import process from "node:process";
import React from "react";
import { render } from "ink";
import { App } from "../tui/app.ts";

function cleanupTerminal(): void {
  process.stdout.write("\x1b[?1049l\x1b[?25h");
}

process.on("exit", cleanupTerminal);
process.on("SIGINT", () => {
  cleanupTerminal();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupTerminal();
  process.exit(0);
});

if (!process.stdin.isTTY) {
  process.stderr.write("pi-workflow-tui requires an interactive terminal (TTY).\n");
  process.exit(1);
}

// Enter alternate screen buffer & hide cursor
process.stdout.write("\x1b[?1049h\x1b[?25l");

const app = render(React.createElement(App));
await app.waitUntilExit();
cleanupTerminal();
