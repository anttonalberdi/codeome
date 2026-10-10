# Changelog

What changed in each version of Codeome, newest first. The version is the one in `package.json`, shown next to the name in the title bar. The agent kit installed into projects has its own version (`kit/manifest.json`), noted here when it changes.

## Unreleased

### Added
- **Release playbooks** in the agent kit (kit 0.5.0): step-by-step guides for publishing to PyPI, Bioconda, conda-forge, CRAN and Bioconductor. They come with the *Release & docs* role group, and the release-manager reads the one a task names. Each lists the steps only you can do, such as CRAN's confirmation email or agreeing to maintain a recipe.
- **Skills in Settings → Agents**: every skill in the project's `.claude/skills/`, marked as a command you type in the chat or a playbook the team reads, with its files one click away and a mark on the ones you have edited. *+ New skill* creates one.
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
