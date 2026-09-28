#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";

const port = String(process.env.IVA_PORT || "8723").trim();
const child = spawn(
  process.execPath,
  [join("node_modules", "eve", "bin", "eve.js"), "start", "--host", "127.0.0.1"],
  {
    stdio: "inherit",
    env: { ...process.env, PORT: port },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
