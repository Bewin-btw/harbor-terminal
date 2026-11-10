# Harbor

**Terminal sessions in a sidebar, like chats. Built for macOS.**

[Русская документация](README.ru.md) · [MIT license](LICENSE)

Harbor brings shells, SSH connections, Claude Code and Codex CLI into one window.
Switch between projects, pin important sessions, and close the window without
ending the programs running inside it.

Early release: **0.1.4**. The interface is currently in Russian. Builds target
**Apple Silicon Macs**; Intel, Windows and Linux are not supported by the current
packaging setup.

## What it does

- Real interactive terminals powered by xterm.js and node-pty.
- A searchable sidebar with named sessions, pinning, drag ordering and an archive.
- A separate local session manager that keeps processes alive when the UI closes.
- Pause and resume a session's local process tree.
- Import saved Claude/Codex conversations and continue them through their own CLI.
- Agent activity indicators: working, needs attention, response complete or idle.
- Color highlighting for your messages inside the full terminal, without a separate chat pane.
- Six themes, including light Paper, and a draggable scrollbar outside the content.
- Saved session metadata, working directories and terminal snapshots for recovery.
- Split view, project groups with git branches, cross-session output search.
- macOS notifications and a Dock badge when an agent finishes or needs you.
- Per-shell startup command with opt-in autostart, and one-click resume after a reboot.
- Drag files into a terminal to insert their escaped paths.

## What persistence means

| Event | What survives |
| --- | --- |
| Close/reopen the Harbor window or quit/relaunch the UI | The same live terminal processes and shell state, while the manager remains running. |
| Pause/resume | Local processes stay in memory. Network connections may time out; remote SSH jobs keep running. |
| Reboot, power loss or manager crash | Session cards, working directories and the last saved screen. Old processes are marked interrupted. Claude/Codex can resume their saved conversations. |

Harbor **cannot restore arbitrary process memory after a reboot**, guarantee an
uninterrupted SSH connection, or move a live Terminal.app process into Harbor.
Importing a conversation resumes saved CLI history, not a running process. Close
the previous instance of that conversation before opening it here.

Snapshots are written about every two seconds when output changes, with 4,000 to
20,000 lines of scrollback per session (Appearance dialog). Unsaved output may be lost in a crash.
Commands are never automatically replayed after a reboot, except a shell's
startup command when you explicitly enable autostart for it.

## Build and run

Requirements:

- macOS on Apple Silicon. The application was tested on macOS 15.6.
- Node.js **22.12 or newer**, with npm.
- Xcode Command Line Tools (`xcode-select --install`) for native dependencies.
- Claude Code and/or Codex CLI installed and signed in if you want those session types.
  Ordinary shell and SSH sessions do not require either agent.

```sh
git clone https://github.com/Bewin-btw/harbor-terminal.git
cd harbor-terminal
npm ci
npm start
```

To build the application:

```sh
npm run package
mkdir -p "$HOME/Applications"
ditto release/Harbor-darwin-arm64/Harbor.app "$HOME/Applications/Harbor.app"
open "$HOME/Applications/Harbor.app"
```

The build uses a local ad-hoc signature. It is **not Developer ID signed or
notarized**; macOS may show an unrecognized-developer warning. This repository
provides source for local builds, not a notarized download.

If Harbor is already installed, quit its UI before replacing the application.
Closing the UI leaves its background manager and sessions running. Changes to
manager code take effect only after that manager is restarted; finish live work
before doing so.

## Using Harbor

Choose **Новая сессия** (New session), select Terminal, Claude, Codex or SSH, and
pick a working directory. Use **Импорт диалогов** (Import conversations) to find
saved local Claude/Codex conversations.

| Shortcut | Action |
| --- | --- |
| `⌘N` | New session |
| `⌘K` | Find a session |
| `⌘O` | Import a saved conversation |
| `⌘F` | Search terminal output |
| `⇧⌘F` | Search the output of every session |
| `⌘T` | Shell in the current session's folder |
| `⌘D` | Split view: shell on the right (again to close) |
| `⌘1` … `⌘9` | Select a session |
| `⌘⌥↑` / `⌘⌥↓` | Previous / next session |
| `⌘+` / `⌘-` / `⌘0` | Font size |
| `⌘C` / `⌘V` | Copy / paste; `Ctrl+C` is sent to the program |

