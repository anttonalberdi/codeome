# Codeome

[![Release](https://img.shields.io/github/v/release/anttonalberdi/codeome)](https://github.com/anttonalberdi/codeome/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/anttonalberdi/codeome/total)](https://github.com/anttonalberdi/codeome/releases)
[![CI](https://github.com/anttonalberdi/codeome/actions/workflows/ci.yml/badge.svg)](https://github.com/anttonalberdi/codeome/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-alberdilab.dk-blue)](https://www.alberdilab.dk/codeome/)
[![License: MIT](https://img.shields.io/github/license/anttonalberdi/codeome)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, one agent chat that coordinates Claude Code and Codex, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

## Download

**[Download the latest release](https://github.com/anttonalberdi/codeome/releases/latest)** and pick your file under *Assets*:

- **Mac, Apple silicon** (M1 and later): `Codeome-<version>-arm64.dmg`
- **Mac, Intel**: `Codeome-<version>.dmg` (x64)
- **Windows** (x64, early support): `Codeome Setup <version>.exe`
- **Linux** (x64, early support): `Codeome-<version>.AppImage` or the `.deb`

Open the `.dmg` and drag Codeome to Applications. The app is not signed with an Apple Developer certificate, so the first time: right-click Codeome in Applications → **Open** → **Open**. More in [Getting started](https://www.alberdilab.dk/codeome/guide/getting-started).

**Documentation: https://www.alberdilab.dk/codeome/**

## What it does

- **Projects** — one card per open project, each with its own editor tabs, terminals, agent sessions and HPC folder.
- **Editor** — Monaco with RStudio-style run commands and runnable R Markdown and Quarto chunks, on your Mac and directly on the HPC.
- **Agent chat and team** — one chat per project that plans work, asks for your approval, and hands it to Claude subagents and Codex jobs.
- **HPC, files and Slurm** — a shared SSH connection, FileZilla-style transfer, and live job queues and logs.
- **Phone companion** — answer agent decisions, send a message or stop a chat from your phone over Tailscale, with low-risk approvals only.
- **Plots, reports, Git/GitHub, Zenodo, packages** — all in the same window.

See the [guide](https://www.alberdilab.dk/codeome/guide/getting-started) for each area, the [settings](https://www.alberdilab.dk/codeome/settings) for first-time set-up, and the [keyboard shortcuts](https://www.alberdilab.dk/codeome/reference/keyboard).

## Windows (early support)

A Windows x64 installer is attached to each release (or build it with `npm run dist:win`). It has so far been built and tested only through CI and stub tests; it has not been run on a real Windows machine yet. The installer is unsigned, so SmartScreen will warn.

- **Needs**: [Git for Windows](https://git-scm.com/download/win) (it provides bash) and Python 3 on your PATH (the Microsoft Store `python3` stub does not count) for the `codeome-agent` helper. Install the Claude Code and Codex CLIs as on macOS.
- **Not yet supported**: the HPC connection (terminals, SFTP, transfers, Slurm, agents on the cluster), because Windows OpenSSH has no ControlMaster. It is planned for a later release; the app shows a "not yet supported" note instead of the HPC controls.
- **Known quirks**: shortcuts use Ctrl instead of Cmd. In the terminal, Ctrl+C copies only when text is selected (otherwise it interrupts), Ctrl+Shift+C/V copy and paste, Ctrl+Shift+K clears and Ctrl+F finds. Some File-menu accelerators (Ctrl+W, N, T, J, O, S and 1-9) take priority over the same keys in the terminal.

## Advanced: run from source

Needs Node.js 20+ and the Xcode command-line tools.

```bash
git clone https://github.com/anttonalberdi/codeome.git
cd codeome
npm install
npm start            # run in development
npm run dist         # build dist/Codeome-<version>-arm64.dmg
```

Every push to `main` also builds the app: see the *Codeome-mac* artifact of the latest *Build macOS app* run in the [Actions tab](https://github.com/anttonalberdi/codeome/actions).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [project layout](https://www.alberdilab.dk/codeome/reference/project-layout). The docs source is in [`docs/`](docs); run `cd docs && npm install && npm run docs:dev` to preview it.

## License

[MIT](LICENSE)
