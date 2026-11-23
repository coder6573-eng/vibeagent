#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { Agent } from "./agent.ts";
import type { AgentUi } from "./agent.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { fetchModels, Provider, ProviderError } from "./provider.ts";
import { SessionStore } from "./session.ts";
import type { SessionFile } from "./session.ts";
import { defaultTools, toolSchemas } from "./tools/index.ts";
import type { ApprovalRequest, ChatMessage } from "./types.ts";
import {
  banner,
  c,
  formatNumber,
  indent,
  setColorEnabled,
  Spinner,
  truncate,
} from "./ui.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  name: string;
};

const DEFAULT_MODEL = "kilo-auto/free";
const DEFAULT_BASE_URL = "https://ai-gateway.kilo.ai/api/v1";

const HELP = `${c.bold("vibe agent")} ${c.dim(`v${pkg.version}`)} — a keyless terminal coding agent

${c.bold("Usage")}
  vibe                        start an interactive session
  vibe "fix the failing test"  run one prompt and exit
  vibe models                 list free models from the gateway
  vibe --help                 show this help

${c.bold("Options")}
  -m, --model <id>      model id (default: ${DEFAULT_MODEL})
      --base-url <url>  OpenAI-compatible gateway (default: ${DEFAULT_BASE_URL})
      --api-key <key>   optional API key; anonymous free tier works without one
      --mode <mode>     routing hint for kilo-auto: build, plan, debug, code, ask
  -y, --yolo            skip approval prompts for writes and shell commands
  -r, --reasoning       stream the model's reasoning
      --cwd <dir>       workspace directory (default: current directory)
      --max-steps <n>   tool loop limit per turn (default: 40)
  -c, --continue        resume the latest session in this directory
      --resume <id>     resume a specific session
      --no-color        disable colors
  -v, --version         print the version
  -h, --help            print this help

${c.bold("Environment")}
  VIBE_MODEL, VIBE_BASE_URL, VIBE_API_KEY, VIBE_MODE, VIBE_YOLO

${c.bold("In-session commands")}
  /help  /model <id>  /models  /status  /clear  /new  /sessions
  /resume <id>  /reasoning  /yolo  /exit
`;

class Terminal implements AgentUi {
  private spinner = new Spinner();
  private lastChar = "\n";
  private reasoningPrefix = false;

  spinnerStart(label: string): void {
    this.spinner.start(label);
  }

  spinnerStop(): void {
    this.spinner.stop();
  }

  assistantStart(): void {
    this.lastChar = "\n";
    process.stdout.write(`\n${c.magenta("◆")} `);
    this.reasoningPrefix = false;
  }

  text(delta: string): void {
    process.stdout.write(delta);
    this.lastChar = delta.slice(-1);
  }

  reasoning(delta: string): void {
    if (!this.reasoningPrefix) {
      process.stdout.write(c.dim(c.italic("thinking ")));
      this.reasoningPrefix = true;
    }
    process.stdout.write(c.dim(c.italic(delta)));
    this.lastChar = delta.slice(-1);
  }

  assistantEnd(): void {
    if (this.lastChar !== "\n") process.stdout.write("\n");
    this.lastChar = "\n";
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    const summary = Agent.describeToolCall(name, args);
    process.stdout.write(`\n  ${c.cyan("●")} ${c.bold(name)} ${c.dim(summary)}\n`);
    this.lastChar = "\n";
  }

  toolResult(ok: boolean, summary: string): void {
    const marker = ok ? c.dim("└") : c.red("└");
    const text = ok ? c.dim(summary) : c.red(summary);
    process.stdout.write(`    ${marker} ${text}\n`);
    this.lastChar = "\n";
  }

  info(text: string): void {
    process.stdout.write(`${c.dim(text)}\n`);
    this.lastChar = "\n";
  }

  error(text: string): void {
    process.stdout.write(`${c.red("!")} ${text}\n`);
    this.lastChar = "\n";
  }
}

interface CliOptions {
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  mode: string;
  yolo: boolean;
  reasoning: boolean;
  maxSteps: number;
  resume?: string;
  continueSession: boolean;
}

function readConfig(values: Record<string, unknown>): CliOptions {
  const model = typeof values["model"] === "string" ? values["model"] : process.env.VIBE_MODEL ?? DEFAULT_MODEL;
  const baseUrl =
    typeof values["base-url"] === "string" ? values["base-url"] : process.env.VIBE_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = typeof values["api-key"] === "string" ? values["api-key"] : process.env.VIBE_API_KEY ?? "";
  const mode = typeof values["mode"] === "string" ? values["mode"] : process.env.VIBE_MODE ?? "build";
  const maxStepsRaw = typeof values["max-steps"] === "string" ? Number.parseInt(values["max-steps"], 10) : 40;
  return {
    cwd: path.resolve(typeof values["cwd"] === "string" ? values["cwd"] : process.cwd()),
    model,
    baseUrl,
    apiKey,
    mode,
    yolo: values["yolo"] === true || process.env.VIBE_YOLO === "1",
    reasoning: values["reasoning"] === true,
    maxSteps: Number.isFinite(maxStepsRaw) && maxStepsRaw > 0 ? maxStepsRaw : 40,
    resume: typeof values["resume"] === "string" ? values["resume"] : undefined,
    continueSession: values["continue"] === true,
  };
}

