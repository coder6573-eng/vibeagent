import type { Tool, ToolContext, ToolResult, ToolSchema } from "../types.ts";
import { editFileTool, listFilesTool, readFileTool, writeFileTool } from "./fs.ts";
import { grepTool } from "./search.ts";
import { runCommandTool } from "./shell.ts";
import { updatePlanTool } from "./plan.ts";

export const defaultTools: Tool[] = [
  readFileTool,
  listFilesTool,
  grepTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  updatePlanTool,
];

export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function toolSchemas(tools: Tool[] = defaultTools): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Tool arguments were not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function executeTool(
  tools: Tool[],
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    const available = tools.map((candidate) => candidate.name).join(", ");
    return { ok: false, output: `Unknown tool "${name}". Available tools: ${available}` };
  }

  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(rawArgs);
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }

  for (const required of tool.parameters.required ?? []) {
    if (!(required in args)) {
      return { ok: false, output: `Error: missing required argument "${required}" for ${name}` };
    }
  }

  try {
    const result = await tool.run(args, ctx);
    const output =
      result.output.length > MAX_TOOL_OUTPUT_CHARS
        ? `${result.output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… output truncated (${result.output.length} chars total)`
        : result.output;
    return { ok: result.ok, output };
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }
}
