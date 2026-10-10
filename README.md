# Codeome

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, one agent chat that coordinates Claude Code and Codex, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

## What it does

**Projects** — every open project is a card in the leftmost column. Each one keeps its own editor tabs, terminal and agent sessions, and HPC folder; sessions keep running while you work in another project. Cards show running agent jobs, live sessions and unsaved files. `⌘O` opens another project, `⌃⇥` / `⌃⇧⇥` switch, `⇧⌘W` closes one; drag cards to reorder, or collapse the column to monograms.

**Usage limits** — the title bar shows the 5-hour and weekly usage of Claude and Codex for the active account; click either for every account, reset times, and to switch or add accounts.

**Editor** — Monaco (the VS Code editor core) with syntax highlighting for R, Python, shell, Quarto, R Markdown, Snakemake, YAML and more. Opens files on your Mac *and* directly on the HPC.
- `⌘↩` runs the current line or selection, RStudio-style. R code goes to the project's R console (started on demand), and with no selection it sends the whole statement under the cursor; other languages go to the active terminal. `⇧⌘↩` sources an R script into the console, or runs other files in a terminal.
- **R Markdown and Quarto** documents are runnable: chunks are shaded and highlighted in their own language, with *Run chunk* / *Run chunks above* over each and *Knit* / *Run all chunks* at the top. `⇧⌘↩` runs the chunk under the cursor, `⌥⌘R` all chunks, `⌥⌘P` the chunks above, `⌥⌘N` the next one, `⌃⌥I` inserts a chunk and `⇧⌘K` knits.
- Right-click → *Ask the agent about this…* puts a reference to the file and selected lines in the Agent chat.

**Terminals** — tabs in the bottom panel (`⌘J`): local shells, HPC shells, R consoles (on the Mac or the HPC; the command is set in Settings → R), and Claude Code / Codex sessions on the cluster. Right-click any terminal → *Send R code here* to make it the one R code goes to, e.g. R inside an interactive job. HPC agent sessions run inside `tmux`, so they keep working if the VPN drops and reattach when you reopen them.

**Plots** (`⌘7`) — plots from R consoles started in Codeome (on the Mac or the HPC) open in the Plots view instead of a separate window, RStudio-style. Each plot is kept with its recording, so it can be redrawn at any size afterwards.
- **Canvas**: *Fit to panel* draws at the panel's size and redraws when you resize it. Presets cover journal widths (89, 120 and 183 mm), a 16:9 slide, a square and A4, or you can type a width and height in in, cm, mm or px. Set the dpi and a white or transparent background. The panel shows the plot at the chosen size, so text and point sizes look as they will in the file. *Actual size* (the magnifier) shows it at print size.
- **Export** to PNG, PDF, SVG, TIFF, JPEG or EPS at that size and dpi (raster files carry the dpi), or **Copy** it as a PNG. The ⋯ menu copies the matching `ggsave()` call or device code (`pdf(...)` … `dev.off()`) for your script.
- History: ‹ › or the arrow keys step through plots, the thumbnails jump to one, ⌫ removes one. *Open in a tab* gives a large view with the controls beside it.
- Redrawing runs in a separate R process with the session's R and libraries, so the console is never interrupted. For R started another way (say, inside an interactive job), right-click its terminal tab → *Show R plots in Codeome*. Settings → R turns this off.

**Agent chat** (`⌘1`) — agent chats per project, instead of separate Claude Code and Codex windows. Behind each chat is a headless Claude Code session acting as the orchestrator. It answers questions and makes small changes itself. For anything bigger it plans the work, checks with you, and hands it to specialists, whether Claude subagents or Codex jobs.
- Replies are rendered as Markdown. Tool calls appear as one-line entries you can expand. Each specialist job appears as a card with live status; open a card for the job's brief, log and result.
- Permission prompts, questions and the approval gates appear as buttons in the chat. The selector under the message box sets what the agent may do without asking: *Ask before changes*, *Accept edits*, *Auto* or *Plan only*.
- **Several chats at once.** Each chat is a tab above the conversation and runs its own session, so one can plan while another fixes a bug. `⇧⌘N` opens a new chat; `⇧⌘]` / `⇧⌘[` switch. Each tab shows its state: a spinner while the agent works, amber when it is waiting for you, green when a reply is ready that you haven't seen, red after an error. A badge counts the specialists that chat has running. The line under the tabs sums it up (for example *3 chats · 1 working · 1 needs you · 2 subagents · 1 Codex job*). Click *needs you* or *reply ready* to jump to that chat. Project cards and the rail icon show the same states for every project.
- Conversations are saved (in `~/.codeome/chats/`) and keep running while you work in another tab or project. Open tabs come back when you reopen the project. Closing a tab stops its session, and the ⋯ menu reopens the conversation later. The ⋯ menu can also move the current chat into a Claude Code terminal session.
- The chat runs the first Claude command in Settings → Agents (for example `claude --model opus`), with the model chosen there.

