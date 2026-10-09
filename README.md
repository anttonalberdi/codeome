# Codeome

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, Claude Code and Codex sessions, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

## What it does

**Editor** — Monaco (the VS Code editor core) with syntax highlighting for R, Python, shell, Quarto, R Markdown, Snakemake, YAML and more. Opens files on your Mac *and* directly on the HPC.
- `⌘↩` sends the current line or selection to the active terminal (R, Python or shell REPL), RStudio-style; `⇧⌘↩` runs the whole file.
- Right-click → *Ask agent about selection* sends the code reference to your Claude Code / Codex session.

**Terminals & agents** — tabs in the bottom panel (`⌘J`): local shells, HPC shells, and Claude Code / Codex sessions either on the Mac or on the cluster. HPC agent sessions run inside `tmux`, so they keep working if the VPN drops and reattach when you reopen them.

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
4. **Zenodo / PyPI tokens** if you publish from here.

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `quarto`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.

## Keyboard

| Keys | Action |
|---|---|
| `⌘O` | Open project folder |
| `⌘S` / `⌘W` | Save / close tab |
| `⌘↩` / `⇧⌘↩` | Run line or selection / whole file in terminal |
| `⇧⌘V` | Preview or render current file |
| `⌘T` / `⇧⌘T` | New local / HPC terminal |
| `⌘J` | Show or hide terminal panel |
| `⌘1`–`⌘5` | Files, Slurm, Git, Publish, Python packages |

## Project layout

```
main/          Electron main process
  main.js        window, menus, IPC handlers
  ssh.js         shared SSH connection (ControlMaster), remote files
  slurm.js       squeue / sacct / scancel / sbatch
  zenodo.js      Zenodo REST client
  config.js      settings + Keychain-encrypted tokens
  preload.js     the bridge the interface is allowed to use
renderer/      Interface (plain JS, no build step)
  index.html, styles.css
  js/            one file per area: editor, terminals, files, slurm, git, publish, pip, settings
test/          parser tests (npm test) and a screenshot helper
```

Working on Codeome itself: open this folder in Codeome, start a Claude Code session, and ask for the change. `npm start` relaunches it.
