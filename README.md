# Codeome

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, Claude Code and Codex sessions, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

## What it does

**Projects** — every open project is a card in the leftmost column. Each one keeps its own editor tabs, terminal and agent sessions, and HPC folder; sessions keep running while you work in another project. Cards show running agent jobs, live sessions and unsaved files. `⌘O` opens another project, `⌃⇥` / `⌃⇧⇥` switch, `⇧⌘W` closes one; drag cards to reorder, or collapse the column to monograms.

**Usage limits** — the title bar shows the 5-hour and weekly usage of Claude and Codex for the active account; click either for every account, reset times, and to switch or add accounts.

**Editor** — Monaco (the VS Code editor core) with syntax highlighting for R, Python, shell, Quarto, R Markdown, Snakemake, YAML and more. Opens files on your Mac *and* directly on the HPC.
- `⌘↩` sends the current line or selection to the active terminal (R, Python or shell REPL), RStudio-style; `⇧⌘↩` runs the whole file.
- Right-click → *Ask agent about selection* sends the code reference to your Claude Code / Codex session.

**Terminals & agents** — tabs in the bottom panel (`⌘J`): local shells, HPC shells, and Claude Code / Codex sessions either on the Mac or on the cluster. HPC agent sessions run inside `tmux`, so they keep working if the VPN drops and reattach when you reopen them.

**Agents** (`⌘6`) — a team of specialists coordinated by Claude Code. Install the *agent kit* into a project and Claude Code becomes an orchestrator that hands jobs to Claude subagents and to Codex:
- 15 roles in four groups, chosen at install: core (planner, explorer, implementer, debugger, tester, reviewer), research computing (analyst, pipeline-engineer, hpc-operator, report-writer), web stack (backend, frontend, security-reviewer), release & docs (docs-writer, release-manager).
- Jobs are routed by type. Well-specified implementation and debugging go to Codex; planning, exploration, docs and anything that needs the network or the HPC go to Claude. Reviews run on whichever engine did *not* write the change.
- `/orchestrate <task>` runs the pipeline: size → plan → **you approve** → specialists implement, the orchestrator verifies each result → cross-review → **you approve** → commit. `/delegate` sends a single job; `/cross-review` reviews the current changes.
- Type a task in the Agents view and press *Start* to open the orchestrator in the panel. Every specialist job — Codex runs and Claude subagents alike — appears in the list with its brief, live log and result.
- **Accounts and limits.** Codex jobs run on the active Codex account while it has headroom, and otherwise on the account with the most. New orchestrators do the same with Claude accounts. Once an account passes the stop threshold (90% of either window by default), Codeome holds new jobs back. A Codex job exits with code 75 and a Claude subagent call is refused, and the orchestrator re-routes the work or pauses and tells you. *Resume a plan* starts a fresh orchestrator, on another account if you like, that picks up the plan where the last one stopped.

**HPC connection** — uses your system `ssh`, so `~/.ssh/config`, keys, ProxyJump and the VPN behave exactly as in iTerm2. You log in once (password or one-time code prompts appear in a terminal tab); every other operation reuses that connection for 12 hours. The title bar shows VPN reachability, connection state and your running / waiting / failed jobs.

**Files & transfer** (replaces FileZilla) — the Mac project folder and the HPC side by side. Drag between them, or drag from Finder onto the HPC pane, to copy with `rsync` (resumable, incremental, with progress). Rename, delete, folder size, storage quota, "terminal here", "Claude here".

**Slurm** — live `squeue`, recent `sacct` history with exit codes and memory, a log viewer that follows `stdout`/`stderr`, cancel, submit (`sbatch`) from the editor, and a job-script template.

**Reports** — `⇧⌘V` renders `.qmd` (Quarto), `.Rmd` (rmarkdown) and `.ipynb`, and previews HTML, images and PDFs. Re-renders on save. Remote plots and reports are fetched and shown in place.

**Git & GitHub** — status, diff, stage, commit, pull, push, history; with the GitHub CLI: publish a repo, open pull requests, create releases.

**Zenodo** — create drafts, edit metadata, upload files, publish and create new versions (sandbox supported). Tip: link a GitHub repo in Zenodo's GitHub settings and every GitHub release from Codeome gets a DOI.

**Python packages** — list, install, upgrade and remove packages on the Mac or the HPC; build your package and upload it to TestPyPI or PyPI.

Tokens for Zenodo and PyPI are stored encrypted with the macOS Keychain and never shown in the interface.

## Install

### Option A — download the built app
Every push to `main` builds the app on GitHub (Actions tab → latest *Build macOS app* run → *Codeome-mac* artifact). Pushing a tag like `v0.2.0` attaches the `.dmg` files to a release.

The app is not signed with an Apple Developer certificate, so the first time: right-click Codeome in Applications → **Open** → **Open**. (Or run `xattr -dr com.apple.quarantine /Applications/Codeome.app`.)

