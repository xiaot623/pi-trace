import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionPath = resolve(repoRoot, "src/index.ts");
const model = process.env.PI_E2E_MODEL ?? "openai-codex/gpt-5.4-mini";
const timeoutMs = Number(process.env.PI_E2E_TIMEOUT_MS ?? 180_000);

const prompt = [
  "这是 pi-trace 的端到端冒烟测试。",
  "请只做一件事：调用 bash 工具执行 `echo trace-ok`。",
  "然后用一句话结束。",
].join("\n");

test(
  "trace console extension emits realtime and batch events in a real pi run",
  { timeout: timeoutMs + 10_000 },
  async () => {
    const result = await runPi([
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-session",
      "--model",
      model,
      "-p",
      prompt,
    ]);

    assert.equal(result.code, 0, formatFailure(result));

    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /\[trace realtime\] turn\.started/, output);
    assert.match(output, /\[trace realtime\] message\.started role=assistant/, output);
    assert.match(output, /\[trace realtime\] tool\.started bash/, output);
    assert.match(output, /\[trace realtime\] tool\.result bash/, output);
    assert.match(output, /\[trace realtime\] tool\.ended bash/, output);
    assert.match(output, /\[trace batch\] message\.record role=assistant/, output);
    assert.match(output, /\[trace batch\] tool\.record bash/, output);
    assert.match(output, /\[trace batch\] turn\.record turn=0/, output);
    assert.match(output, /\[trace batch\] agent\.run/, output);
    assert.match(output, /trace-ok/, output);
  },
);

function runPi(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pi", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_TRACE_KINDS: process.env.PI_TRACE_KINDS ?? "both",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`pi e2e timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function formatFailure(result) {
  return [
    `pi exited with code=${result.code} signal=${result.signal ?? ""}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n");
}
