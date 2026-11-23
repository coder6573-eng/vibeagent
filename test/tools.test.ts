import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { defaultTools, executeTool } from "../src/tools/index.ts";
import type { ToolContext } from "../src/types.ts";

let workspace = "";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: workspace,
    yolo: true,
    signal: new AbortController().signal,
    approve: async () => true,
    ...overrides,
  };
}

async function run(name: string, args: Record<string, unknown>, ctx = context()) {
  return await executeTool(defaultTools, name, JSON.stringify(args), ctx);
}

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-test-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "app.ts"), "export const hello = 'world';\n", "utf8");
  await fs.writeFile(path.join(workspace, "README.md"), "# demo\n", "utf8");
  await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

test("read_file returns file contents", async () => {
  const result = await run("read_file", { path: "src/app.ts" });
  assert.equal(result.ok, true);
  assert.match(result.output, /export const hello/);
});

test("read_file rejects paths outside the workspace", async () => {
  const result = await run("read_file", { path: "../../etc/passwd" });
  assert.equal(result.ok, false);
  assert.match(result.output, /outside the workspace/);
});

test("write_file creates nested files", async () => {
  const result = await run("write_file", { path: "src/deep/new.ts", content: "export const x = 1;\n" });
  assert.equal(result.ok, true);
  const written = await fs.readFile(path.join(workspace, "src", "deep", "new.ts"), "utf8");
  assert.equal(written, "export const x = 1;\n");
});

test("write_file respects a declined approval", async () => {
  const result = await run("write_file", { path: "denied.ts", content: "nope\n" }, context({ yolo: false, approve: async () => false }));
  assert.equal(result.ok, false);
  await assert.rejects(fs.readFile(path.join(workspace, "denied.ts")));
});

test("edit_file replaces a unique match", async () => {
  const result = await run("edit_file", {
    path: "src/app.ts",
    old_string: "'world'",
    new_string: "'vibe'",
  });
  assert.equal(result.ok, true);
  assert.match(await fs.readFile(path.join(workspace, "src", "app.ts"), "utf8"), /'vibe'/);
});

test("edit_file refuses ambiguous matches without replace_all", async () => {
  const result = await run("edit_file", {
    path: "src/app.ts",
    old_string: "e",
    new_string: "E",
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /matches \d+ times/);
});

test("edit_file reports missing text", async () => {
  const result = await run("edit_file", {
    path: "src/app.ts",
    old_string: "not-there",
    new_string: "x",
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /not found/);
});

test("list_files hides ignored directories", async () => {
  const result = await run("list_files", { path: ".", depth: 3 });
  assert.equal(result.ok, true);
  assert.match(result.output, /src\//);
  assert.doesNotMatch(result.output, /node_modules/);
});

test("grep finds matches and honors include globs", async () => {
  const result = await run("grep", { pattern: "hello", include: "*.ts" });
  assert.equal(result.ok, true);
  assert.match(result.output, /src\/app\.ts:\d+/);

  const miss = await run("grep", { pattern: "hello", include: "*.md" });
  assert.equal(miss.ok, true);
  assert.match(miss.output, /No matches/);
});

test("unknown tools return a helpful error", async () => {
  const result = await run("does_not_exist", {});
  assert.equal(result.ok, false);
  assert.match(result.output, /Unknown tool/);
});

test("missing required arguments are reported", async () => {
  const result = await run("read_file", {});
  assert.equal(result.ok, false);
  assert.match(result.output, /missing required argument "path"/);
});
