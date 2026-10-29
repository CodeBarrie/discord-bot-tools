# Discord Bot tools

Tools for running a Discord bot backed by Claude Code. The main one is the desk: people on your team tag the bot in a channel, and a hidden Claude Code worker on your machine picks the request up, does the work in the right project folder and answers in a thread. Nothing opens a window, nothing collides with whoever is working at the keyboard, and nobody gets pinged for routine replies.

The code is small (Node 18+, no dependencies). Most of the value is in the rules below, which came out of running a desk like this day to day for a small production team.

## Read this before you install

By default the hidden workers run with Claude Code's `bypassPermissions` mode. Anyone on the desk's `allow` list can then get Claude to do anything your user account can do on that machine. Only list people you would trust at your keyboard. If that is too much, narrow the workers (`worker.permissionMode: "dontAsk"` with an explicit tool list, plus `settingSources: "user"`); `desk.locked-down.example.json` shows a full setup.

## The rules

**When it answers.** Only a message with the bot tagged in it, or a Discord Reply to one of the bot's own posts. Everything else in the channel, including plain messages in threads the bot started, is people talking to each other, and the desk stays out of it. Only listed people can wake it (`allow` in the config). Another desk's bot can too, if it is listed in `peerDesks` and tags this bot explicitly (see "Desks asking each other" below); every other bot is ignored. A message that only acknowledges (thanks, praise, "lgtm", "merging now", a bare 👍) gets a 👍 reaction and nothing else: no reply, no handoff notice, no worker. "Yes", "ok" and "done" are not treated that way, since they usually answer something the desk asked, and neither is anything with a question mark or a go.

**Where it answers.** Always in a thread. A tag in the main channel gets a thread opened off that message. Replies carry no @mention. The worker can mark a reply critical by starting it with `[ping]` (a decision blocking the work, a failure only the asker can unblock), and only then is the person who asked pinged.

**Pool, then go.** Questions and small fixes with no render run straight away. Anything major (re-cuts, renders, design revisions) goes on the project's change list, and the reply shows the numbered list and asks for a go. "@YourBot go for it" (or "go ahead", "ship it", "that's everything", a bare "go") runs the whole list in one pass with one render. This replaces a loop of one eight-minute render per note. "Urgent" or "just this one" runs a single item on its own.

**Finished means finished.** `node desk.js finished "<project>"` marks a project done. From then on it loses ambiguous matches to projects still in progress, and any fix to it goes on the change list and waits for a go, because a finished project has usually been delivered and every change is visible to someone. `--off` reopens it.

**Don't talk over people.** Before a worker starts, the desk rereads the thread. If someone other than the asker has replied since the request, it counts as answered and nothing is posted. Workers also get the recent thread as context, and answer `[skip]` when a message turns out to be meant for a person rather than the bot.

**The operator comes first.** The operator is the person whose machine runs the desk. While their own Claude Code session in a project folder is active (a hook heartbeat from the last 15 minutes), a request from someone else is handed to them instead of starting a worker: a short note in the thread, a desktop notification, and the request injected into their next prompt. If they leave without picking it up, the desk takes it back after 20 minutes. The operator's own tags always go to a worker.

**The asker can run processing.** When the operator isn't around, a request, or a go on the change list, is enough to run renders, re-cuts and other jobs, as long as the machine is free. Nobody has to sign off first. Publishing, deleting and anything touching money stay off-limits for everyone (that lives in the worker brief, so edit it to suit).

**The machine comes first too.** A worker never starts while the machine is busy (average GPU utilization of 40% or more over a minute, an NVENC export, or a listed render process; CPU load on a machine without an NVIDIA card). The request waits in a queue and the thread is told once that the machine is under load.

**Memory.** Each project has its own Claude session, created on the first request and resumed on every later one, so "make that cut shorter" a day later still knows which cut. It is never the operator's own live session. A loose follow-up in the channel that names no project continues the author's last project, if they asked within two hours.

## How a request finds its project

Every folder directly under one of your `projectRoots` is a project (folders starting with `.` or `_` are skipped). A request goes to the project whose folder name appears in the thread name or the messages. Failing that, it goes to the one project that shares a distinctive word with the text ("globex" finds `Globex Website`). If two projects match and one is finished, the open one wins. Add `aliases` when people call a project something its folder name doesn't say:

```json
"aliases": { "Acme Rebrand 2026": ["acme", "logo refresh"] }
```

A request that matches nothing runs in the first project root, and the worker is told which folders were candidates.

## What is in here

