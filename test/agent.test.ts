import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, compactMessages } from "../src/agent.ts";
import type { AgentOptions, AgentUi } from "../src/agent.ts";
import { defaultTools } from "../src/tools/index.ts";
import type {
  ChatMessage,
  ChatProvider,
  StreamCallbacks,
  StreamResult,
  ToolSchema,
} from "../src/types.ts";

class ScriptedProvider implements ChatProvider {
  readonly model = "scripted";
  readonly calls: ChatMessage[][] = [];
  private readonly responses: StreamResult[];

  constructor(responses: StreamResult[]) {
    this.responses = [...responses];
  }

  async stream(
    messages: ChatMessage[],
    _tools: ToolSchema[],
    callbacks?: StreamCallbacks,
  ): Promise<StreamResult> {
    this.calls.push(structuredClone(messages));
    const response = this.responses.shift();
    if (!response) throw new Error("ScriptedProvider ran out of responses");
    if (response.content.length > 0) callbacks?.onText?.(response.content);
    return response;
  }
}

class TestUi implements AgentUi {
  readonly errors: string[] = [];
  readonly infos: string[] = [];
  readonly tools: string[] = [];
  output = "";

  spinnerStart(): void {}
  spinnerStop(): void {}
  assistantStart(): void {}
  text(delta: string): void {
    this.output += delta;
  }
  reasoning(): void {}
  assistantEnd(): void {}
  toolStart(name: string): void {
    this.tools.push(name);
  }
  toolResult(): void {}
  info(text: string): void {
    this.infos.push(text);
  }
  error(text: string): void {
    this.errors.push(text);
  }
}

function result(partial: Partial<StreamResult>): StreamResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
    finish: "stop",
    model: "scripted",
    ...partial,
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call_1") {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function createAgent(
  provider: ChatProvider,
  ui: TestUi,
  cwd: string,
  extra: Partial<AgentOptions> = {},
): Agent {
  return new Agent({
    provider,
    tools: defaultTools,
    cwd,
    systemPrompt: "test system prompt",
    yolo: true,
    ui,
    approve: async () => true,
    ...extra,
  });
}

test("agent executes a tool call and returns the final answer", async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [toolCall("update_plan", { steps: [{ step: "write tests", status: "in_progress" }] })],
      finish: "tool_calls",
    }),
    result({ content: "All set." }),
  ]);
  const ui = new TestUi();
  const agent = createAgent(provider, ui, process.cwd());

  const turn = await agent.runTurn("plan the work", new AbortController().signal);

  assert.equal(turn.content, "All set.");
  assert.equal(turn.toolCalls, 1);
  assert.equal(turn.steps, 2);
  assert.equal(ui.output, "All set.");
  assert.deepEqual(ui.tools, ["update_plan"]);

  const roles = agent.messages.map((message) => message.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);
  const toolMessage = agent.messages[3]!;
  assert.match(String(toolMessage.content), /Plan \(0\/1 done\)/);

  assert.equal(agent.usage.total_tokens, 30);
});

test("a declined write is reported back to the model", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-agent-"));
  try {
    const provider = new ScriptedProvider([
      result({ toolCalls: [toolCall("write_file", { path: "blocked.txt", content: "secret" })] }),
      result({ content: "Okay, I did not write it." }),
    ]);
    const ui = new TestUi();
    const agent = createAgent(provider, ui, workspace, { yolo: false, approve: async () => false });

    await agent.runTurn("write a file", new AbortController().signal);

    await assert.rejects(fs.readFile(path.join(workspace, "blocked.txt")));
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    assert.match(String(toolMessage?.content), /declined/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("the loop stops at maxSteps", async () => {
  const looping = result({ toolCalls: [toolCall("update_plan", { steps: [{ step: "loop", status: "pending" }] })] });
  const provider = new ScriptedProvider(Array.from({ length: 5 }, () => structuredClone(looping)));
  const ui = new TestUi();
  const agent = createAgent(provider, ui, process.cwd(), { maxSteps: 2 });

  const turn = await agent.runTurn("loop forever", new AbortController().signal);

  assert.equal(turn.steps, 2);
  assert.ok(ui.errors.some((message) => message.includes("Stopped after 2 steps")));
});

test("an aborted signal stops the turn without throwing", async () => {
  const provider = new ScriptedProvider([
    result({ toolCalls: [toolCall("update_plan", { steps: [{ step: "x", status: "pending" }] })] }),
    result({ content: "should not be reached" }),
  ]);
  const ui = new TestUi();
  const agent = createAgent(provider, ui, process.cwd());
  const controller = new AbortController();
  controller.abort();

  const turn = await agent.runTurn("do work", controller.signal);

  assert.equal(turn.aborted, true);
  assert.equal(turn.steps, 0);
});

test("compactMessages keeps the system prompt and drops orphaned tool results", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: "user", content: `question ${i} ${"x".repeat(100)}` });
    messages.push({ role: "assistant", content: `answer ${i} ${"y".repeat(100)}` });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `tool ${i}` });
  }

  const compacted = compactMessages(messages, 2000);
  assert.equal(compacted[0]?.role, "system");
  assert.ok(compacted.length < messages.length);
  assert.notEqual(compacted[1]?.role, "tool");
});
