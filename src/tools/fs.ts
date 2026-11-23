import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { formatBytes, renderDiff, truncateLines } from "../ui.ts";
import { resolveInside, walk } from "./util.ts";

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

function stringArg(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (required) throw new Error(`Missing required string argument "${key}"`);
  return "";
}

async function confirmWrite(
  ctx: ToolContext,
  title: string,
  detail: string,
  preview: string,
): Promise<boolean> {
  if (ctx.yolo) return true;
  return ctx.approve({ kind: "write", title, detail, preview });
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Returns the file contents. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      offset: { type: "number", description: "1-based line to start at. Optional." },
      limit: { type: "number", description: "Maximum number of lines to return. Defaults to 2000." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const absolute = resolveInside(ctx.cwd, stringArg(args, "path"));
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) throw new Error(`${args["path"]} is a directory, use list_files instead`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File is too large to read (${formatBytes(stat.size)}). Read a slice with offset/limit.`);
    }
    const raw = await fs.readFile(absolute, "utf8");
    if (raw.includes("\u0000")) throw new Error("File appears to be binary");

    const lines = raw.split("\n");
    const offset = Math.max(1, typeof args["offset"] === "number" ? Math.floor(args["offset"]) : 1);
    const limit = Math.max(1, typeof args["limit"] === "number" ? Math.floor(args["limit"]) : DEFAULT_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const header =
      lines.length > slice.length
        ? `# ${args["path"]} (lines ${offset}-${offset + slice.length - 1} of ${lines.length})\n`
        : "";
    return { ok: true, output: header + slice.join("\n") };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a file or overwrite it completely. Parent directories are created automatically. Prefer edit_file for small changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const relative = stringArg(args, "path");
    const content = stringArg(args, "content");
    const absolute = resolveInside(ctx.cwd, relative);
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error(`Refusing to write more than ${formatBytes(MAX_WRITE_BYTES)} in one call`);
    }

    let previous = "";
    try {
      previous = await fs.readFile(absolute, "utf8");
    } catch {
      // new file
    }

    const verb = previous.length > 0 ? "Overwrite" : "Create";
    const preview = renderDiff(previous, content, 40);
    const approved = await confirmWrite(
      ctx,
      `write_file ${relative}`,
      `${verb} ${relative} (${content.split("\n").length} lines, ${formatBytes(Buffer.byteLength(content, "utf8"))})`,
      preview,
    );
    if (!approved) return { ok: false, output: "User declined the write." };

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
    return { ok: true, output: `Wrote ${relative} (${formatBytes(Buffer.byteLength(content, "utf8"))}).` };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in an existing file. old_string must match exactly once unless replace_all is true. Read the file first so the match is accurate.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      old_string: { type: "string", description: "Exact text to find, including indentation." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Defaults to false." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const relative = stringArg(args, "path");
    const oldString = stringArg(args, "old_string");
    const newString = stringArg(args, "new_string");
    const replaceAll = args["replace_all"] === true;
    const absolute = resolveInside(ctx.cwd, relative);

    if (oldString.length === 0) throw new Error("old_string must not be empty");

    const previous = await fs.readFile(absolute, "utf8");
    const occurrences = previous.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(
        "old_string was not found. Read the file again and copy the exact text, including indentation and line endings.",
      );
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${occurrences} times. Add more surrounding context or pass replace_all: true.`,
      );
    }

    const updated = replaceAll
      ? previous.split(oldString).join(newString)
      : previous.slice(0, previous.indexOf(oldString)) +
        newString +
        previous.slice(previous.indexOf(oldString) + oldString.length);

    const preview = renderDiff(previous, updated, 40);
    const approved = await confirmWrite(
      ctx,
      `edit_file ${relative}`,
      `Edit ${relative} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
      preview,
    );
    if (!approved) return { ok: false, output: "User declined the edit." };

    await fs.writeFile(absolute, updated, "utf8");
    return {
      ok: true,
      output: `Updated ${relative} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`,
    };
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and folders in the workspace as a tree. Skips node_modules, .git, dist and similar directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace root. Defaults to '.'." },
      depth: { type: "number", description: "Maximum depth. Defaults to 3, max 8." },
    },
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const relative = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : ".";
    const depth = Math.min(8, Math.max(1, typeof args["depth"] === "number" ? Math.floor(args["depth"]) : 3));
    const root = resolveInside(ctx.cwd, relative);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`${relative} is not a directory`);

    const lines: string[] = [];
    let count = 0;
    let truncated = false;
    for await (const entry of walk(root, { maxDepth: depth, maxEntries: 600 })) {
      if (count++ >= 400) {
        truncated = true;
        break;
      }
      const segments = entry.relative.split("/");
      const indent = "  ".repeat(Math.max(0, segments.length - 1));
      const name = segments.at(-1) ?? entry.relative;
      if (entry.isDirectory) {
        lines.push(`${indent}${name}/`);
      } else {
        lines.push(`${indent}${name}  ${formatBytes(entry.size)}`);
      }
    }

    if (lines.length === 0) return { ok: true, output: `(empty directory: ${relative})` };
    const header = `${relative === "." ? "workspace" : relative}/`;
    const footer = truncated ? "\n… listing truncated, use a narrower path" : "";
    return { ok: true, output: `${header}\n${lines.join("\n")}${footer}` };
  },
};
