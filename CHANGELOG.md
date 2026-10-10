# Changelog

What changed in each version of Codeome, newest first. The version is the one in `package.json`, shown next to the name in the title bar. The agent kit installed into projects has its own version (`kit/manifest.json`), noted here when it changes.

## Unreleased

### Added
- **Project groups**: *+ Group* under the project cards makes a named group. Drag cards onto its header, or right-click a card and pick *Move to…*, then click the header to fold the group to one line. A folded group shows how many projects it holds and a dot for the most pressing state among them. The button that opens a project is now *+ Project*.
- **Connected projects**: right-click a project card and pick *Connect to projects…* to tie it to other projects. The agent chat of each then reads and edits the other's files and follows its `CLAUDE.md`, so connected projects work as one larger project. The card shows a chain with the number of projects it is connected to; click it to change them. Chats that are running pick a change up when they restart.
- **Release playbooks** in the agent kit (kit 0.5.0): step-by-step guides for publishing to PyPI, Bioconda, conda-forge, CRAN and Bioconductor. They come with the *Release & docs* role group, and the release-manager reads the one a task names. Each lists the steps only you can do, such as CRAN's confirmation email or agreeing to maintain a recipe.
- **Skills in Settings → Agents**: every skill in the project's `.claude/skills/`, marked as a command you type in the chat or a playbook the team reads, with its files one click away and a mark on the ones you have edited. *+ New skill* creates one.
- **Global and project scopes in Settings → Agents**: the page now has two parts. *All projects* holds the chat's model, the command-line agents, and the agents and skills in `~/.claude/`, which were not shown before; *This project* holds the open project's team and skills. Global agents get a model and effort, and *+ New agent* and *+ New skill* exist in both parts. Where a global and a project item share a name, both are marked with the one Claude Code uses.
- **Google Docs, Sheets and Slides in the main window**: a `.gdoc`, `.gsheet` or `.gslides` file from Google Drive for desktop opens as a tab holding the live Google editor, signed in once inside Codeome. *Ask the agent* on the tab points the chat at the document, and the chat edits it in place through the Google connectors of your Claude account.
- **Chat history**: the clock button in the Agent header lists every saved chat of the project, newest first, with a search box. Click one to open it in a tab; a chat that is not open can be deleted there.
- The agent chat adapts to the width of its section: in a narrow sidebar the controls under the message box wrap and the gutters tighten, and in a wide one the tabs show more of their titles and answer options sit side by side.
- **Switch a chat's Claude account**: click the account's email under the message box and pick another account. The conversation moves with its history and continues there with your next message.
- The version number next to CODEOME in the title bar.
- This changelog.

### Changed
- Kit skills now belong to a role group, like roles. Deselecting a group removes its skills too, except files you have edited.
- The release-manager asks for approval before opening a pull request or issue on someone else's repository, submitting to CRAN, or uploading a package to win-builder or R-hub. Package recipes for Bioconda and conda-forge are routed to it instead of the pipeline-engineer.

## 0.1.0

First version: the work up to 10 October 2026.

- Editor, terminals and a file browser for this Mac, the HPC and SFTP storage, with a Transfer view for copying between them.
- HPC connection from Settings, with Codeome's own VPN tunnel and saved logins; Slurm queue, history and cluster resources.
- One agent chat for Claude Code and Codex, with chat tabs, attachments, saved messages, token use per chat and session statistics.
- The agent kit: 15 specialist roles in four groups, `/orchestrate`, `/delegate` and `/cross-review`, a job runner for Codex, and an engine, model and effort per agent.
- Several Claude and Codex accounts, with their usage limits tracked and jobs moved to an account with headroom.
- R console, runnable R Markdown and Quarto chunks, a plot viewer, and R and Python package lists.
- Git and GitHub view; Zenodo uploads and PyPI publishing.
