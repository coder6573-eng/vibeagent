import type {
  ApprovalRequest,
  ChatMessage,
  ChatProvider,
  StreamResult,
  Tool,
  ToolContext,
  ToolSchema,
  Usage,
} from "./types.ts";
import { executeTool, MAX_TOOL_OUTPUT_CHARS, toolSchemas } from "./tools/index.ts";
import { formatToolCall } from "./ui.ts";

export interface AgentUi {
  spinnerStart(label: string): void;
  spinnerStop(): void;
  assistantStart(): void;
  text(delta: string): void;
  reasoning(delta: string): void;
  assistantEnd(): void;
  toolStart(name: string, args: Record<string, unknown>): void;
  toolResult(ok: boolean, summary: string): void;
  info(text: string): void;
  error(text: string): void;
}

export interface AgentOptions {
  provider: ChatProvider;
  tools: Tool[];
  cwd: string;
  systemPrompt: string;
  yolo: boolean;
  maxSteps?: number;
  showReasoning?: boolean;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  ui: AgentUi;
  messages?: ChatMessage[];
  onPersist?: (messages: ChatMessage[]) => void | Promise<void>;
}

export interface TurnResult {
  content: string;
  steps: number;
  toolCalls: number;
  aborted: boolean;
  usage: Usage;
}

const MAX_CONTEXT_CHARS = 320_000;

function messageChars(message: ChatMessage): number {
  const content = typeof message.content === "string" ? message.content.length : 0;
  const calls = message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0;
  return content + calls;
}

/**
 * Drops the oldest turns when the transcript grows too large. The system
 * prompt and the newest exchange are always kept, and tool results are never
 * left without their assistant tool_calls message.
 */
export function compactMessages(messages: ChatMessage[], maxChars = MAX_CONTEXT_CHARS): ChatMessage[] {
  if (messages.reduce((sum, message) => sum + messageChars(message), 0) <= maxChars) return messages;

  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  let rest = messages.slice(system.length);

  while (rest.length > 2) {
    const total = [...system, ...rest].reduce((sum, message) => sum + messageChars(message), 0);
    if (total <= maxChars) break;
    // Drop one whole exchange: assistant + following tool results + user.
    rest = rest.slice(1);
  }

  // A tool result without its preceding assistant tool_calls is invalid.
  while (rest.length > 0 && rest[0]!.role === "tool") rest = rest.slice(1);

  return [...system, ...rest];
}

function summarizeOutput(output: string): string {
  const lines = output.split("\n");
  const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  const head = first.length > 110 ? `${first.slice(0, 109)}…` : first;
  if (lines.length > 1) return `${head} ${first.length > 0 ? "· " : ""}${lines.length} lines`;
  return head;
}

export class Agent {
  readonly messages: ChatMessage[];
  readonly usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
  private readonly options: AgentOptions;
  private readonly schemas: ToolSchema[];
  private turnAborted = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.schemas = toolSchemas(options.tools);
    this.messages = options.messages ?? [{ role: "system", content: options.systemPrompt }];
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
  }

  setProvider(provider: ChatProvider): void {
    this.options.provider = provider;
  }

  setYolo(yolo: boolean): void {
    this.options.yolo = yolo;
  }

  setShowReasoning(show: boolean): void {
    this.options.showReasoning = show;
  }

  private addUsage(usage: Usage): void {
    this.usage.prompt_tokens = (this.usage.prompt_tokens ?? 0) + (usage.prompt_tokens ?? 0);
    this.usage.completion_tokens = (this.usage.completion_tokens ?? 0) + (usage.completion_tokens ?? 0);
    this.usage.total_tokens = (this.usage.total_tokens ?? 0) + (usage.total_tokens ?? 0);
    this.usage.cost = (this.usage.cost ?? 0) + (usage.cost ?? 0);
  }

  async runTurn(userText: string, signal: AbortSignal): Promise<TurnResult> {
    const ui = this.options.ui;
    const maxSteps = this.options.maxSteps ?? 40;
    const showReasoning = this.options.showReasoning ?? false;

    this.turnAborted = false;
    this.messages.push({ role: "user", content: userText });

    let steps = 0;
    let toolCallCount = 0;
    let lastContent = "";
    let turnUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };

    const ctx: ToolContext = {
      cwd: this.options.cwd,
      yolo: this.options.yolo,
      signal,
      approve: this.options.approve,
    };

    try {
      while (steps < maxSteps) {
        if (signal.aborted) {
          this.turnAborted = true;
          break;
        }
        steps++;

        const compacted = compactMessages(this.messages);
        if (compacted.length !== this.messages.length) {
          this.messages.splice(0, this.messages.length, ...compacted);
        }

        ui.spinnerStart(steps === 1 ? "thinking" : "working");
        let started = false;
        let result: StreamResult;
        try {
          result = await this.options.provider.stream(this.messages, this.schemas, {
            signal,
            onText: (delta) => {
              if (!started) {
                ui.spinnerStop();
                ui.assistantStart();
                started = true;
              }
              ui.text(delta);
            },
            onReasoning: (delta) => {
              if (!showReasoning) return;
              if (!started) {
                ui.spinnerStop();
                ui.assistantStart();
                started = true;
              }
              ui.reasoning(delta);
            },
          });
        } catch (error) {
          if (signal.aborted) {
            this.turnAborted = true;
            break;
          }
          throw error;
        } finally {
          ui.spinnerStop();
          if (started) ui.assistantEnd();
        }

        this.addUsage(result.usage);
        turnUsage = {
          prompt_tokens: (turnUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
          completion_tokens: (turnUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
          total_tokens: (turnUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0),
          cost: (turnUsage.cost ?? 0) + (result.usage.cost ?? 0),
        };
        if (result.content.length > 0) lastContent = result.content;

        const toolCalls = result.toolCalls;
        if (toolCalls.length === 0) {
          if (result.content.trim().length === 0) {
            ui.error("The model returned an empty response. Try again or switch models with /model.");
          } else {
            this.messages.push({ role: "assistant", content: result.content });
          }
          break;
        }

        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: result.content.length > 0 ? result.content : null,
          tool_calls: toolCalls,
        };
        this.messages.push(assistantMessage);

        for (const call of toolCalls) {
          toolCallCount++;
          const name = call.function.name;
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
            if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
          } catch {
            // executeTool reports the JSON error to the model
          }

          if (signal.aborted) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Error: the user cancelled this turn before the tool ran.",
            });
            this.turnAborted = true;
            continue;
          }

          ui.toolStart(name, args);
          const toolResult = await executeTool(this.options.tools, name, call.function.arguments, ctx);
          ui.toolResult(toolResult.ok, summarizeOutput(toolResult.output));

          const content =
            toolResult.output.length > MAX_TOOL_OUTPUT_CHARS
              ? toolResult.output.slice(0, MAX_TOOL_OUTPUT_CHARS)
              : toolResult.output;
          this.messages.push({ role: "tool", tool_call_id: call.id, content });
        }

        if (signal.aborted) {
          this.turnAborted = true;
          break;
        }
      }

      if (steps >= maxSteps && !this.turnAborted) {
        ui.error(`Stopped after ${maxSteps} steps. Send a message to continue.`);
      }
    } finally {
      await this.options.onPersist?.(this.messages);
    }

    return { content: lastContent, steps, toolCalls: toolCallCount, aborted: this.turnAborted, usage: turnUsage };
  }

  static describeToolCall(name: string, args: Record<string, unknown>): string {
    return formatToolCall(name, args);
  }
}
