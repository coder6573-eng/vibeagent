import { promises as fs } from "node:fs";
import path from "node:path";

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".vibeagent",
  "target",
  "vendor",
  ".gradle",
  ".mypy_cache",
  ".pytest_cache",
]);

export const IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

export function isIgnoredName(name: string): boolean {
  return IGNORED_DIRS.has(name) || IGNORED_FILES.has(name);
}

/** Resolves `target` and refuses to leave the workspace root. */
export function resolveInside(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, target);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access a path outside the workspace: ${target}`);
  }
  return absolute;
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export interface WalkEntry {
  absolute: string;
  relative: string;
  isDirectory: boolean;
  size: number;
}

export interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
  includeIgnored?: boolean;
}

export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const maxDepth = options.maxDepth ?? 8;
  const maxEntries = options.maxEntries ?? 5000;
  let seen = 0;

  async function* visit(directory: string, depth: number): AsyncGenerator<WalkEntry> {
    if (depth > maxDepth || seen >= maxEntries) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      if (!options.includeIgnored && isIgnoredName(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        yield { absolute, relative, isDirectory: true, size: 0 };
        seen++;
        yield* visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fs.stat(absolute)).size;
        } catch {
          continue;
        }
        seen++;
        yield { absolute, relative, isDirectory: false, size };
      }
    }
  }

  yield* visit(path.resolve(root), 0);
}
