---
layout: page
sidebar: false
aside: false
title: Codeome starting guide
---

<SlideDeck title="Codeome starting guide · for beginners">

<Slide title="Welcome to Codeome" step="Start here" more="/guide/getting-started" label="Getting started">

**One Mac app for research computing.** A code editor, terminals, an AI team in a chat, file transfer, Git and plots, in one window.

This guide takes you from install to your first analysis in a few minutes:

1. **Install** and **set up** (once)
2. **Open a project**
3. **Work**: write code, ask the agent, use the cluster
4. **Save and share**

Use `→` and `←` to move. Press `F` for full screen.

<Shot src="/screens/overview.webp" alt="The Codeome window with the project list, files, editor, agent chat and terminal" width="900" />

</Slide>

<Slide title="Install the app" step="1 · Set up" more="/guide/getting-started#install" label="Install steps">

1. Open the [latest release](https://github.com/anttonalberdi/codeome/releases/latest) on GitHub.
2. Download the `.dmg`: **arm64** for Apple silicon (M1 and later), **x64** for Intel.
3. Open it and drag Codeome to *Applications*.

The first time, right-click Codeome and choose **Open**, then **Open** again. The app is not signed with an Apple certificate, so macOS asks once.

<Shot src="/diagrams/install.svg" alt="The three install steps: download the .dmg, drag to Applications, right-click and Open" width="900" />

</Slide>

<Slide title="Open Settings and follow the checklist" step="2 · Set up" more="/settings" label="Settings">

Press `⌘,`. A **setup checklist** shows what is done and gives a button for each missing step. Changes save as you make them.

You need three things for a first run:

- **HPC login**: your cluster's address and username, entered in a short wizard (skip if you have no cluster)
- **Network**: direct, your VPN, or Codeome's own VPN tunnel
- **Agents**: sign in to Claude and/or Codex

<Shot src="/screens/settings.webp" alt="The Settings page with the setup checklist" width="900" />

</Slide>

<Slide title="Connect to your cluster" step="3 · Set up" more="/guide/hpc" label="HPC connection">

The *HPC* is the big shared computer your institution runs for heavy jobs.

- Click **Set up…** next to *Login*, then enter the cluster's address and your username. Codeome does the rest.
- Codeome logs in **once** and keeps the connection open.
- If it needs a password or one-time code, it asks in a dialog.
- Agents can work on the cluster too, and keep going if your VPN drops.

Not on a cluster? Skip this slide: everything else works on your Mac.

<Shot src="/screens/settings-hpc.webp" alt="The HPC section of Settings with the login, key and connection steps" width="900" />

</Slide>

<Slide title="Sign in to the AI agents" step="4 · Set up" more="/guide/team" label="The team">

The chat is run by **Claude**, which hands work to specialists on **Claude** or **Codex**.

- Sign in to one or both under *Agents and accounts* in Settings.
- Claude alone is enough to start.
- The title bar shows your usage, and new jobs pause near the limit.

<Shot src="/screens/settings-agents.webp" alt="The Agents section of Settings" width="900" />

</Slide>

<Slide title="Store tokens in Secrets" step="5 · Set up" more="/guide/secrets" label="Secrets">

Tokens for GitHub, Zenodo or your own services go in **Settings → Secrets**.

- Kept encrypted in the macOS Keychain, **never shown again**.
- Choose where each one is available: terminals, agents, the HPC.
- Never paste a token into the chat. If you do, rotate it.

You can skip this now and come back when you need a token.

<Shot src="/screens/secrets.webp" alt="The Secrets page with saved tokens and per-scope switches" width="900" />

</Slide>

<Slide title="Open your first project" step="6 · Get going" more="/guide/projects" label="Projects">

A *project* is a folder on your Mac. Press `⌘O` to open one.

- Each project is a **card** in the left column.
- It keeps its **own** editor tabs, terminals, chats and HPC folder.
- Work keeps running when you switch to another project.

<Shot src="/screens/projects-groups.webp" alt="The project column with several project cards in groups" width="700" />

</Slide>

<Slide title="Find and move your files" step="7 · Get going" more="/guide/files-transfer" label="Files & transfer">

The **Files** panel shows your Mac, the HPC and long-term storage together.

- Drag files between them, or in from Finder.
- For big copies open the **Transfer view** (`⌘8`): a queue with progress, pause, retry and cancel.

<Shot src="/screens/files.webp" alt="The Files panel with the Mac, HPC and storage sections" width="900" />

</Slide>

<Slide title="Write and run code" step="8 · Work" more="/guide/editor" label="Editor">

Open a file from **Files**. The editor is the engine behind VS Code.

- `⌘↩` runs the current line or selection, as in RStudio.
- R code goes to an **R console** Codeome starts for you.
- Quarto documents have **Run chunk** and **Knit** buttons.
- Files on the cluster open and save directly.

<Shot src="/screens/editor.webp" alt="The editor with an R script and the R console" width="900" />

</Slide>

<Slide title="Plots and reports appear in place" step="9 · Work" more="/guide/plots" label="Plots">

- Plots open in the **Plots** view (`⌘7`), not a separate window.
- Step through earlier plots and **export** to PNG, PDF or SVG at journal sizes.
- Reports (`⇧⌘V`) render Quarto, R Markdown and notebooks beside your code and refresh when you save.

<Shot src="/screens/plots.webp" alt="The Plots view with an exported-size preview" width="900" />

</Slide>

<Slide title="Ask the agent in plain language" step="10 · Work" more="/guide/agent-chat" label="Agent chat">

Press `⌘1` and type, for example *“Why does this script fail?”*

- Questions and small edits: it handles them itself.
- Bigger jobs: it **plans first**, then hands work to specialists.
- It **asks you** before anything that matters.

Pick *Ask before changes* in the selector under the message box to start.

<Shot src="/screens/agent-chat.webp" alt="The agent chat with job cards and the permission selector" width="900" />

</Slide>

<Slide title="You stay in control" step="11 · Work" more="/guide/team" label="The team">

For larger tasks the agent follows a fixed routine:

1. It writes a **plan** and asks you to approve it.
2. Specialists do the work.
3. The **other engine reviews** the result.
4. You approve again before anything is committed.

Approvals appear as **buttons** in the chat.

<Shot src="/diagrams/control.svg" alt="The routine: plan, your approval, specialists, cross-review, your approval, commit" width="900" />

</Slide>

<Slide title="Run and watch cluster jobs" step="12 · Work" more="/guide/slurm" label="Slurm">

- Open **HPC shells** from the terminal panel (`⌘J`).
- The **Slurm** view lists jobs as waiting, running or finished, and marks failed or out-of-memory ones in red.
- It also shows free CPUs, memory and GPUs, to help size your next request.

<Shot src="/screens/slurm.webp" alt="The Slurm view with running, waiting and failed jobs and cluster resources" width="900" />

</Slide>

<Slide title="Save your work with Git" step="13 · Share" more="/guide/git-github" label="Git & GitHub">

Git keeps a history, so you can go back if something breaks.

- See changes, stage, commit, pull and push from the Git panel.
- Publish to GitHub and open pull requests from the app.
- Or tell the agent *“commit and push”*. It asks first.
- Releases can get a citable DOI through [Zenodo](/guide/publishing).

<Shot src="/screens/git.webp" alt="The Git panel with changes, a commit box and history" width="900" />

</Slide>

<Slide title="You are ready" step="Next" more="/guide/getting-started" label="Read the full guide">

- Read the [guide](/guide/getting-started) for the detail behind each slide.
- Look up [keyboard shortcuts](/reference/keyboard).
- Comfortable with clusters and Slurm? Take the [advanced tour](/slides/advanced).

Found a gap? Every page has an *Edit this page on GitHub* link.

<Shot src="/diagrams/ready.svg" alt="Next steps: the full guide, keyboard shortcuts and the advanced tour" width="900" />

</Slide>

</SlideDeck>
