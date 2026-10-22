---
layout: page
sidebar: false
aside: false
title: Codeome for advanced bioinformaticians
---

<SlideDeck title="Codeome · for advanced bioinformaticians">

<Slide title="The model in one slide" more="/guide/getting-started" label="Getting started">

One Electron app, one window, many projects.

- **Editor**: Monaco with R, Python, shell, Quarto, Snakemake and YAML, on the Mac *and* on the HPC.
- **Terminals**: local, HPC, R consoles, Claude Code and Codex sessions.
- **Agent chat**: a headless Claude Code orchestrator that delegates to Claude subagents and Codex jobs.
- **Ops**: Slurm queue, file transfer, packages, reports, Git/GitHub, Zenodo, PyPI.

It adds a layer around `ssh`, `rsync`, `git` and `gh`; it does not replace them.

<Shot src="/screens/overview.webp" alt="The Codeome window with all panels" width="900" />

</Slide>

<Slide title="Projects as isolated workspaces" more="/guide/projects" label="Projects">

- Each project is a card with its own tabs, terminals, chat sessions and **HPC folder**.
- Sessions keep running while you work in another project. `⌃⇥` switches, `⌘O` opens, `⇧⌘W` closes.
- **Groups** organise cards. Cards show running jobs, live sessions and unsaved files.
- Settings split into **app defaults** and **per-project overrides** (`⌘9`): the project value wins, else the app default, else the built-in.

See [Project settings](/guide/project-settings) and the [project layout](/reference/project-layout).

<Shot src="/screens/projects-groups.webp" alt="The project column with cards in groups" width="900" />

</Slide>

<Slide title="HPC connection: your ssh, once" more="/guide/hpc" label="HPC connection">

- Codeome shells out to the **system `ssh`**: `~/.ssh/config`, keys, ProxyJump and the VPN behave as in iTerm2.
- One authenticated **ControlMaster** connection is shared by the file panes, Slurm views, terminals and agents. Password, passphrase, OTP and host-key prompts appear in a dialog.
- **VPN**: use the Mac's, or Codeome's own OpenConnect tunnel so only HPC traffic goes through it.
- HPC agent sessions run in **`tmux`**: they survive a dropped VPN and reattach on reopen.

Setup: [Settings](/settings).

<Shot src="/screens/settings-hpc.webp" alt="The HPC settings with VPN tunnel, login and shared connection" width="900" />

</Slide>

<Slide title="Run, monitor and debug jobs" more="/guide/slurm" label="Slurm">

- **Slurm view**: live `squeue`, plus `sacct` history with exit codes and peak memory. Failed, timed-out and OOM jobs are marked red.
- A fourth section shows free and used **CPUs, memory and GPUs** for the cluster and per partition, to size your next request.
- `⌘↩` / `⇧⌘↩` send code to the active **R console**, including R inside an `srun` interactive job. Right-click the tab to choose where R code goes.
- Plots from remote R sessions are fetched into the [Plots view](/guide/plots) and re-drawn at any export size.

<Shot src="/screens/slurm.webp" alt="The Slurm view with job history and cluster resources" width="900" />

</Slide>

<Slide title="Agent orchestration" more="/guide/agent-chat" label="Agent chat">

The chat classifies each message and acts at the right level:

| Level | Behaviour |
|---|---|
| Question or lookup | Answered directly |
| Trivial change | Edited, verified, summarised |
| Larger task | `/orchestrate` pipeline |
| Named engine or role | `/delegate` |
| Review of changes | `/cross-review` |

Several chats run in parallel as tabs. A **context meter** warns past 70%, and the time-tree view (right-click a tab) shows jobs, plans and token counts.

<Shot src="/screens/agent-chat.webp" alt="Agent chat with parallel tabs and job cards" width="900" />

</Slide>

<Slide title="The pipeline and the team" more="/guide/team" label="The team">

**size → plan → your approval → specialists implement → orchestrator verifies → cross-review → your approval → commit.**

- 16 roles in four groups: core, research computing (analyst, pipeline-engineer, hpc-operator, report-writer, figure-designer), web stack, release & docs.
- **Routing**: well-specified implementation and debugging go to Codex; planning, docs and anything needing the network or HPC go to Claude. Reviews run on the engine that did *not* write the change.
- Codex runs in a sandbox with no network, so HPC work goes to Claude roles.
- `routing.md` in the project lets you change routing per project.

<Shot src="/diagrams/team.svg" alt="The orchestrator routing work to Claude and Codex, with review by the other engine" width="900" />

</Slide>

<Slide title="The agent kit is plain files" more="/reference/agent-kit" label="Agent kit reference">

Installing the kit writes into the repo, so it is versioned and shared:

