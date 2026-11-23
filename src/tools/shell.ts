import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, warning: "recursive delete" },
  { pattern: /\b(del|erase)\s+\/s/i, warning: "recursive delete" },
  { pattern: /\bformat\s+[a-z]:/i, warning: "disk format" },
  { pattern: /\bgit\s+push\s+.*(--force|-f)\b/i, warning: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, warning: "discards local changes" },
  { pattern: /\bshutdown\b|\breboot\b/i, warning: "system shutdown" },
  { pattern: /:\(\)\s*\{/, warning: "fork bomb" },
  { pattern: /\bmkfs\b/i, warning: "filesystem format" },
];

function quoteForDisplay(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace and return its combined output. Use it for builds, tests, git and package managers. Destructive commands require user approval.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout_ms: {
        type: "number",
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const command = typeof args["command"] === "string" ? args["command"].trim() : "";
    if (command.length === 0) throw new Error("command is required");
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1000, typeof args["timeout_ms"] === "number" ? Math.floor(args["timeout_ms"]) : DEFAULT_TIMEOUT_MS),
    );

    const warnings = DANGEROUS_PATTERNS.filter((entry) => entry.pattern.test(command)).map((entry) => entry.warning);
    const approved = ctx.yolo
      ? true
      : await ctx.approve({
          kind: "shell",
          title: `run_command ${quoteForDisplay(command).slice(0, 80)}`,
          detail: warnings.length > 0 ? `⚠ ${warnings.join(", ")} — review carefully` : `Run in ${ctx.cwd}`,
          preview: `$ ${command}`,
        });
    if (!approved) return { ok: false, output: "User declined to run the command." };

    return await new Promise<ToolResult>((resolve) => {
      const isWindows = process.platform === "win32";
      const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

      const child = spawn(shell, shellArgs, {
        cwd: ctx.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;
      const append = (chunk: Buffer): void => {
        if (truncated) return;
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS);
          truncated = true;
        }
      };

      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      let settled = false;
      let timedOut = false;

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const killTree = (): void => {
        if (child.pid === undefined) return;
        if (isWindows) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };

      const onAbort = (): void => {
        killTree();
        finish({ ok: false, output: `${output}\n[aborted]`.trim() });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        finish({ ok: false, output: `${output}\n[timed out after ${timeoutMs} ms]`.trim() });
      }, timeoutMs);

      child.on("error", (error) => {
        finish({ ok: false, output: `Failed to start command: ${error.message}` });
      });

      child.on("close", (code, signal) => {
        const notes: string[] = [];
        if (timedOut) notes.push(`timed out after ${timeoutMs} ms`);
        if (signal) notes.push(`terminated by ${signal}`);
        if (truncated) notes.push(`output truncated at ${MAX_OUTPUT_CHARS} characters`);
        const footer =
          notes.length > 0
            ? `\n[${notes.join(", ")}]`
            : code === 0
              ? ""
              : `\n[exit code ${code ?? "unknown"}]`;
        const body = output.trim().length > 0 ? output.trimEnd() : "(no output)";
        finish({ ok: code === 0 && !timedOut && !signal, output: `${body}${footer}` });
      });
    });
  },
};
