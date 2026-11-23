export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface ApprovalRequest {
  kind: "write" | "shell";
  /** Short title, e.g. `write_file src/app.ts` */
  title: string;
  /** Human readable detail shown before the prompt. */
  detail: string;
  /** Optional preview (diff, command output, ...). */
  preview?: string;
}

export interface ToolContext {
  cwd: string;
  yolo: boolean;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finish: string | null;
  model: string | null;
}

export interface StreamCallbacks {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onModel?: (model: string) => void;
}

export interface ChatProvider {
  readonly model: string;
  stream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks?: StreamCallbacks,
  ): Promise<StreamResult>;
}
