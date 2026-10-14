# dsh-easy-memory

> Long-term memory for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent: **one global user memory** shared across every workspace, plus **one project memory** per workspace under `.dshmem/`. Memory is injected, distilled, archived and promoted automatically.

[中文](README.md) | English

---

## Table of contents

- [What is this](#what-is-this)
- [Features](#features)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick verification](#quick-verification)
- [Usage](#usage)
- [Where memories live](#where-memories-live)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Development and testing](#development-and-testing)
- [Compatibility](#compatibility)

---

## What is this

Every new agent session starts from zero, so you keep repeating yourself: use pnpm not npm, write commit messages in Chinese, this project uses two-space indentation. `dsh-easy-memory` turns those statements into structured memories and carries them into every later request.

Four extraction categories (facts / preferences / relationships / follow-ups), injection into the system prompt, a visual Settings page for viewing and editing, a one-click switch, importing memory from other AI tools, plus shard archiving and cross-workspace promotion.

The plugin **depends only on Node built-ins** and imports no `@deepseek-ai/*` package, so it does not break when the host installation changes how it resolves modules.

---

## Features

| Feature | What it does |
|---|---|
| Automatic injection | Every prompt assembly carries the global user memory and the current workspace's project memory |
| Automatic distillation | After each turn, the session's own model extracts what is worth keeping and writes it into project memory |
| Shard archiving | When the active area crosses a day boundary or a size limit, old entries move into `shards/`; the index stays resident and shards are recalled on demand |
| Global promotion | When the same memory appears in more than one workspace, it is promoted to global user memory |
| Settings page | Settings → Memory: switch, add by category, edit in place, delete, view archive and promotion stats |
| Two interfaces | Four `memory_*` tools for the model; `/memory` and the Settings page for you |
| Conversation trail | Each turn's digest is appended to `.dshmem/journal/<date>.md` as raw material |
| Readable data | JSON is authoritative, and a human-readable `memory.md` view is regenerated alongside it |
| Zero dependencies | Only `node:fs`, `node:path`, `node:crypto` and `node:os` |

---

## How it works

```
                     ┌──────────────── global user memory ──────────────┐
                     │  <DSH_HOME>/easy-memory/memory.json              │
                     │  memory.md · state.json · promotion.json          │
                     │  shards/                                          │
                     └───────────────▲──────────────────────────────────┘
                                     │ promotion: same text in >= 2 workspaces
                                     │
   one turn ──► turn/end ──► distill ┘
        │                    │
        │                    └──► project memory  <workspace>/.dshmem/memory.json
        │                                          memory.md · shards/
        └──► journal/<date>.md

   next request ──► system-prompt section ──► global memory + project memory + usage rules
```

Three mechanisms matter:

**Injection.** The plugin registers a system-prompt section named `easy-memory`. The one on the root context carries the global memory only; when `agent/created` fires, a **same-named** section is registered in the agent scope, which shadows it under the Harness scoping rules and adds the project memory of that agent's working directory. Both stores are read into cache *before* the section is registered, so **the first request after a restart already sees memory**.

**Distillation.** When `turn/end` arrives, the plugin takes the turn's transcript and makes one model call using **the provider and model the session itself just used**, asking for a JSON array back, then writes the parsed entries into project memory. Only one distillation runs at a time, it has a timeout, and short turns are skipped.

**Archiving and promotion.** Before every write the plugin checks whether the active area crossed a day boundary, exceeded an entry count, or exceeded a byte count; if so it keeps the most recent entries and writes the rest into a shard. Every project-memory write is also recorded in the promotion ledger, and a text seen in multiple workspaces is promoted to global memory.

---

## Installation

The plugin installs through DeepSeek Harness's bundle mechanism. Put this repository anywhere, then ask the agent in a Harness session to run:

```
plugin_manager(action: "install_bundle", target: "<absolute path to this repository>")
```

Or use the command line, if that installation provides a `dsh` executable:

```
dsh plugin --profile <profile> add <absolute path to this repository>
```

Installation updates the profile's dependencies, selects the bundle, and applies the package's `cordis.patch.yml`. **Restart the Harness process afterwards** so both the Host half and the Client half load.

To remove it:

```
plugin_manager(action: "remove_bundle", target: "dsh-easy-memory")
```

Memory data is not deleted: `<DSH_HOME>/easy-memory/` and each workspace's `.dshmem/` remain, and you can remove them by hand.

---

## Quick verification

After installing and restarting:

1. **Check the paths.** Run `/memory path`; it should print the global directory, the project directory, the state file and the Settings entry point.
2. **Check injection.** Ask the agent to do anything; that turn's system prompt should contain a `## Long-term memory (dsh-easy-memory)` block.
3. **Write one entry.** Run `/memory add --kind preference I prefer pnpm over npm`; it should answer that it recorded the entry into `…/.dshmem`.
4. **Check the automatic path.** Start a new turn and ask the agent "which package manager do I prefer?". It should call `memory_search` before answering.
5. **Check the Settings page.** Open Settings; a **Memory** page should appear in the sidebar.

---

## Usage

### What happens automatically

You do not have to do anything for these four things:

1. memory is injected on every prompt assembly;
2. after each turn the plugin distills new memories (into project memory);
3. each turn's digest is appended under `.dshmem/journal/`;
4. stores are archived when they cross a day boundary or a size limit, and promoted when a text recurs across workspaces.

### Model tools

| Tool | Purpose |
|---|---|
| `memory_write` | Record one memory. Parameters: `scope` (`global` / `workspace`), `kind`, `text`, optional `tags` |
| `memory_search` | Keyword search over the active area and archived shards. Every whitespace-separated term must match; omit `query` to list recent entries |
| `memory_forget` | Delete memories. Pass `id` or `query`, at least one |
| `memory_status` | Report directories, active entry counts, shard counts, switches and promotion stats |

### `/memory` commands

| Command | Purpose |
|---|---|
| `/memory show` | Show global and project memory |
| `/memory add <text>` | Write to project memory (defaults to `fact`) |
| `/memory add --global <text>` | Write to global memory |
| `/memory add --kind preference <text>` | Choose the category |
| `/memory forget <id\|keywords>` | Delete matching memories |
| `/memory forget --global <keywords>` | Delete from global memory only |
| `/memory edit <id> <new text>` | Rewrite one memory in place |
| `/memory promote <id>` | Manually promote a project memory to global |
| `/memory promotions` | Show the promotion ledger (candidates and promoted) |
| `/memory distill` | Distill the last turn immediately |
| `/memory shards` | List archived shards on both sides |
| `/memory import <multi-line text>` | Import line by line into global memory |
| `/memory on` / `/memory off` | Switch memory on or off |
| `/memory path` | Show the storage directories |
| `/memory help` | Help |

### Settings page

Settings → **Memory** provides:

- the master switch (written to `state.json`, the same switch as `/memory off`);
- a category dropdown, a text field and an add button;
- **edit** and **delete** on every entry;
- a footer with the global directory, active date, shard count, distillation mode, injection scope and promotion stats.

This page manages the **global memory only**: the Settings page is root-scoped and has no session, so it cannot know which workspace you are in. Use `/memory` or the `memory_*` tools for project memory.

The data path is a set of same-origin HTTP routes the plugin registers itself, under `/dsh-easy-memory/*`: `summary`, `toggle`, `add`, `update`, `delete`.

---

## Where memories live

**Global user memory** (follows the person, shared across workspaces):

```
<DSH_HOME>/easy-memory/
    memory.json       main index (authoritative)
    memory.md         generated read-only view
    state.json        memory switch
    promotion.json    promotion ledger (shared across workspaces)
    shards/           archived shards
```

**Project memory** (follows the project):

```
<workspace>/.dshmem/
    memory.json       main index (authoritative)
    memory.md         read-only view
    shards/2026-10-13-1.json    archived shards
    journal/2026-10-14.md       per-turn conversation digests
```

`memory.json` is the single source of truth; `memory.md` is regenerated after every write and **editing it by hand is never read back**.

Main index shape:

```json
{
  "version": 2,
  "updatedAt": 1760000000000,
  "activeDate": "2026-10-14",
  "entries": [ /* entries of the active area */ ],
  "shards": [
    { "file": "shards/2026-10-13-1.json", "date": "2026-10-13", "count": 42, "createdAt": 1760000000000 }
  ]
}
```

One memory entry:

```json
{
  "id": "m-mv7j2u2j-8c895020",
  "kind": "preference",
  "text": "The user prefers answers in Chinese, keeping technical terms in English.",
  "tags": [],
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000,
  "hits": 1,
  "source": { "sessionId": "session-...", "at": 1760000000000 }
}
```

Writing the same text under the same category does not stack; it updates `updatedAt` and increments `hits`.

---

## Configuration

Configuration goes in the `config` section of `cordis.patch.yml`. The copy shipped with the package lists every key with comments, and all of them are optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `scope` | `both` | Injection scope: `both` / `global` / `workspace` |
| `globalDir` | empty | Global memory directory; empty means `<DSH_HOME>/easy-memory` |
| `workspaceDirName` | `.dshmem` | Workspace memory directory name |
| `sectionOrder` | `500` | Section sort order |
| `maxEntriesInPrompt` | `40` | Maximum entries injected per scope |
| `maxInjectChars` | `4000` | Total character cap for the injected text |
| `maxTextChars` | `500` | Character cap per entry in the prompt |
| `refreshMs` | `15000` | Interval for re-reading disk and checking the day boundary, in milliseconds |
| `journal` | `true` | Whether to write `.dshmem/journal/` |
| `journalMaxChars` | `1200` | Truncation length per message in the journal |
| `shardMaxEntries` | `200` | Archive once the active area exceeds this many entries |
| `shardMaxBytes` | `131072` | Archive once the serialized active area exceeds this many bytes |
| `keepActiveEntries` | `50` | How many recent entries the index keeps when archiving |
| `searchShards` | `10` | Maximum number of recent shards a search reads |
| `autoDistill` | `workspace` | Where distillation writes: `workspace` / `global` / `both` / `off` |
| `distillMinChars` | `200` | Skip distillation when the turn is shorter than this |
| `distillMaxInputChars` | `12000` | Cap on the transcript sent to the model |
| `distillMaxEntries` | `8` | Maximum entries distilled per turn |
| `distillTimeoutMs` | `60000` | Timeout for one distillation |
| `promoteEnabled` | `true` | Promotion switch |
| `promoteAfterWorkspaces` | `2` | How many distinct workspaces a text must appear in before promotion |
| `promoteMode` | `move` | `move` puts it in global and removes it from every workspace; `copy` keeps both |
| `promotionLedgerMax` | `2000` | Maximum ledger records; overflow is trimmed promoted-first, then most-recent |

For example, to inject global memory only and turn distillation off:

```yaml
- insert:
    - id: dsh-easy-memory
      name: dsh-easy-memory
      config:
        scope: global
        autoDistill: off
```

---

## FAQ

**Does project memory require the `/memory` command? Does it not read it by itself?**

It does read it by itself. Memory is **injected automatically on every prompt assembly**; `/memory` exists only so you can inspect and maintain it by hand. You can confirm this by asking the agent to do anything and checking whether that turn's system prompt contains a `## Long-term memory (dsh-easy-memory)` block with a `### Project memory (workspace: …)` line. The model-facing `memory_search` tool is also available automatically — you never have to type a command first.

**Does it write by itself?**

Yes. When a turn ends (`turn/end`), the plugin makes one distillation call with the model the session is already using and writes what is worth keeping into **project memory**. You can turn this off with `autoDistill: off`, or trigger it manually with `/memory distill`.

**Does distillation cost anything?**

Yes. It is a real model call on the provider and model your session is using, so it costs tokens and adds latency. Set `autoDistill: off` to avoid it and say "remember this" explicitly instead.

**How is "promotion to global" decided?**

The plugin's criterion is: **the same memory text was written in more than one distinct workspace.** The reasoning is that information belonging to a single project never gets written into another one. The threshold is `promoteAfterWorkspaces` (default 2). You can also promote manually with `/memory promote <id>`.

**I only ever work in one workspace. Will anything be promoted automatically?**

No — cross-workspace recurrence never happens. In that case promote manually with `/memory promote <id>`.

**Do memories expire?**

Entries do not expire automatically. They move into shards and step out of the injected section, but `memory_search` still finds them. To delete them, use `memory_forget` or `/memory forget`.

**Can it coexist with other memory plugins?**

Yes, but avoid both injecting the same kind of content into the system prompt. This plugin's section name is always `easy-memory` and its tool names are always `memory_*`.

---

## Development and testing

The plugin is one plain-ESM Host file and one Client file with no build step. After editing `index.js` or `client.js`, restart the Harness (the profile records a directory link).

```
index.js             Host half: section, four tools, /memory, HTTP backend, storage and promotion
client.js            Client half: the Settings "Memory" page
cordis.patch.yml     the shipped profile patch (every config key commented)
package.json         bundle manifest
locale/*.json        title and description for the plugin manager
icon.svg             original icon
DEVELOPMENT.md       design and verification record: trade-offs, incidents, per-item test list
```

Syntax check:

```bash
node --check index.js
node --check client.js
```

Testing without the Harness: copy `index.js` to an `.mjs` file and export the internals, or mount the plugin on a fake `ctx` by calling `apply()` and then driving the registered tools and commands directly. `DEVELOPMENT.md` records the full test list and verification status.

> Note: `index.js` writes through `node:fs`, so any test must pass a temporary `globalDir` and temporary workspaces, or it will write into your real memory directories.

---

## Compatibility

- Developed and verified against **DeepSeek Harness 0.2.1**.
- The Host half requires the `tools`, `systemPrompt`, `commands` and `workingDirectory` services to exist; `webServer` and `llm` are acquired optionally, and their absence only removes the Settings page or distillation while everything else keeps working.
