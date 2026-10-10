# Changelog

What changed in each version of Codeome, newest first. The version is the one in `package.json`, shown next to the name in the title bar. The agent kit installed into projects has its own version (`kit/manifest.json`), noted here when it changes.

## Unreleased

### Added
- **GitHub Actions**: a *CI* workflow runs the tests on every push to `main` and on pull requests, and a *Build macOS app* workflow builds the unsigned `.dmg` files on every push to `main` (the *Codeome-mac* artifact) and attaches them to a GitHub release when a `v*` tag matching the version in `package.json` is pushed.

## 0.3.1

### Added
- **Dark Google documents**: in dark mode, Google Docs, Sheets and Slides tabs are shown with flipped colours, on the same dark blue as the rest of the app, with pictures and video left as they are. The *Original colours* button in a document's toolbar switches that tab back to Google's own colours, and *Dark colours* flips it again. The flip is visual only and changes nothing in the document.

## 0.3.0

### Added
- **Codex chats**: a new chat can run on Codex instead of Claude. Pick the AI under the message box before the first message; it stays for the life of the chat, and the tab, the history and the bar under the message box show which one it is. A Codex chat is the orchestrator for the team too: it hands work to Codex specialists, and uses the account, model and effort set for Codex (Settings → *Agents* → *Codex chats*). It can't edit Google Docs, Sheets or Slides, which go through Claude's connectors, so it says so with a button that starts a Claude chat. A Codex chat can't change account or continue in a terminal yet.

### Changed
- The agent chat shows an *is thinking…* line with a running timer from the moment a message is sent until the turn ends, so a quiet agent is not mistaken for a stuck one. Your messages and the agent's replies carry the time they were sent.

### Fixed
- The Claude and Codex usage card in the title bar stays under its button. It used to jump to the top-left corner of the window whenever the usage was refreshed while it was open.

## 0.2.0

### Added
- **Secrets**: Settings → *Secrets* saves your own access tokens, API keys and passwords, encrypted with the macOS Keychain. Each is named as an environment variable and is never shown again once saved. *Copy* puts it on the clipboard for 30 seconds; *Terminals* and *Agents* set it as an environment variable in terminals and in agent sessions on this Mac, in every project or only in the ones you pick.
- **Project groups**: *+ Group* under the project cards makes a named group. Drag cards onto its header, or right-click a card and pick *Move to…*, then click the header to fold the group to one line. A folded group shows how many projects it holds and a dot for the most pressing state among them. The button that opens a project is now *+ Project*.
- **Connected projects**: right-click a project card and pick *Connect to projects…* to tie it to other projects. The agent chat of each then reads and edits the other's files and follows its `CLAUDE.md`, so connected projects work as one larger project. The card shows a chain with the number of projects it is connected to; click it to change them. In the title bar, the tag of the open project is followed by a smaller tag for each connected project, joined by a chain; click one to switch to that project. Chats that are running pick a change up when they restart.
- **Release playbooks** in the agent kit (kit 0.5.0): step-by-step guides for publishing to PyPI, Bioconda, conda-forge, CRAN and Bioconductor. They come with the *Release & docs* role group, and the release-manager reads the one a task names. Each lists the steps only you can do, such as CRAN's confirmation email or agreeing to maintain a recipe.
- **Skills in Settings → Agents**: every skill in the project's `.claude/skills/`, marked as a command you type in the chat or a playbook the team reads, with its files one click away and a mark on the ones you have edited. *+ New skill* creates one.
- **Global and project scopes in Settings → Agents**: the page now has two parts. *All projects* holds the chat's model, the command-line agents, and the agents and skills in `~/.claude/`, which were not shown before; *This project* holds the open project's team and skills. Global agents get a model and effort, and *+ New agent* and *+ New skill* exist in both parts. Where a global and a project item share a name, both are marked with the one Claude Code uses.
- **Google Docs, Sheets and Slides in the main window**: a `.gdoc`, `.gsheet` or `.gslides` file from Google Drive for desktop opens as a tab holding the live Google editor, signed in once inside Codeome. *Ask the agent* on the tab points the chat at the document, and the chat edits it in place through the Google connectors of your Claude account.
- **Chat history**: the clock button in the Agent header lists every saved chat of the project, newest first, with a search box. Click one to open it in a tab; a chat that is not open can be deleted there.
- The agent chat adapts to the width of its section: in a narrow sidebar the controls under the message box wrap and the gutters tighten, and in a wide one the tabs show more of their titles and answer options sit side by side.
- **Switch a chat's Claude account**: click the account's email under the message box and pick another account. The conversation moves with its history and continues there with your next message.
- **Agent projects on the HPC**: Settings → *HPC* → *Agent projects* names the folder where the agents put the projects they run on the HPC, each in its own folder named after the project. The agent chat is told the folder when it starts, and reuses a project's folder if it is already there.
- **HPC name**: Settings → *HPC* → *Name* gives the cluster a name, such as MyCluster. The title bar and the HPC files pane show it instead of the login; hover the title bar's HPC segment to see the login.
- In a narrow window (under 1160 px) the title bar drops the Slurm job counts, and the Claude and Codex meters shrink to the name over its weekly bar.
- **App icon**: a pair of braces around four coloured lines, in the Dock, the app switcher and Finder, and in the title bar next to the window buttons.
- The version number next to CODEOME in the title bar.
- This changelog.

### Changed
- Kit skills now belong to a role group, like roles. Deselecting a group removes its skills too, except files you have edited.
- The release-manager asks for approval before opening a pull request or issue on someone else's repository, submitting to CRAN, or uploading a package to win-builder or R-hub. Package recipes for Bioconda and conda-forge are routed to it instead of the pipeline-engineer.
- The packaged app is signed ad hoc, so macOS knows it as Codeome instead of as Electron.

### Fixed
- Connecting to the HPC with the VPN tunnel off no longer fails the first time with *Connection closed by UNKNOWN port 65535*. After the VPN sign-in, Codeome now waits until the HPC login answers through the tunnel before it connects.

## 0.1.0

First version: the work up to 10 October 2026.

- Editor, terminals and a file browser for this Mac, the HPC and SFTP storage, with a Transfer view for copying between them.
- HPC connection from Settings, with Codeome's own VPN tunnel and saved logins; Slurm queue, history and cluster resources.
- One agent chat for Claude Code and Codex, with chat tabs, attachments, saved messages, token use per chat and session statistics.
- The agent kit: 15 specialist roles in four groups, `/orchestrate`, `/delegate` and `/cross-review`, a job runner for Codex, and an engine, model and effort per agent.
- Several Claude and Codex accounts, with their usage limits tracked and jobs moved to an account with headroom.
- R console, runnable R Markdown and Quarto chunks, a plot viewer, and R and Python package lists.
- Git and GitHub view; Zenodo uploads and PyPI publishing.