- `.claude/agents/<role>.md`: roles for Claude subagents; Codex reads the same files
- `.claude/skills/{orchestrate,delegate,cross-review}/` and `release/` playbooks
- `.claude/settings.json`: hooks that record subagent jobs
- `.codeome/bin/codeome-agent`: a stdlib-only Python job runner that also works on the HPC (`list`, `show`, `cancel`, `usage`)

Updates never overwrite a role or skill you edited.

<Shot src="/diagrams/kit.svg" alt="The files the agent kit writes into a project" width="900" />

</Slide>

<Slide title="Policies and permission modes" more="/guide/project-settings" label="Project settings">

Five switches, set app-wide in Settings → *Agent policy* and overridable per project:

- **Slurm submission**: Ask, Allow, Never
- **Git publishing**: Ask, Never
- **HPC access**: Full or Read-only (denies `rm`, `mv`, `cp`, `sbatch`, `scancel` …)
- **Writes outside the project**: Ask, Never
- **Require a plan**: Off or On

*Never* is enforced by permission checks; *Read-only* and *Require a plan* are partly advisory. Chat modes: *Ask before changes*, *Accept edits*, *Auto*, *Plan only*.

<Shot src="/diagrams/policies.svg" alt="The five agent policy switches and their options" width="900" />

</Slide>

<Slide title="Accounts, limits and cost" more="/guide/team#accounts-and-limits" label="Accounts and limits">

- Several Claude and Codex accounts can be signed in. Jobs go to the account with the most headroom.
- The title bar shows **5-hour and weekly usage** per account. Past the stop threshold (90% by default) new jobs are held.
- Each finished turn is logged to `~/.codeome/stats/turns.jsonl`; the chat meter shows tokens and API-list-price cost.
- The **Forum** puts a Claude seat and a Codex seat in a moderated discussion. Each post costs a small check per seat. See [Forum & Ideas](/guide/forum-ideas).

<Shot src="/screens/settings-accounts.webp" alt="Accounts and limits with 5-hour and weekly usage bars" width="900" />

</Slide>

<Slide title="Data movement" more="/guide/files-transfer" label="Files & transfer">

- Files has three sections: Mac, HPC and long-term storage over SFTP (such as ERDA).
- **Transfer view** (`⌘8`): two panes, a queue with 1–4 parallel slots, pause, retry and cancel.
- HPC ⇄ storage copies run **on the HPC** in reusable *Transfers N* terminals, so a long queue does not fill the panel with tabs.
- If the target exists you are asked to replace or skip. SFTP has no copy, so copying within the storage is not possible.

<Shot src="/screens/transfer.webp" alt="The Transfer view with two panes and a queue" width="900" />

</Slide>

<Slide title="Secrets on the Mac and the HPC" more="/guide/secrets" label="Secrets">

- Tokens for GitHub, Zenodo and PyPI, and your own named variables, are encrypted with the macOS **Keychain** and never shown again.
- Per secret, switch on *Terminals*, *Agents* and/or *HPC*, and limit it to chosen projects.
- *Sync to HPC* writes a per-project `0600` env file under `~/.codeome/secrets/` in your HPC home, never under `/projects`. Source it in terminals or at the top of job scripts.

HPC secrets are plaintext on disk and shared across your projects by your one account. Read the warnings first.

<Shot src="/screens/secrets.webp" alt="The Secrets page with per-secret scope switches" width="900" />

</Slide>

<Slide title="Release and publish" more="/guide/publishing" label="Publishing">

- **Git & GitHub**: status, diff, stage, commit, push, PRs and releases, with per-project account binding. See [Git & GitHub](/guide/git-github).
- **Zenodo**: drafts, metadata, uploads, publish and new versions. Link the repo and each GitHub release gets a DOI.
- **Packages** (`⌘6`): pip and R libraries on the Mac or HPC, with renv and Bioconductor support, plus build and upload to TestPyPI/PyPI.
- The **release-manager** role has playbooks for PyPI, Bioconda, conda-forge, CRAN and Bioconductor and stops at the steps only you can do.

<Shot src="/screens/packages.webp" alt="The Packages view with Python and R libraries" width="900" />

</Slide>

<Slide title="Reference and next steps" more="/reference/keyboard" label="Keyboard shortcuts">

- [Keyboard shortcuts](/reference/keyboard)
- [Settings](/settings) for HPC, network, agents, storage and accounts
- [Agent kit](/reference/agent-kit) and [project layout](/reference/project-layout)
- The full [guide](/guide/getting-started), which holds the detail behind every slide

New to this? See the [beginner guide](/slides/beginners).

Found a gap? Each page has an *Edit this page on GitHub* link.

<Shot src="/diagrams/reference.svg" alt="Reference pages: shortcuts, settings, agent kit and project layout" width="900" />

</Slide>

</SlideDeck>