### Option B — build it yourself
Requires Node.js 20+ and the Xcode command-line tools (`xcode-select --install`).

```bash
git clone https://github.com/<you>/codeome.git
cd codeome
npm install          # also rebuilds the terminal backend for Electron
npm start            # run in development
npm run dist         # build dist/Codeome-<version>-arm64.dmg
```

If terminals say they need a rebuild, run `npm run rebuild`.

## Set up

Open **Settings** (`⌘,`):

1. **HPC login** — ideally a Host alias from `~/.ssh/config`, for example:
   ```
   Host myhpc
     HostName login.cluster.example.org
     User abc123
     IdentityFile ~/.ssh/id_ed25519
   ```
2. **VPN check** (optional) — a host only reachable on the VPN, so the title bar can tell you whether the VPN is up.
3. **Agents** — one per line, `Name = command`. Defaults: `Claude Code = claude`, `Codex = codex`. Add variants like `Claude (Opus) = claude --model opus`.
4. **Accounts & usage limits** — one account per line, `Name = folder`. A Claude account is a `CLAUDE_CONFIG_DIR` and a Codex account a `CODEX_HOME`; `~/.claude` and `~/.codex` are the defaults. *Add account…* in the usage popover creates one and opens a terminal to sign in. You can also set the stop threshold here.
5. **Zenodo / PyPI tokens** if you publish from here.

### Where the usage numbers come from
- **Codex**: Codeome asks `codex app-server` for each account every few minutes and when a Codex job ends.
- **Claude**: Claude Code reports its rate limits to its status line. Claude Code sessions started from Codeome get a status line, `~/.codeome/bin/codeome-statusline`, that records them and then shows your own status line, so your settings files are untouched. The Claude bars therefore update while a Claude Code session started from Codeome is in use, and they show readings older than 30 minutes as stale. Windows that have reset since count as empty.
- Codeome writes the combined picture to `~/.codeome/usage.json`. `codeome-agent` reads it to choose accounts and hold jobs back. Without it (Codeome closed, or on the HPC) jobs run on the default account with no limit checks. Codeome never reads or stores the CLIs' credentials.

### Agent kit
Agents view → **Install…** writes into the project:

| Path | What |
|---|---|
| `.claude/agents/<role>.md` | the roles; Claude uses them as subagents, Codex reads the same files |
| `.claude/skills/{orchestrate,delegate,cross-review}/` | the slash commands |
| `.claude/skills/orchestrate/routing.md` | role → default engine; edit it to change routing for this project |
| `.claude/settings.json` | hooks that record Claude subagent jobs, and permission to run the job runner (merged into your existing settings) |
| `.codeome/bin/codeome-agent` | the job runner (Python 3, standard library only, so it also works on the HPC) |

Commit `.claude/` and `.codeome/bin/` + `.codeome/kit.json` so collaborators get the same team; job records, plans and worktrees are git-ignored. Updating the kit never overwrites a role or skill you have edited. Codex jobs run in Codex's sandbox (read-only for reviewers and planners, workspace-write otherwise, no network). From a terminal: `.codeome/bin/codeome-agent list`, `show <id>`, `cancel <id>`, `usage`. Pass `--account <name>` to run a Codex job on a specific account, or `--ignore-limits` to start one past the threshold.

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `quarto`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.

## Keyboard

| Keys | Action |
|---|---|
| `⌘O` | Open a project (adds a card) |
| `⌃⇥` / `⌃⇧⇥` / `⇧⌘W` | Next / previous / close project |
| `⌘S` / `⌘W` | Save / close tab |
| `⌘↩` / `⇧⌘↩` | Run line or selection / whole file in terminal |
| `⇧⌘V` | Preview or render current file |
| `⌘T` / `⇧⌘T` | New local / HPC terminal |
| `⌘J` | Show or hide terminal panel |
| `⌘1`–`⌘6` | Files, Slurm, Git, Publish, Python packages, Agents |

## Project layout

```
main/          Electron main process
  main.js        window, menus, IPC handlers
  ssh.js         shared SSH connection (ControlMaster), remote files
  slurm.js       squeue / sacct / scancel / sbatch
  zenodo.js      Zenodo REST client
  config.js      settings + Keychain-encrypted tokens
  kit.js         installs/updates the agent kit in a project
  jobs.js        reads agent job records from .codeome/jobs/
  usage.js       Claude/Codex accounts and usage limits; writes ~/.codeome/usage.json
  codeome-statusline   Claude Code status line that records rate limits
  preload.js     the bridge the interface is allowed to use
renderer/      Interface (plain JS, no build step)
  index.html, styles.css
  js/            one file per area: projects, usage, editor, terminals, files, slurm, git, publish, pip, agents, settings
kit/           the agent kit: roles/ (one file per role), skills/, bin/codeome-agent, manifest.json
test/          parser tests (npm test) and a screenshot helper
```

Working on Codeome itself: open this folder in Codeome, start a Claude Code session, and ask for the change. `npm start` relaunches it.