| File | What it does |
|---|---|
| `desk.js` | The daemon and its commands (`status`, `doctor`, `install`, `uninstall`, `stop`, `say`, `pool`, `finished`) |
| `desk/brief.md` | The worker's standing instructions: tone, boundaries, pool-then-go, finished projects. Copy it and edit the copy to change how the desk behaves. |
| `desk/gpu.js` | The load gate |
| `desk/hook.js` | The presence hook for the operator's Claude Code sessions |
| `lib/discord.js` | The Discord REST calls the desk makes (no gateway, so it can share a token with a bot that runs elsewhere) |
| `lib/drive-share.js` | Opens a Google Drive file or folder to anyone with the link (view only), through the Drive API with rclone's login. Off unless `driveSharing` is on; `node lib/drive-share.js <url>` does it by hand, `--check` reports what a logged-out visitor sees. |
| `desk.example.json` | The smallest working config: copy to `~/.discord-desk.json` and edit |
| `desk.locked-down.example.json` | Narrowed workers, a borrowed token, aliases and a peer desk |
| `test/` | `npm test` (or `node --test`). Covers which messages wake the desk, the peer-desk rules, project routing and what counts as a go. |

## Setup

Runs on Windows, macOS and Linux. Needs Node 18 or newer and Claude Code signed in on that machine (it finds `claude` in `~/.local/bin` or on your PATH; set `"claude"` in the config to point elsewhere). The load gate uses `nvidia-smi` when there is an NVIDIA card and falls back to CPU load elsewhere.

### Your own bot

Each desk needs its own Discord bot. If two machines answer through the same bot, every tag gets two replies.

