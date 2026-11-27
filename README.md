# Herdr Workstation

One command turns [Herdr desktop](https://herdr.dev) into a full agent workstation: review your
agent's changes and send comments back to it, a git graph, live Markdown preview, a real browser
beside the agent, and Claude Code / Codex usage limits in the status bar.

![Workstation](layouts/workstation.svg)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mayurdluffy/herdr-workstation/main/install.sh | bash
```

Needs Herdr desktop (started once), `git`, `curl` and `python3`. macOS or Linux.
Run the same command again to update. Options (after `bash -s --`):

| Option | Skips |
|---|---|
| `--no-browser` | Rust, the browser build and Chrome for Testing |
| `--no-agent-skills` | the browser's skill for Claude Code and its section in Codex/OpenCode/Pi `AGENTS.md` |
| `--no-switch` | switching to the Workstation layout at the end |

Uninstall: `bash ~/.local/share/herdr-workstation/uninstall.sh`.

## What you get

| Key (macOS / Linux) | Does |
|---|---|
| `cmd-shift-k` / `ctrl-alt-k` | **Workstation menu**, acting for the focused agent |
| `cmd-shift-g` / `ctrl-alt-g` | Git graph beside the focused pane |
| `cmd-shift-b` | Browser menu (herdr-web-browser) |
| Ctrl/Cmd-click a `.md` path | Markdown preview beside that pane |

The menu (one key each):

- **R** Review changes: the uncommitted diff in [plannotator-tui](https://github.com/plannotator/plannotator-tui); select lines, comment or suggest code, **Send** makes it the agent's next message.
- **P** Pick what to review: staged, unstaged, branch, a commit or a PR.
- **L** Review the agent's last reply and send feedback.
- **D** Annotate the Markdown docs in this folder.
- **A** Approve a plan: Approve, or send numbered feedback.
- **G** Git graph: every branch, refs as badges; click a commit for its diff, **Review in plannotator** or **Send to agent**.
- **M** Preview Markdown: live preview that reloads on save; select text and **Send selection to agent**, or **Annotate**.
- **B** Browser: [herdr-web-browser](https://github.com/MattJColes/herdr-web-browser) in a pane beside the agent. You and the agent see the same page; send screenshots, page text or a clicked element; the agent reads console and network.
- **U** Refresh usage limits.

The status bar's right half is [usage-limits](https://github.com/VladTemp27/herdr-mods): Claude Code and
Codex 5-hour and weekly limits, reset times and plan. Hover for details and the current session's
context. It asks the `claude` and `codex` CLIs themselves and never reads a token.

## How it installs

Everything goes into Herdr's home (`~/.config/herdr-app`, or `$HERDR_APP_HOME`):

- `layouts/workstation.json`: Herdr's main layout plus the usage bar and the Markdown link handler.
- `mods/ws-menu`, `mods/ws-git-graph`, `mods/ws-md-preview`: this repo's mods.
- `mods/usage-limits` and herdr-web-browser's mods: third-party, pinned in [`vendor.lock`](vendor.lock).
- `keys.json`: our keys are added only where the key is free; yours are never replaced.

A mod folder is only replaced when it carries our `.herdr-workstation` marker, so a mod of yours
with the same name is left alone. Each mod passes `herdr-app check` before the install reports success.
Tools: `plannotator-tui` (Homebrew, else cargo), Rust via rustup if missing, herdr-web-browser built
from its pinned commit in `~/.local/share/herdr-workstation/`.

## Develop

Edit a mod in `mods/`, run `./install.sh --no-browser` (it installs from the checkout it's in), and
Herdr reloads it live. `herdr-app check mods/<name>` must pass. To bump a third-party pin, read its
diff first, then change the ref in `vendor.lock`.

## Credits

[usage-limits](https://github.com/VladTemp27/herdr-mods) (Apache-2.0, VladTemp27),
[herdr-web-browser](https://github.com/MattJColes/herdr-web-browser) (MIT, MattJColes),
[plannotator-tui](https://github.com/plannotator/plannotator-tui) (MIT, plannotator). They are
downloaded from their own repositories at install time, with their licenses.
The layout starts from Herdr desktop's shipped `main` layout (Apache-2.0).