function isFreeModel(id: string): boolean {
  return id.includes(":free") || id.startsWith("kilo-auto/");
}

async function printModels(baseUrl: string): Promise<void> {
  try {
    const models = await fetchModels(baseUrl);
    const free = models.filter((model) => isFreeModel(model.id));
    const list = (free.length > 0 ? free : models).slice(0, 60);
    console.log(`\n${c.bold("Models")} ${c.dim(`(${list.length} shown${free.length > 0 ? ", free tier" : ""})`)}\n`);
    for (const model of list) {
      const context = model.context_length ? c.dim(` · ${formatNumber(model.context_length)} ctx`) : "";
      console.log(`  ${c.cyan(model.id)}${context}`);
    }
    console.log(`\n${c.dim("Use with --model <id> or /model <id> in a session.")}\n`);
  } catch (error) {
    console.error(`${c.red("!")} Could not fetch models: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function describeError(error: unknown): string {
  if (error instanceof ProviderError) {
    const suffix = error.status === 429 ? " — the anonymous free tier allows 200 requests per hour per IP" : "";
    return `Gateway error${error.status ? ` (HTTP ${error.status})` : ""}: ${error.message}${suffix}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      mode: { type: "string" },
      yolo: { type: "boolean", short: "y" },
      reasoning: { type: "boolean", short: "r" },
      cwd: { type: "string" },
      "max-steps": { type: "string" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string" },
      "no-color": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values["no-color"] === true) setColorEnabled(false);

  if (values["help"] === true) {
    console.log(HELP);
    return;
  }
  if (values["version"] === true) {
    console.log(pkg.version);
    return;
  }

  const config = readConfig(values as Record<string, unknown>);

  if (positionals[0] === "models") {
    await printModels(config.baseUrl);
    return;
  }

  const store = new SessionStore();
  let session: SessionFile;
  if (config.resume) {
    try {
      session = await store.load(config.resume);
    } catch {
      console.error(`${c.red("!")} No session found with id ${config.resume}`);
      process.exitCode = 1;
      return;
    }
  } else if (config.continueSession) {
    session = (await store.latestFor(config.cwd)) ?? (await store.create(config.cwd, config.model));
  } else {
    session = await store.create(config.cwd, config.model);
  }

  const systemPrompt = await buildSystemPrompt({
    cwd: config.cwd,
    model: config.model,
    tools: toolSchemas(defaultTools),
  });

  const messages: ChatMessage[] =
    session.messages.length > 0 && session.messages[0]?.role === "system"
      ? [{ role: "system", content: systemPrompt }, ...session.messages.slice(1)]
      : [{ role: "system", content: systemPrompt }];
  session.messages = messages;

  const provider = new Provider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    mode: config.mode,
    clientVersion: pkg.version,
  });

  const terminal = new Terminal();
  const state = {
    yolo: config.yolo,
    reasoning: config.reasoning,
    autoApprove: false,
  };

  let ask: (query: string) => Promise<string | null> = async () => null;

  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    if (state.yolo || state.autoApprove) return true;
    console.log("");
    console.log(`  ${c.yellow("┌")} ${c.bold(request.title)}`);
    console.log(indent(`${c.dim(request.detail)}${request.preview ? `\n${request.preview}` : ""}`, "  │ "));
    const answer = await ask(`  ${c.yellow("└")} ${request.kind === "shell" ? "run" : "apply"}? ${c.dim("[y/N/a]")} `);
    const normalized = (answer ?? "").trim().toLowerCase();
    if (normalized === "a" || normalized === "all") {
      state.autoApprove = true;
      return true;
    }
    return normalized === "y" || normalized === "yes";
  };

  const agent = new Agent({
    provider,
    tools: defaultTools,
    cwd: config.cwd,
    systemPrompt,
    yolo: state.yolo,
    maxSteps: config.maxSteps,
    showReasoning: state.reasoning,
    approve,
    ui: terminal,
    messages,
    onPersist: async (current) => {
      session.messages = current;
      session.model = provider.model;
      try {
        await store.save(session);
      } catch {
        // never fail a turn because of persistence
      }
    },
  });

  const printFooter = (): void => {
    const usage = agent.usage;
    const tokens = usage.total_tokens ?? 0;
    const cost = usage.cost ?? 0;
    if (tokens === 0) return;
    console.log(
      c.dim(
        `\n  ${formatNumber(tokens)} tok · $${cost.toFixed(4)} · ${config.model} · session ${session.id}`,
      ),
    );
  };

  if (positionals.length > 0) {
    const prompt = positionals.join(" ").trim();
    const controller = new AbortController();
    try {
      await agent.runTurn(prompt, controller.signal);
      printFooter();
    } catch (error) {
      if ((error as Error).name === "AbortError") console.log(c.dim("\n  cancelled"));
      else console.error(`${c.red("!")} ${describeError(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  console.log(banner(pkg.version, config.model, config.baseUrl));
  if (config.continueSession || config.resume) {
    console.log(c.dim(`  resumed ${session.id} · ${session.messages.length - 1} messages · ${session.title}`));
    console.log("");
  }
  console.log(c.dim(`  workspace ${config.cwd}`));
  console.log(c.dim(`  ${state.yolo ? "yolo mode: no approvals" : "approvals on: writes and shell ask first"}`));
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    historySize: 500,
  });

  let closed = false;
  const queuedLines: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queuedLines.push(line);
  });

  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });

  ask = (query: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (queuedLines.length > 0) {
        resolve(queuedLines.shift()!);
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      waiters.push(resolve);
      rl.setPrompt(query);
      rl.prompt();
    });

  let currentTurn: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (currentTurn) {
      currentTurn.abort();
      currentTurn = null;
      process.stdout.write(c.dim("\n  cancelling…\n"));
    } else {
      process.stdout.write("\n");
      rl.close();
    }
  });

  const setModel = (id: string): void => {
    config.model = id;
    agent.setProvider(
      new Provider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: id,
        mode: config.mode,
        clientVersion: pkg.version,
      }),
    );
    console.log(c.dim(`  model → ${id}`));
  };

  let running = true;
  while (running) {
    const input = await ask(`${c.magenta("›")} `);
    if (input === null) break;
    let text = input;
    while (text.endsWith("\\")) {
      const more = await ask(c.dim("… "));
      if (more === null) break;
      text = `${text.slice(0, -1)}\n${more}`;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("/")) {
      const [command, ...rest] = trimmed.slice(1).split(/\s+/);
      const argument = rest.join(" ").trim();
      switch (command) {
        case "exit":
        case "quit":
          running = false;
          break;
        case "help":
          console.log(HELP);
          break;
        case "clear":
          agent.setMessages([{ role: "system", content: systemPrompt }]);
          console.log(c.dim("  context cleared"));
          break;
        case "new":
          session = await store.create(config.cwd, config.model);
          agent.setMessages([{ role: "system", content: systemPrompt }]);
          console.log(c.dim(`  new session ${session.id}`));
          break;
        case "model":
          if (argument.length === 0) console.log(c.dim(`  model: ${config.model}`));
          else setModel(argument);
          break;
        case "models":
          await printModels(config.baseUrl);
          break;
        case "status":
          console.log(
            [
              `  model      ${config.model}`,
              `  gateway    ${config.baseUrl}`,
              `  workspace  ${config.cwd}`,
              `  session    ${session.id}`,
              `  messages   ${agent.messages.length}`,
              `  tokens     ${formatNumber(agent.usage.total_tokens ?? 0)}`,
              `  cost       $${(agent.usage.cost ?? 0).toFixed(4)}`,
              `  approvals  ${state.yolo ? "off (yolo)" : state.autoApprove ? "off (this session)" : "on"}`,
              `  reasoning  ${state.reasoning ? "shown" : "hidden"}`,
            ].join("\n"),
          );
          break;
        case "sessions": {
          const sessions = await store.list();
          if (sessions.length === 0) {
            console.log(c.dim("  no saved sessions"));
            break;
          }
          for (const item of sessions.slice(0, 10)) {
            const marker = item.id === session.id ? c.cyan("*") : " ";
            console.log(`  ${marker} ${c.bold(item.id)} ${c.dim(item.updatedAt.slice(0, 16))} ${truncate(item.title, 50)}`);
          }
          console.log(c.dim("  resume with /resume <id>"));
          break;
        }
        case "resume": {
          if (argument.length === 0) {
            console.log(c.dim("  usage: /resume <id>"));
            break;
          }
          try {
            const loaded = await store.load(argument);
            session = loaded;
            const restored: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...loaded.messages.slice(1)];
            agent.setMessages(restored);
            session.messages = restored;
            console.log(c.dim(`  resumed ${session.id} · ${session.title}`));
          } catch {
            console.log(c.red(`  no session with id ${argument}`));
          }
          break;
        }
        case "reasoning":
          state.reasoning = !state.reasoning;
          agent.setShowReasoning(state.reasoning);
          console.log(c.dim(`  reasoning ${state.reasoning ? "shown" : "hidden"}`));
          break;
        case "yolo":
          state.yolo = !state.yolo;
          agent.setYolo(state.yolo);
          console.log(c.dim(`  approvals ${state.yolo ? "disabled" : "enabled"}`));
          break;
        default:
          console.log(c.dim(`  unknown command /${command} — try /help`));
      }
      if (!running) break;
      continue;
    }

    currentTurn = new AbortController();
    try {
      await agent.runTurn(trimmed, currentTurn.signal);
      printFooter();
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log(c.dim("  cancelled"));
      } else {
        console.error(`${c.red("!")} ${describeError(error)}`);
      }
    } finally {
      currentTurn = null;
    }
  }

  rl.close();
  console.log(c.dim("\n  bye\n"));
}

main().catch((error) => {
  console.error(`${c.red("!")} ${(error as Error).message}`);
  process.exitCode = 1;
});