**The team** — install the *agent kit* into a project (from the banner in the chat) and the agent gains a team:
- 15 roles in four groups, chosen at install: core (planner, explorer, implementer, debugger, tester, reviewer), research computing (analyst, pipeline-engineer, hpc-operator, report-writer), web stack (backend, frontend, security-reviewer), release & docs (docs-writer, release-manager).
- Jobs are routed by type. Well-specified implementation and debugging go to Codex; planning, exploration, docs and anything that needs the network or the HPC go to Claude. Reviews run on whichever engine did *not* write the change.
- The agent picks the level of each message itself. Larger tasks run the pipeline: size → plan → **you approve** → specialists implement, the orchestrator verifies each result → cross-review → **you approve** → commit. You can still type `/orchestrate <task>`, `/delegate` (one job) or `/cross-review` to choose yourself.
- Codex jobs run in the background; the chat wakes up when one finishes. The chat's *Jobs* tab lists every job, Codex runs and Claude subagents alike.
- **Accounts and limits.** Codex jobs run on the active Codex account while it has headroom, and otherwise on the account with the most. New chats do the same with Claude accounts (pick one under the message box before the first message; a conversation stays on its account). Once an account passes the stop threshold (90% of either window by default), Codeome holds new jobs back. A Codex job exits with code 75 and a Claude subagent call is refused, and the orchestrator re-routes the work or pauses and tells you. *Resume plan on …* (in the chat's usage notice) starts a new chat on another account that picks up the plan where the last one stopped.

**HPC connection** — uses your system `ssh`, so `~/.ssh/config`, keys, ProxyJump and the VPN behave exactly as in iTerm2 (or, with Codeome's own VPN tunnel, only Codeome's HPC connections use the VPN; see Settings below). You log in once, in the background: with an ssh key nothing is asked, and a password, key passphrase, one-time code or new host fingerprint is asked for in a dialog, so the terminal panel stays free for your own work. Every other operation reuses that connection for 12 hours. If the background login fails, its log offers to try again in a terminal tab. The title bar shows VPN reachability, connection state and your running / waiting / failed jobs.

**Files & transfer** (replaces FileZilla) — three stacked sections: the Mac project folder, the HPC, and long-term storage over SFTP (such as ERDA; set it up in Settings → Storage). Click a section's header to collapse it, drag the line between sections to resize them (double-click to even them out), and right-click a header to rename it or show only that section. Drag between sections, or from Finder, to copy: Mac ↔ HPC with `rsync` (resumable, incremental, with progress), Mac ↔ storage with `sftp`, and HPC ↔ storage directly from the HPC in a terminal there, so the data doesn't pass through the Mac. Rename, delete, folder size, storage quota, "terminal here", "R console here", "Claude here".

**Slurm** — live `squeue`, recent `sacct` history with exit codes and memory, a log viewer that follows `stdout`/`stderr`, cancel, submit (`sbatch`) from the editor, and a job-script template.

**Reports** — `⇧⌘V` renders `.qmd` (Quarto), `.Rmd` (rmarkdown) and `.ipynb`, and previews HTML, images and PDFs. Re-renders on save. Remote plots and reports are fetched and shown in place.

**Git & GitHub** — status, diff, stage, commit, pull, push, history; with the GitHub CLI: publish a repo, open pull requests, create releases.

**Zenodo** — create drafts, edit metadata, upload files, publish and create new versions (sandbox supported). Tip: link a GitHub repo in Zenodo's GitHub settings and every GitHub release from Codeome gets a DOI.

**Packages** (`⌘6`) — stacked sections, like Files: *Python* (pip) and, in R projects, *R libraries*. Each works on the Mac or the HPC.
- Python: list, install, upgrade and remove packages; build your package and upload it to TestPyPI or PyPI (Publish).
- R: every library in `.libPaths()` (project renv, user, site, system) as its own group, with each package's version and where it came from (CRAN, Bioconductor, GitHub). Install from CRAN, Bioconductor or GitHub (`user/repo`), update, remove, or load one into the R console. *Check for updates* (⋯) marks outdated packages, and you can update them all at once. R runs in the project folder, so renv projects install into their own library.
- A project counts as an R project if it has an `.Rproj`, `DESCRIPTION`, `renv.lock`, `.Rprofile` or R / R Markdown files at the top. Right-click a section header to show or hide R libraries anywhere.

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

Open **Settings** (`⌘,`). It is a full page with a section list on the left. Changes save as you make them, and `Esc` or *Done* returns to your work.

1. **HPC login** — ideally a Host alias from `~/.ssh/config`, for example:
   ```
   Host myhpc
     HostName login.cluster.example.org
     User abc123
     IdentityFile ~/.ssh/id_ed25519
   ```
2. **Network** — how Codeome reaches the cluster's network:
   - *Campus network, or a VPN for the whole Mac* (e.g. Cisco Secure Client). Optionally give a **VPN check** host, only reachable on the VPN, so the title bar shows whether the VPN is up.
   - *Codeome's own VPN tunnel*: only Codeome's connections to the HPC go through the VPN; the rest of the Mac stays on its own network. It runs [OpenConnect](https://www.infradead.org/openconnect/), which speaks Cisco's AnyConnect protocol, with `ocproxy`, so it needs no admin rights and changes none of the Mac's routes or DNS. Set the **VPN server** (e.g. `vpn.example.org`; the servers in Cisco Secure Client's profile are suggested). Connecting to the HPC starts the tunnel in the background; Codeome asks in dialogs for anything not saved (username, password, second factor) and waits while you approve the sign-in on your MFA device. While it runs, ssh to the HPC host goes through it. When it is not running, ssh goes direct, so the same setting also works on campus. The **VPN** dot in the title bar shows the tunnel; click the cluster strip to stop it. Use it instead of Cisco Secure Client, not alongside it.
3. **Setup checklist** — below the login, Codeome checks each step and offers the button that does it: install OpenConnect and ocproxy (with Homebrew, which it installs first if needed, always after asking), start the tunnel, create an ssh key, copy it to the HPC (you sign in with your password once), test a login without a password, and connect. Settings → *This Mac* also offers to install missing command-line tools.
4. **Agents**
   - *Agent chat*: the orchestrator's Claude model (or the one in its command).
   - *Team in <project>*: every agent in the project's `.claude/agents/`, kit roles and your own. Each has an **AI** dropdown (Claude, Codex, or the other engine for reviewers) and a **Model** dropdown (Claude models for Claude, the models your Codex account offers for Codex, or *Other…* for any model ID). *Edit .md* opens the agent's instructions in the editor, and *+ New agent* creates one. The AI goes into `routing.md`, the Claude model into the agent file, and the Codex model into `.codeome/agents.json`. Kit updates keep these choices.
   - *Command-line agents*: name and command for each agent offered as a terminal session. Defaults: `Claude Code = claude`, `Codex = codex`. Add variants like `Claude (Opus) = claude --model opus`.
5. **Accounts & usage limits** — an account is an email address, and one card shows each with its sign-in and its usage. *Add a … account…* asks for the address and signs it in once through a terminal and your browser; the account is *confirmed* when the sign-in is for that address. Each account keeps its sign-in in its own folder (a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` that Codeome chooses; `~/.claude` and `~/.codex` are the first account's), so every confirmed account stays signed in and work moves between them without asking again. *Sign in to the other N…* takes every account that is not signed in, one after the other. An account signed in with another address is not used until you sign in again or switch it to that address. Sign-ins already on the Mac (`~/.claude-lab`) are offered as cards to add. Accounts from before take the address they are signed in with. You can also set the stop threshold here.
6. **Zenodo / PyPI tokens** if you publish from here.

### Where the usage numbers come from
- **Codex**: Codeome asks `codex app-server` for each account every few minutes and when a Codex job ends.
- **Claude**: Codeome asks a headless `claude -p` for each signed-in account's usage every few minutes; no message is sent, so the check uses none of the limit. Between two checks, Claude Code sessions started from Codeome get a status line, `~/.codeome/bin/codeome-statusline`, that records the rate limits Claude Code reports and then shows your own status line, so your settings files are untouched, and the Agent chat records the rate limits that come with each reply in the same place. A reading older than 30 minutes (an account that is signed out, or a check that fails) is shown as stale. Windows that have reset since count as empty.
- Codeome writes the combined picture to `~/.codeome/usage.json`. `codeome-agent` reads it to choose accounts and hold jobs back. Without it (Codeome closed, or on the HPC) jobs run on the default account with no limit checks. Codeome never reads or stores the CLIs' credentials.

### Agent kit
Agent chat → **Install…** (in the banner, or the ⋯ menu) writes into the project:

| Path | What |
|---|---|
| `.claude/agents/<role>.md` | the roles; Claude uses them as subagents, Codex reads the same files |
| `.claude/skills/{orchestrate,delegate,cross-review}/` | the slash commands |
| `.claude/skills/orchestrate/routing.md` | role → default engine; edit it to change routing for this project |
| `.claude/settings.json` | hooks that record Claude subagent jobs, and permission to run the job runner (merged into your existing settings) |
| `.codeome/bin/codeome-agent` | the job runner (Python 3, standard library only, so it also works on the HPC) |

Commit `.claude/` and `.codeome/bin/` + `.codeome/kit.json` so collaborators get the same team. The chat approves its own job-runner calls (`codeome-agent` with a brief and no other shell syntax), except `--ignore-limits`; job records, plans and worktrees are git-ignored. Updating the kit never overwrites a role or skill you have edited. Codex jobs run in Codex's sandbox (read-only for reviewers and planners, workspace-write otherwise, no network). From a terminal: `.codeome/bin/codeome-agent list`, `show <id>`, `cancel <id>`, `usage`. Pass `--account <email>` to run a Codex job on a specific account, or `--ignore-limits` to start one past the threshold.

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `sftp`, `quarto`, `R`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.

## Keyboard

| Keys | Action |
|---|---|
| `⌘O` | Open a project (adds a card) |
| `⌃⇥` / `⌃⇧⇥` / `⇧⌘W` | Next / previous / close project |
| `⌘S` / `⌘W` | Save / close tab |
| `⌘↩` / `⇧⌘↩` | Run line, statement or selection / whole file (current chunk in Rmd and Quarto) |
| `⌥⌘R` / `⌥⌘P` / `⌥⌘N` | Rmd and Quarto: run all chunks / chunks above / next chunk |
| `⌃⌥I` / `⇧⌘K` | Rmd and Quarto: insert a chunk / knit |
| `⇧⌘V` | Preview or render current file |
| `⌘T` / `⇧⌘T` | New local / HPC terminal |
| `⌘J` | Show or hide terminal panel |
| `⌘1`–`⌘7` | Agent chat, Files, Slurm, Git, Publish, Packages, Plots |

## Project layout

```
main/          Electron main process
  main.js        window, menus, IPC handlers
  ssh.js         shared SSH connection (ControlMaster), remote files
  sftp.js        long-term storage over SFTP (e.g. ERDA): listing, files, transfers
  slurm.js       squeue / sacct / scancel / sbatch
  zenodo.js      Zenodo REST client
  config.js      settings + Keychain-encrypted tokens
  chat.js        the Agent chat's headless Claude Code sessions (stream-json), saved chats
  kit.js         installs/updates the agent kit in a project
  jobs.js        reads agent job records from .codeome/jobs/
  usage.js       Claude/Codex accounts and usage limits; writes ~/.codeome/usage.json
  rtools.js      R plots (redraw, export) and R libraries; puts main/r/*.R in ~/.cache/codeome on each host
  r/             plots.R (sourced into R consoles), render.R (redraws a recorded plot), packages.R
  codeome-statusline   Claude Code status line that records rate limits
  preload.js     the bridge the interface is allowed to use
renderer/      Interface (plain JS, no build step)
  index.html, styles.css
  js/            one file per area: projects, usage, editor, rmd, terminals, files, slurm, git, publish, packages, plots, chat, agents, settings
                 (stack.js: the stacked sections of Files and Packages)
kit/           the agent kit: roles/ (one file per role), skills/, bin/codeome-agent, manifest.json;
               chat.md, the orchestrator instructions for the Agent chat
test/          parser tests (npm test) and a screenshot helper
```

Working on Codeome itself: open this folder in Codeome and ask for the change in the Agent chat. `npm start` relaunches it.
