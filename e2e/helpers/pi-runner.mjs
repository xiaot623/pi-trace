import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "../..");
export const extensionPath = resolve(repoRoot, "src/index.ts");
export const defaultModel = process.env.PI_E2E_MODEL ?? "openai-codex/gpt-5.4-mini";
export const defaultTimeoutMs = Number(process.env.PI_E2E_TIMEOUT_MS ?? 180_000);

export const toolPrompt = [
  "这是 pi-trace 的端到端冒烟测试。",
  "请只做一件事：调用 bash 工具执行 `echo trace-ok`。",
  "然后用一句话结束。",
].join("\n");

export function runPiTraceE2E({
  model = defaultModel,
  timeoutMs = defaultTimeoutMs,
  prompt = toolPrompt,
  env = {},
} = {}) {
  return runPi(
    [
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-session",
      "--model",
      model,
      "-p",
      prompt,
    ],
    { timeoutMs, env },
  );
}

export function runPi(args, { timeoutMs = defaultTimeoutMs, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pi", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
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

export function formatFailure(result) {
  return [
    `pi exited with code=${result.code} signal=${result.signal ?? ""}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n");
}
