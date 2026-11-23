import type {
  ChatMessage,
  ChatProvider,
  StreamCallbacks,
  StreamResult,
  ToolCall,
  ToolSchema,
  Usage,
} from "./types.ts";

export interface ProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Sent as `x-kilocode-mode` for kilo-auto routing. */
  mode?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Client version, reported to the gateway. */
  clientVersion?: string;
  fetchImpl?: typeof fetch;
}

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Incremental Server-Sent Events parser. Feed it decoded text chunks and it
 * returns the `data:` payloads that are complete.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const payload = parseSseLine(line);
      if (payload !== null) payloads.push(payload);
      index = this.buffer.indexOf("\n");
    }
    return payloads;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    const payload = parseSseLine(rest);
    return payload === null ? [] : [payload];
  }
}

function parseSseLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  return payload.length === 0 ? null : payload;
}

export interface ToolCallAccumulator {
  calls: Map<number, { id: string; name: string; args: string }>;
}

export function createAccumulator(): ToolCallAccumulator {
  return { calls: new Map() };
}

export function accumulateToolCallDeltas(
  acc: ToolCallAccumulator,
  deltas: unknown,
): void {
  if (!Array.isArray(deltas)) return;
  for (const raw of deltas) {
    if (typeof raw !== "object" || raw === null) continue;
    const delta = raw as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = typeof delta.index === "number" ? delta.index : 0;
    const current = acc.calls.get(index) ?? { id: "", name: "", args: "" };
    if (typeof delta.id === "string" && delta.id.length > 0) current.id = delta.id;
    if (typeof delta.function?.name === "string" && delta.function.name.length > 0) {
      current.name = delta.function.name;
    }
    if (typeof delta.function?.arguments === "string") current.args += delta.function.arguments;
    acc.calls.set(index, current);
  }
}

export function finishToolCalls(acc: ToolCallAccumulator): ToolCall[] {
  return [...acc.calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.args || "{}" },
    }));
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 500) : `HTTP ${status}`;
}

export class Provider implements ChatProvider {
  readonly model: string;
  private readonly options: ProviderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProviderOptions) {
    this.options = options;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private headers(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": `vibeagent/${this.options.clientVersion ?? "0.1.0"}`,
      "X-KiloCode-Version": this.options.clientVersion ?? "0.1.0",
    };
    if (this.options.apiKey) headers["Authorization"] = `Bearer ${this.options.apiKey}`;
    if (this.options.mode) headers["x-kilocode-mode"] = this.options.mode;
    return headers;
  }

  async stream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks = {},
  ): Promise<StreamResult> {
    const maxRetries = this.options.maxRetries ?? 3;
    let attempt = 0;
    let emitted = false;

    while (true) {
      try {
        return await this.streamOnce(messages, tools, callbacks, () => {
          emitted = true;
        });
      } catch (error) {
        const isProviderError = error instanceof ProviderError;
        const retryable = isProviderError ? error.retryable : isAbort(error) ? false : true;
        attempt++;
        if (callbacks.signal?.aborted || !retryable || attempt > maxRetries || emitted) throw error;
        const delay = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await sleep(delay, callbacks.signal);
      }
    }
  }

  private async streamOnce(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    markEmitted: () => void,
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(cleanMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body["tools"] = tools;
      body["tool_choice"] = "auto";
    }

    const signal = combineSignals(callbacks.signal, this.options.timeoutMs ?? 180_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ProviderError(describeNetworkError(error), undefined, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        errorMessage(response.status, text),
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    if (!response.body) throw new ProviderError("Gateway returned an empty response body", undefined, true);

    const parser = new SseParser();
    const decoder = new TextDecoder();
    const accumulator = createAccumulator();
    let content = "";
    let reasoning = "";
    let usage: Usage = {};
    let finish: string | null = null;
    let model: string | null = null;

    const handle = (payload: string): void => {
      if (payload === "[DONE]") return;
      let chunk: {
        model?: string;
        error?: { message?: string } | string;
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_details?: Array<{ text?: string }>;
            tool_calls?: unknown;
          };
          finish_reason?: string | null;
        }>;
        usage?: Usage;
      };
      try {
        chunk = JSON.parse(payload) as typeof chunk;
      } catch {
        return;
      }

      if (chunk.error) {
        const message =
          typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "stream error";
        throw new ProviderError(message, undefined, false);
      }

      if (typeof chunk.model === "string" && chunk.model !== model) {
        model = chunk.model;
        callbacks.onModel?.(chunk.model);
      }

      const choice = chunk.choices?.[0];
      if (choice?.delta) {
        const delta = choice.delta;
        const text = typeof delta.content === "string" ? delta.content : "";
        if (text.length > 0) {
          content += text;
          markEmitted();
          callbacks.onText?.(text);
        }
        let thinking = typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (thinking.length === 0 && Array.isArray(delta.reasoning_details)) {
          thinking = delta.reasoning_details.map((d) => d.text ?? "").join("");
        }
        if (thinking.length > 0) {
          reasoning += thinking;
          callbacks.onReasoning?.(thinking);
        }
        if (delta.tool_calls) accumulateToolCallDeltas(accumulator, delta.tool_calls);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    };

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) handle(payload);
      }
      for (const payload of parser.push(decoder.decode())) handle(payload);
      for (const payload of parser.flush()) handle(payload);
    } finally {
      reader.releaseLock();
    }

    const toolCalls = finishToolCalls(accumulator);
    if (usage.total_tokens === undefined && (content.length > 0 || reasoning.length > 0)) {
      usage = {
        ...usage,
        prompt_tokens: usage.prompt_tokens ?? estimateTokens(messages.map((m) => m.content ?? "").join(" ")),
        completion_tokens: usage.completion_tokens ?? estimateTokens(content),
      };
      usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    }

    return { content, reasoning, toolCalls, usage, finish, model };
  }
}

function cleanMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls && message.tool_calls.length > 0) out["tool_calls"] = message.tool_calls;
  if (message.tool_call_id) out["tool_call_id"] = message.tool_call_id;
  if (message.name) out["name"] = message.name;
  return out;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError")
  );
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `Network error (${cause.code}) while contacting the gateway`;
    return `Network error: ${error.message}`;
  }
  return "Unknown network error while contacting the gateway";
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface RemoteModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

/** Fetches the gateway model catalog. No authentication required. */
export async function fetchModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<RemoteModel[]> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Accept: "application/json", "User-Agent": "vibeagent/0.1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ProviderError(`Could not fetch models (HTTP ${response.status})`, response.status);
  const json = (await response.json()) as { data?: RemoteModel[]; models?: RemoteModel[] };
  return json.data ?? json.models ?? [];
}
