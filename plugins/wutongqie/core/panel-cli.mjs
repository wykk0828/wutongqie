import { runServer, ensurePanel } from "./panel.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cwd = arg("--cwd") || (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
const sessionId = arg("--session-id");

if (process.argv.includes("--serve")) {
  runServer(cwd, sessionId);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} else {
  ensurePanel({ cwd, sessionId }).then((info) => {
    process.stdout.write(`http://127.0.0.1:${info.port}/\n`);
  }).catch((err) => {
    process.stderr.write(String(err?.message ?? err) + "\n");
    process.exitCode = 1;
  });
}
