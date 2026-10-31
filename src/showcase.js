import { spawn } from "node:child_process";

const processes = [];
let shuttingDown = false;

function start(label, script) {
  const child = spawn(process.execPath, [script], {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  processes.push(child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[${label}] exited unexpectedly (${signal || code}). Shutting down showcase.`);
    shutdown(code || 1);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) {
    if (!child.killed) child.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("\n🎬 Starting full hackathon showcase...");
console.log("Architecture demo: http://localhost:3001");
console.log("Live voice mode:    http://localhost:3000\n");

start("network", "src/network-server.js");
start("voice", "src/server.js");
