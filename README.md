# Codeome

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, one agent chat that coordinates Claude Code and Codex, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

**Documentation: https://anttonalberdi.github.io/codeome/**

## What it does

- **Projects** — one card per open project, each with its own editor tabs, terminals, agent sessions and HPC folder.
- **Editor** — Monaco with RStudio-style run commands and runnable R Markdown and Quarto chunks, on your Mac and directly on the HPC.
- **Agent chat and team** — one chat per project that plans work, asks for your approval, and hands it to Claude subagents and Codex jobs.
- **HPC, files and Slurm** — a shared SSH connection, FileZilla-style transfer, and live job queues and logs.
- **Plots, reports, Git/GitHub, Zenodo, packages** — all in the same window.

See the [guide](https://anttonalberdi.github.io/codeome/guide/getting-started) for each area, the [settings](https://anttonalberdi.github.io/codeome/settings) for first-time set-up, and the [keyboard shortcuts](https://anttonalberdi.github.io/codeome/reference/keyboard).

## Install

Download the built app from the latest *Build macOS app* run in the [Actions tab](https://github.com/anttonalberdi/codeome/actions) (the *Codeome-mac* artifact), or build it yourself (Node.js 20+ and the Xcode command-line tools):

```bash
git clone https://github.com/anttonalberdi/codeome.git
cd codeome
npm install
npm start            # run in development
npm run dist         # build dist/Codeome-<version>-arm64.dmg
```

The app is not signed with an Apple Developer certificate, so the first time: right-click Codeome in Applications → **Open** → **Open**. More in [Getting started](https://anttonalberdi.github.io/codeome/guide/getting-started).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [project layout](https://anttonalberdi.github.io/codeome/reference/project-layout). The docs source is in [`docs/`](docs); run `cd docs && npm install && npm run docs:dev` to preview it.

## License

[MIT](LICENSE)