Right-click a session to rename, pin, stop or archive it. Drag its handle to
reorder it; `⌥↑` / `⌥↓` also move a focused sidebar item. **Оформление**
(Appearance) selects a theme. **Пауза** (Pause) suspends local processes without
freeing their memory.

For SSH jobs that must survive a disconnect, use a remote session manager such
as `tmux`. Harbor uses OpenSSH and your existing keys and `~/.ssh/config`.

## Agent compatibility

The current integrations were tested with **Claude Code 2.1.316** and
**Codex CLI 0.166.0**. They depend on CLI flags and local history formats that
may change between versions.

Claude sessions use `--session-id` or `--resume`. New Codex sessions first create
a durable thread through a local `codex app-server`, then launch
`codex resume ID --no-daemon`. Creating the empty thread does not submit a prompt
or request model generation. Model settings, authentication and permissions come
from the existing CLI configuration.

Activity indicators read local session records and journals. Unsupported states
are shown as an open session, not guessed from an inactivity timeout. Permission
prompts can also be recognized from the current screen; recognition is not a
guarantee that every CLI dialog will be detected.

In an alternate-screen Claude/Codex interface, the scrollbar sends native scroll
and navigation events to the CLI. Its position is **approximate**, because the
CLI does not expose the exact length of its internal history. Message coloring
also depends on saved history and the CLI's rendered layout.

## Local data and permissions

Harbor stores session cards, screen snapshots and a manager log in:

```text
~/Library/Application Support/Harbor/
```

The directory is created with mode `0700`, and persisted session files with mode
`0600`. Terminal output can contain secrets. Harbor does not encrypt those files.
The importer reads existing CLI histories without rewriting them.

The UI talks to the manager over a local Unix socket with mode `0600`. Harbor
has no network server. Programs you launch, including AI agents and SSH, still
use their own network connections and permissions.

macOS may attribute file-access requests from commands inside Harbor to
**Harbor.app**. For example, an agent reading Telegram's internal data can
trigger macOS privacy prompts. Prefer exporting the specific files you need to
a project folder. Granting Full Disk Access to Harbor also broadens access for
the programs running inside it.

## Development and checks

```sh
npm test
npm run build:ui
```

Additional checks on macOS:

```sh
npm run test:integration
node scripts/ui-smoke.cjs
node scripts/ui-native-terminal.cjs
```

Integration tests launch real processes in temporary directories. They require
**Python 3 and an installed Codex CLI**; one test creates an empty Codex thread
using an isolated `CODEX_HOME`. GUI tests require a graphical macOS session;
the native-terminal test uses `/usr/bin/python3` to emulate an agent terminal.
They use temporary Harbor data directories, not your saved sessions.

To test a packaged build:

```sh
node scripts/ui-smoke.cjs --app release/Harbor-darwin-arm64/Harbor.app/Contents/MacOS/Harbor
node scripts/ui-native-terminal.cjs --app release/Harbor-darwin-arm64/Harbor.app/Contents/MacOS/Harbor
```

The main components are `src/main.cjs` (Electron and IPC), `src/daemon.cjs`
(persistent PTYs), `src/renderer.js` (UI), `src/core.cjs` (storage and import),
and `src/activity.cjs` / `src/conversation.cjs` (read-only CLI history adapters).

Report reproducible problems through [Issues](https://github.com/Bewin-btw/harbor-terminal/issues).
Include macOS and CLI versions, but remove private terminal output, credentials
and conversation data from logs or screenshots.

## License

[MIT](LICENSE) © 2026 Erik Aktaev.

Harbor uses Electron, xterm.js, node-pty and other open-source packages. Their
licenses remain with their respective authors; dependencies are listed in
`package.json` and pinned in `package-lock.json`. Claude, Codex and SSH are
separate programs and are not bundled with Harbor.
