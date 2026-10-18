# Getting started

One Mac app for research computing that spans your laptop and the HPC: a code editor, terminals, one agent chat that coordinates Claude Code and Codex, Slurm jobs, file transfer, report previews, Git/GitHub, Zenodo and PyPI — in a single window, without the parts of VS Code you never use.

## Install

### Download the app (easiest)

1. Open the [latest release](https://github.com/anttonalberdi/codeome/releases/latest).
2. Under *Assets*, download the `.dmg` for your Mac: `arm64` for Apple silicon (M1 and later), `x64` for Intel.
3. Open the `.dmg` and drag Codeome to Applications.

::: tip The app is not signed
The app is not signed with an Apple Developer certificate, so the first time: right-click Codeome in Applications → **Open** → **Open**. (Or run `xattr -dr com.apple.quarantine /Applications/Codeome.app`.)
:::

Releases are made by pushing a tag like `v1.1.0` (it must match the version in `package.json`); the build attaches the `.dmg` files to the release. Every push to `main` also builds the app on GitHub (Actions tab → latest *Build macOS app* run → *Codeome-mac* artifact), and the tests run on every push and pull request (*CI* workflow).

### Advanced — run or build from source

Requires Node.js 20+ and the Xcode command-line tools (`xcode-select --install`).

```bash
git clone https://github.com/anttonalberdi/codeome.git
cd codeome
npm install          # also rebuilds the terminal backend for Electron
npm start            # run in development
npm run dist         # build dist/Codeome-<version>-arm64.dmg
```

If terminals say they need a rebuild, run `npm run rebuild`.

## Next steps

- Configure your HPC login, network, agents and accounts in [Settings](/settings).
- Start working with the [Agent chat](/guide/agent-chat).
