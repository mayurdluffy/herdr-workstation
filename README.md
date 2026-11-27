# Herdr Workstation

One command turns [Herdr desktop](https://herdr.dev) into a full agent workstation: review your
agent's changes and send comments back to it, a git graph, live Markdown preview, and Claude Code / Codex usage limits in the status bar.

![Workstation](layouts/workstation.svg)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mayurdluffy/herdr-workstation/main/install.sh | bash
```

Needs Herdr desktop (started once), `git`, `curl` and `python3`. macOS or Linux.
Run the same command again to update. Options (after `bash -s --`):

| Option | Skips |
|---|---|
| `--no-switch` | switching to the Workstation layout at the end |

Uninstall: `bash ~/.local/share/herdr-workstation/uninstall.sh`.

## What you get

The tab bar has four panels: **Files**, **Changes**, **Graph** and **Comments**
(our Changes, with Accept/Reject, replaces Herdr's own). Each remembers, per space, whether it was open.

### Comment on anything, send it as one message

Select something, press **Comment**, write a note. It waits in the **Comments** panel (the tab bar
shows how many) until you **Send all**: the agent gets one message with each comment's file and lines
(or commit, terminal), the quoted text and your note, like Claude Code desktop or T3. Send one
comment straight away with **Send now**, or **Copy** them instead.

| Where | How |
|---|---|
| **Files** | open a file, select code (or put the cursor on a line), **Comment**. Markdown opens as a rendered **Preview** (switch to **Code**); select in it and Comment |
| **Changes** | click a diff line, shift-click another, **Comment** |
| **Graph** | click a commit; **Comment** on it, or select diff lines first |
| **Terminals** | select text: the pane header shows **Comment** (or `cmd-shift-m`) |
| **Markdown preview pane** | select text, **Comment** |

### Panels

- **Changes**: the agent's uncommitted changes. **Accept** stages a file or a hunk, **Reject** restores it (a new file is deleted after a second click). Accepted files wait under Accepted until you commit. **Full review** opens [plannotator](https://github.com/plannotator/plannotator-tui) (split view, suggestions, Approve).
- **Graph**: every branch's commits with refs; click one for its diff, **Review** it in plannotator.
- **Files**: Herdr's Files, plus Comment, Markdown Preview, **Annotate** (plannotator) and **Open beside** (a live preview pane).
- **Usage**: the status bar's right half is [usage-limits](https://github.com/VladTemp27/herdr-mods): Claude Code and Codex 5-hour and weekly limits, reset times and plan. It asks the `claude` and `codex` CLIs themselves and never reads a token.

### Keys

| Key (macOS / Linux) | Does |
|---|---|
| `cmd-shift-k` / `ctrl-alt-k` | Workstation menu: review, last reply, docs, approve a plan, graph, Markdown, comments, usage |
| `cmd-shift-m` / `ctrl-alt-m` | Comment on the terminal selection |
| `cmd-shift-g` / `ctrl-alt-g` | Git graph as a pane beside the focused one |
| Ctrl/Cmd-click a `.md` path | Live Markdown preview beside that pane |

## How it installs

Everything goes into Herdr's home (`~/.config/herdr-app`, or `$HERDR_APP_HOME`):

- `layouts/workstation.json`: Herdr's main layout plus the usage bar and the Markdown link handler.
- `mods/ws-*`: this repo's mods. `ws-tabs`, `ws-files` and `ws-pane` are copies of Herdr's `tabs`, `files` and `pane` with our additions marked `WS:`; they don't pick up Herdr's later changes to those mods by themselves.
- `mods/usage-limits`: third-party, pinned in [`vendor.lock`](vendor.lock).
- `keys.json`: our keys are added only where the key is free; yours are never replaced.

A mod folder is only replaced when it carries our `.herdr-workstation` marker, so a mod of yours
with the same name is left alone. Each mod passes `herdr-app check` before the install reports success.
Tools: `plannotator-tui` (Homebrew, else cargo).

## Develop

Edit a mod in `mods/` (shared code lives in `lib/` and is copied into the mods that use it by `scripts/sync-lib.sh`), run `./install.sh` (it installs from the checkout it's in), and
Herdr reloads it live. `herdr-app check mods/<name>` must pass. To bump a third-party pin, read its
diff first, then change the ref in `vendor.lock`.

## Credits

[usage-limits](https://github.com/VladTemp27/herdr-mods) (Apache-2.0, VladTemp27),
[plannotator-tui](https://github.com/plannotator/plannotator-tui) (MIT, plannotator). They are
downloaded from their own repositories at install time, with their licenses.
The layout starts from Herdr desktop's shipped `main` layout (Apache-2.0).
