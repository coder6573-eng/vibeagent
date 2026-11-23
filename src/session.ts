import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "./types.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  title: string;
}

export interface SessionFile extends SessionMeta {
  messages: ChatMessage[];
}

function sessionId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
  const random = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${random}`;
}

export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user" && typeof message.content === "string");
  const text = first?.content?.replace(/\s+/g, " ").trim() ?? "untitled session";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export class SessionStore {
  readonly directory: string;

  constructor(directory = path.join(os.homedir(), ".vibeagent", "sessions")) {
    this.directory = directory;
  }

  private file(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  async create(cwd: string, model: string): Promise<SessionFile> {
    const now = new Date().toISOString();
    return {
      id: sessionId(),
      createdAt: now,
      updatedAt: now,
      cwd,
      model,
      title: "new session",
      messages: [],
    };
  }

  async save(session: SessionFile): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    session.updatedAt = new Date().toISOString();
    session.title = deriveTitle(session.messages);
    const target = this.file(session.id);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(temp, target);
  }

  async list(): Promise<SessionMeta[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    const sessions: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")) as SessionFile;
        sessions.push({
          id: parsed.id,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          cwd: parsed.cwd,
          model: parsed.model,
          title: parsed.title,
        });
      } catch {
        // ignore corrupt files
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }

  async load(id: string): Promise<SessionFile> {
    const raw = await fs.readFile(this.file(id), "utf8");
    return JSON.parse(raw) as SessionFile;
  }

  async latestFor(cwd: string): Promise<SessionFile | null> {
    const resolved = path.resolve(cwd);
    const candidates = (await this.list()).filter((session) => path.resolve(session.cwd) === resolved);
    const newest = candidates[0];
    if (!newest) return null;
    return await this.load(newest.id);
  }
}
