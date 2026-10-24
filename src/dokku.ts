import { spawn } from "node:child_process";

export interface ExecResult {
  ok: boolean;
  exit_code: number;
  command_executed: string;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export const DOKKU_BIN = process.env.DOKKU_API_DOKKU_BIN || "/usr/bin/dokku";
const MAX_OUTPUT = 4 * 1024 * 1024;

// Environment variables Dokku's own CLI parser would honour; never inherit them.
const SCRUBBED_ENV = ["DOKKU_APP_NAME", "DOKKU_TRACE", "DOKKU_APPS_FORCE_DELETE", "DOKKU_GLOBAL_FLAGS", "SSH_ORIGINAL_COMMAND"];

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Runs the dokku binary with an argv array. There is no shell involved, so
// arguments are never interpolated or word-split.
export function runDokku(argv: string[], opts: { timeoutMs?: number; redact?: boolean } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DOKKU_API_EXEC_TIMEOUT_MS || 15 * 60 * 1000);
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(DOKKU_BIN, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exit_code: code,
        command_executed: opts.redact ? `dokku ${argv[0]} …` : ["dokku", ...argv].map(quote).join(" "),
        stdout: stdout.replace(ANSI_RE, ""),
        stderr: stderr.replace(ANSI_RE, ""),
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}
