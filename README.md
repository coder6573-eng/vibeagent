# ◆ Vibe Agent

A keyless terminal coding agent. It reads your code, edits files, runs commands and keeps going until the task is done — with no API key, no runtime dependencies and no config file.

```
› add a /health endpoint to server.ts and a test for it

  ● update_plan 3 step(s)
    └ Plan (0/3 done)
  ● read_file src/server.ts
    └ 48 lines
  ● edit_file src/server.ts
    └ Updated src/server.ts (1 replacement)
  ● write_file test/health.test.ts
    └ Wrote test/health.test.ts (18 lines)
  ● run_command npm test
    └ 12 lines
◆ Added GET /health with a JSON status payload and a matching test. All tests pass.
```

## Why Vibe Agent

- **Keyless by default.** It talks to the [Kilo AI Gateway](https://kilo.ai/docs/gateway) anonymously and uses `kilo-auto/free`, which routes to a free model per session. No signup, no credit card, 200 requests/hour per IP.
- **Zero runtime dependencies.** Node 22.18+ runs the TypeScript directly. No build step, no `node_modules` at runtime, no SDK.
- **Real tools, not a chat wrapper.** Files, grep, shell, plans — the agent loops until it has verified its work.
- **Safe by default.** File writes and shell commands ask for approval, paths are locked to the workspace, and every session is saved.

## Quickstart

Requires **Node 22.18+** (Node 24 recommended).

```bash
git clone https://github.com/coder6573-eng/vibeagent.git
cd vibeagent
node src/cli.ts
```

Install it globally so `vibe` works anywhere:

```bash
npm install -g .
cd ~/projects/my-app
vibe
```

One-shot mode:

```bash
vibe "explain what this repo does"
vibe "fix the failing test in src/parser.test.ts"
vibe --yolo "add a dark mode toggle and run the tests"
```

## Usage

```
vibe                        start an interactive session
vibe "fix the failing test"  run one prompt and exit
vibe models                 list free models from the gateway
vibe --help                 show all options
```

| Option | Description |
| --- | --- |
| `-m, --model <id>` | Model id. Default: `kilo-auto/free` |
| `--base-url <url>` | Any OpenAI-compatible gateway |
| `--api-key <key>` | Optional. Anonymous free tier works without one |
| `--mode <mode>` | Routing hint for `kilo-auto`: `build`, `plan`, `debug`, `code`, `ask` |
| `-y, --yolo` | Skip approval prompts (writes and shell) |
| `-r, --reasoning` | Stream the model's reasoning |
| `--cwd <dir>` | Workspace directory. Default: current directory |
| `--max-steps <n>` | Tool-loop limit per turn. Default: 40 |
| `-c, --continue` | Resume the latest session in this directory |
| `--resume <id>` | Resume a specific session |
| `--no-color` | Disable colors |

### In-session commands

| Command | What it does |
| --- | --- |
| `/help` | Show help |
| `/model <id>` | Switch model mid-session |
| `/models` | List free models |
| `/status` | Show model, workspace, session, tokens, cost |
| `/clear` | Reset the conversation, keep the session |
| `/new` | Start a fresh session |
| `/sessions` | List saved sessions |
| `/resume <id>` | Load a saved session |
| `/reasoning` | Toggle reasoning output |
| `/yolo` | Toggle approvals |
| `/exit` | Quit |

`Ctrl+C` cancels the current turn without leaving the app; press it again at the prompt to quit.

## Models

The default gateway is `https://ai-gateway.kilo.ai/api/v1` and the default model is `kilo-auto/free`.

```bash
vibe models
```

Free models are tagged `:free` (for example `minimax/minimax-m2.1:free`, `z-ai/glm-5:free`) and the `kilo-auto/*` tiers are virtual routers:

| Model | Behavior |
| --- | --- |
| `kilo-auto/free` | Picks a free model per session, $0 |
| `kilo-auto/efficient` | Classifies task difficulty, routes to the cheapest capable model |
| `kilo-auto/frontier` | Highest capability (needs account credits) |
| `kilo-auto/small` | Small/fast model for background tasks |

Add a key for paid models, higher limits or BYOK:

```bash
export VIBE_API_KEY=your_key
vibe --model anthropic/claude-sonnet-4.6
```

Any OpenAI-compatible endpoint works, including Ollama and LM Studio:

```bash
vibe --base-url http://localhost:11434/v1 --model qwen3-coder
```

## Tools

| Tool | Purpose | Approval |
| --- | --- | --- |
| `read_file` | Read a file, with `offset`/`limit` for large files | — |
| `list_files` | Tree view, skips `node_modules`, `.git`, `dist`, … | — |
| `grep` | Regex search with `include` globs | — |
| `edit_file` | Exact-string replacement with a diff preview | ✅ |
| `write_file` | Create or overwrite a file | ✅ |
| `run_command` | Shell command with timeout and output cap | ✅ |
| `update_plan` | Publish a 3–7 step checklist | — |

Every path is resolved inside the workspace root; `../` escapes are rejected. Destructive commands (`rm -rf`, `git reset --hard`, force pushes, …) are flagged in the approval prompt.

## Sessions

Sessions are saved to `~/.vibeagent/sessions/<id>.json` after every turn, so a crash or `Ctrl+C` never loses the conversation.

```bash
vibe --continue        # latest session for this directory
vibe --resume 20261121-212630-uyi2
```

## Configuration

| Variable | Default |
| --- | --- |
| `VIBE_MODEL` | `kilo-auto/free` |
| `VIBE_BASE_URL` | `https://ai-gateway.kilo.ai/api/v1` |
| `VIBE_API_KEY` | _(empty — anonymous)_ |
| `VIBE_MODE` | `build` |
| `VIBE_YOLO` | `0` |

Copy `.env.example` if you prefer a file; Vibe Agent reads the environment, so `export` or your shell's env loader works too.

## How it works

```
src/
  cli.ts        argument parsing, REPL, approvals, slash commands
  agent.ts      the tool loop, context compaction, usage tracking
  provider.ts   OpenAI-compatible streaming client (SSE, retries, tool calls)
  prompt.ts     system prompt with a workspace snapshot
  session.ts    JSON session persistence in ~/.vibeagent
  tools/        read, write, edit, list, grep, shell, plan
  ui.ts         colors, diff rendering, spinner — no dependencies
```

Each turn: stream the model's reply → if it requested tools, run them (with approvals) and append the results → repeat until the model answers without tools or the step limit is hit. If the transcript grows past ~320k characters, the oldest exchanges are dropped while keeping the system prompt and tool-call pairs intact.

## Development

```bash
npm install        # dev-only: typescript + @types/node
npm run check      # typecheck + 21 unit tests
npm start          # run the CLI
```

Tests cover the SSE parser, tool-call accumulation, the agent loop (tool execution, declined approvals, step limits, aborts), path-escape rejection and every filesystem tool.

## Roadmap

- [ ] Web UI on the same core (`vibe serve`)
- [ ] MCP server support
- [ ] Image/screenshot input
- [ ] Sub-agents and parallel tool execution
- [ ] `AGENTS.md` project instructions loading
- [ ] Cost budgets and per-session spend caps

## License

MIT