1. In the [Discord developer portal](https://discord.com/developers/applications), create an application, add a bot, and switch on the **Message Content** intent under Bot.
2. Invite it to the server (OAuth2 URL generator, scope `bot`) with View Channels, Read Message History, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions and Attach Files.
3. Copy the bot token. People wake your desk by tagging this bot, so give it a name that makes that obvious.

### Using a bot you already run

If you already have a bot in the channel (say, one that a Claude Code MCP server posts through), the desk can run through it. It only uses Discord's REST API, so it doesn't disturb a gateway connection that bot already has. Point the desk at the file that already holds the token instead of copying it:

```json
"discord": {
  "tokenFrom": { "file": "~/my-bot/.mcp.json", "key": "mcpServers.discord.env.DISCORD_TOKEN" },
  "channelId": "<channel id>"
}
```

The desk reads it in-process on each start. It never logs it, never puts it on a command line, and never hands it to a worker. After a rotation, restart the desk (`node desk.js stop`; the keepalive brings it back). Check the bot's channel permissions against the list above: a bot that only posts usually lacks Create Public Threads and Add Reactions, and a missing permission shows up as a 403 in the log on the first tag.

### Install

1. Clone this repo somewhere permanent (the startup entry points at it).
2. Copy `desk.example.json` to `~/.discord-desk.json` and fill it in:
   - `projectRoots`: the folders whose subfolders are your projects.
   - `operator`: you. Your live Claude Code sessions take handoffs, and your own tags always go to a worker.
   - `allow`: the Discord user IDs that can wake it (Developer Mode on, then right-click a name and Copy User ID).
   - `discord.channelId`: the channel it listens in.
3. Give it the bot's token: a `~/.discord-bot.json` with `{"token": "<bot token>"}`, the `DISCORD_BOT_TOKEN` environment variable, or `discord.tokenFrom` as above. Keep the token out of any repo. Paths may start with `~`.
4. Copy `desk/brief.md`, set `brief` in the config to the copy, and rewrite its "Working" section for your machine and tools.
5. Run `node desk.js doctor` until every line says ok, then `node desk.js --dry-run` for a while: it logs what it would do without posting, reacting or starting workers.
6. `node desk.js install`.

`install` sets the desk to start at login and restart if it stops: a Startup entry plus a five-minute keepalive task on Windows, a LaunchAgent on macOS, a systemd user service on Linux. It also adds the presence hooks to `~/.claude/settings.json` (backing the file up first) and starts the desk. `node desk.js uninstall` removes all of it.

Everything the desk keeps lives in `~/.discord-desk/`: the log is `desk.log`, each request leaves its prompt and output in `jobs/`, change lists are in `pools/`. `node desk.js status` shows the queue, the workers and the last few jobs.

## Options

All of these go in `~/.discord-desk.json`.

| Key | Default | What it does |
|---|---|---|
| `projectRoots` | required | Folders whose subfolders are projects. |
| `allow` | required | Discord user IDs that can wake the desk. |
| `operator` | none | `{ "id": "…", "name": "…" }`. Without it, nothing is ever handed off. |
| `discord.channelId` | from `~/.discord-bot.json` | The channel the desk listens in. |
| `discord.tokenFrom` | none | Read the token from another JSON file: `{ "file", "key" }`, where `key` is a dotted path. |
| `discord.mention` | the asker | Who a `[ping]` notifies, if not the person who asked. |
| `aliases` | none | Extra words or phrases that point at a project, keyed by folder name. |
| `brief` | `desk/brief.md` | Your own copy of the worker brief. |
| `claude` | `~/.local/bin/claude`, then PATH | Path to the Claude Code CLI. |
| `driveSharing` | `false` | Open every Google Drive link the desk posts to anyone with the link first (needs rclone with a Drive remote; `DESK_DRIVE_REMOTES` names them, default `gdrive`). |
| `peerDesks` | none | Other desks' bots that may ask this desk for something: `[{ "id": "<bot user id>", "name": "OtherDesk", "for": "Alex" }]`. See below. |
| `worker.permissionMode` | `bypassPermissions` | Permission mode for the hidden workers. `dontAsk` runs only the tools in `allowedTools` (plus read-only ones) and refuses the rest without asking, so a Discord message can never get a worker to run something the machine's owner did not list. |
| `worker.allowedTools` | none | Tool rules for `dontAsk`, in Claude Code's permission syntax (`"Edit"`, `"Bash(git status:*)"`, `"mcp__server__tool"`). The desk adds its own `say` and `pool` commands automatically; nothing else of `desk.js` is allowed. |
| `worker.disallowedTools` | none | Rules that are always refused, in any mode (`"Bash(git push origin main:*)"`). |
| `worker.settingSources` | Claude Code's default | Set `"user"` with `dontAsk`: otherwise the project's own `.claude/settings*.json` allow rules apply to the worker too. |
| `worker.mcpConfig` | none | MCP servers to load (with `settingSources: "user"`, the project's `.mcp.json` is skipped). |
| `worker.contextFiles` | none | Files appended to the worker's system prompt, e.g. a repo's `CLAUDE.md` that `settingSources: "user"` no longer loads. |
| `worker.maxWorkers` | 2 | How many workers may run at once. |

A config that exists but doesn't parse, or a `worker` section without a valid `permissionMode`, stops the desk rather than letting it fall back to defaults.

Environment variables, mostly for testing: `DESK_CONFIG` (config path), `DESK_DIR` (state folder), `DESK_PROJECT_ROOTS`, `DESK_ALLOW`, `DESK_CLAUDE`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_BOT_CONFIG` (token file path). The load gate reads `DESK_BUSY_UTIL` (default 40), `DESK_CLEAR_UTIL` (20) and `DESK_RENDER_PROCS` (comma list of process names that mean "busy", default `aerender.exe`).

## Desks asking each other

With two desks in one channel, one desk's worker sometimes needs the other machine: a worker on a laptop needs a render only the workstation can make. Without `peerDesks` that tag reaches nobody, because every bot's message is ignored. List the other desk's bot and its explicit tag becomes a request:

```json
"peerDesks": [{ "id": "<the other bot's user id>", "name": "OtherDesk", "for": "Alex" }]
```

`name` is how the log and the worker prompt refer to it. `for` is who that desk works for, used when its message carries no signature line such as "— Claude, for Alex". Both are labels only: a peer's request runs the same workers, with the same permissions, as a request from anyone on `allow`, and it grants nothing extra.

Two bots that answer each other can loop, so a peer's message counts only when:

- it comes from a listed bot's user. Never this desk's own bot, an unlisted bot or a webhook;
- it tags this bot (or its role) and Discord resolved the tag as a mention. A tag inside code or a quote (`> …`) doesn't count, even when Discord resolves it. A desk's own replies go out with mentions switched off, so a desk's automatic answer never wakes the other desk. What does is a deliberate tag through the bot's other tools, like an MCP server driven by someone's Claude session;
- it is not a Discord Reply to one of this desk's own posts. That is the peer answering, and answering it back is how the ping-pong starts;
- this desk has not already taken a peer request in that thread since a person on `allow` last posted there. One peer request per thread per human turn: if both sides keep tagging each other, each desk takes one and logs the rest as `ignored … hop limit` until someone posts in the thread. Only a person resets it, never time;
- fewer than six peer messages have been taken in the last hour, across all threads.

A thanks-only peer message gets the 👍 like anyone's. Refused peer messages get no reaction, only a log line naming the peer and whom it asked for. The worker prompt marks the request as coming from another desk and tells the worker that a tag back won't reach it. Each desk lists the other in its own config.

## For your own tools

A worker runs with `DESK_JOB` set to its job id. A long-running script the worker starts can post its own progress line into the job's thread: `require('<repo>/desk.js').progressTarget(process.env.DESK_JOB)` returns the Discord config and the thread to post in, opening the thread first if needed. `lib/discord.js` has the `send` call to post with.

## Status

This was pulled out of a desk that ran on a Windows production machine for a couple of weeks; the generic version here passes its tests and a dry run against a live server. The macOS and Linux paths (launchd, systemd, notifications, the CPU load fallback) are written and checked but have never run for real, so run `doctor` first and watch `~/.discord-desk/desk.log` after the first tag.

## Credits

Thanks to Conor Bronsdon ([@conorbronsdon](https://github.com/conorbronsdon)), who wrote the worker permission and isolation options, the acknowledgement reactions and the peer-desk mentions.

## License

MIT
