import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { resolveInside, walk } from "./util.ts";

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const options = glob
          .slice(i + 1, end)
          .split(",")
          .map((option) => option.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${options.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines as path:line: text. Use this to find symbols and usages before editing.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression source." },
      path: { type: "string", description: "Directory or file to search. Defaults to '.'." },
      include: {
        type: "string",
        description: 'Optional glob filter such as "*.ts" or "src/**/*.{ts,tsx}".',
      },
      case_sensitive: { type: "boolean", description: "Defaults to false." },
      max_results: { type: "number", description: "Defaults to 100, max 400." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"] : "";
    if (pattern.length === 0) throw new Error("pattern is required");
    const base = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : ".";
    const include = typeof args["include"] === "string" ? args["include"] : "";
    const caseSensitive = args["case_sensitive"] === true;
    const maxResults = Math.min(400, Math.max(1, typeof args["max_results"] === "number" ? args["max_results"] : 100));

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    const matcher = include.length > 0 ? globToRegExp(include) : null;
    const root = resolveInside(ctx.cwd, base);
    const stat = await fs.stat(root);

    const matches: string[] = [];
    let filesScanned = 0;

    const scanFile = async (absolute: string, relative: string): Promise<void> => {
      if (matcher) {
        const target = include.includes("/") ? relative : relative.split("/").at(-1)!;
        if (!matcher.test(target)) return;
      }
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        return;
      }
      if (stat.size > 1024 * 1024) return;
      let content: string;
      try {
        content = await fs.readFile(absolute, "utf8");
      } catch {
        return;
      }
      if (content.includes("\u0000")) return;
      filesScanned++;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i]!)) {
          matches.push(`${relative}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
          if (matches.length >= maxResults) return;
        }
      }
    };

    if (stat.isFile()) {
      await scanFile(root, base.replace(/^\.\//, ""));
    } else {
      for await (const entry of walk(root, { maxDepth: 12, maxEntries: 4000 })) {
        if (entry.isDirectory) continue;
        await scanFile(entry.absolute, entry.relative);
        if (matches.length >= maxResults) break;
      }
    }

    if (matches.length === 0) return { ok: true, output: `No matches for /${pattern}/.` };
    const footer = matches.length >= maxResults ? `\n… stopped at ${maxResults} matches` : "";
    return { ok: true, output: `${matches.join("\n")}${footer}` };
  },
};
