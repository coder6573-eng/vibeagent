/**
 * Tiny terminal UI helpers. No dependencies, no frameworks.
 */

const supportsColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY === true || process.env.FORCE_COLOR !== undefined);

let colorEnabled = supportsColor;

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

function style(open: number, close = 0): (text: string) => string {
  return (text: string) => (colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const c = {
  bold: style(1),
  dim: style(2),
  italic: style(3),
  red: style(31),
  green: style(32),
  yellow: style(33),
  blue: style(34),
  magenta: style(35),
  cyan: style(36),
  gray: style(90),
  bgBlue: (text: string) => (colorEnabled ? `\u001b[44m\u001b[97m${text}\u001b[0m` : text),
};

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n${c.dim(`… ${lines.length - maxLines} more line(s)`)}`;
}

export function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

export function wrapText(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + word.length + 1 <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\n");
}

/** A minimal line diff used for previews. */
export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.length === 0 ? [] : after.replace(/\n$/, "").split("\n");

  // Trim common prefix and suffix first; keeps the DP table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: " " as const, text }));

  const n = midA.length;
  const m = midB.length;
  if (n * m > 400_000) {
    // Too large for a full LCS: show a simple replacement block.
    for (const text of midA) out.push({ kind: "-", text });
    for (const text of midB) out.push({ kind: "+", text });
  } else {
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: " ", text: midA[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push({ kind: "-", text: midA[i]! });
        i++;
      } else {
        out.push({ kind: "+", text: midB[j]! });
        j++;
      }
    }
    while (i < n) out.push({ kind: "-", text: midA[i++]! });
    while (j < m) out.push({ kind: "+", text: midB[j++]! });
  }

  for (let k = endA; k < a.length; k++) out.push({ kind: " ", text: a[k]! });
  return out;
}

export function renderDiff(before: string, after: string, maxLines = 40): string {
  const diff = lineDiff(before, after);
  const shown = diff.slice(0, maxLines);
  const body = shown
    .map((line) => {
      if (line.kind === "-") return c.red(`- ${line.text}`);
      if (line.kind === "+") return c.green(`+ ${line.text}`);
      return c.dim(`  ${line.text}`);
    })
    .join("\n");
  const extra = diff.length - shown.length;
  return extra > 0 ? `${body}\n${c.dim(`… ${extra} more diff line(s)`)}` : body;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function banner(version: string, model: string, baseUrl: string): string {
  const line1 = `${c.magenta("◆")} ${c.bold("vibe agent")} ${c.dim(`v${version}`)}`;
  const line2 = `${c.dim("model")} ${c.cyan(model)}  ${c.dim("·")}  ${c.dim("keyless")}`;
  const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/api\/v1$/, "");
  const line3 = `${c.dim("gateway")} ${c.dim(host)}  ${c.dim("·")}  ${c.dim("$0 free tier")}`;
  return [
    "",
    `  ${line1}`,
    `  ${line2}`,
    `  ${line3}`,
    "",
    c.dim("  /help for commands  ·  ctrl+c to cancel a turn  ·  /exit to quit"),
    "",
  ].join("\n");
}

/** Single-line summary of a tool call, used in the transcript. */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const str = (key: string): string => {
    const value = args[key];
    return typeof value === "string" ? value : "";
  };
  switch (name) {
    case "read_file":
      return str("path") || ".";
    case "write_file":
      return str("path");
    case "edit_file":
      return str("path");
    case "list_files":
      return str("path") || ".";
    case "grep":
      return `/${str("pattern")}/ ${c.dim(`in ${str("path") || "."}`)}`;
    case "run_command":
      return str("command");
    case "update_plan":
      return Array.isArray(args["steps"]) ? `${(args["steps"] as unknown[]).length} step(s)` : "";
    default: {
      const first = Object.values(args).find((v) => typeof v === "string");
      return typeof first === "string" ? truncate(first, 60) : "";
    }
  }
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private active = false;

  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  start(label: string): void {
    if (!process.stderr.isTTY || this.active) return;
    this.active = true;
    this.label = label;
    this.timer = setInterval(() => {
      const frame = this.frames[this.frame++ % this.frames.length]!;
      process.stderr.write(`\r${c.dim(`${frame} ${this.label}`)}\u001b[K`);
    }, 90);
    this.timer.unref?.();
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active) {
      process.stderr.write("\r\u001b[K");
      this.active = false;
    }
  }
}
