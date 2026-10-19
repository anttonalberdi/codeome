---
sidebar: false
aside: false
outline: false
---

# Codeome in 12 slides: for beginners

New to the command line, the HPC or coding agents? This tour covers the basics. Each slide links to the full page. Use the arrow keys, the buttons below or the dots. Press `F` for full screen. Prefer the full detail? Start from [Getting started](/guide/getting-started). Already comfortable with clusters? Try the [advanced tour](/slides/advanced).

<SlideDeck>

<Slide title="What is Codeome?" more="/guide/getting-started" label="Getting started">

Codeome is **one Mac app for research computing**. It puts what you need for analysis work in one window:

- a **code editor** for R, Python and Quarto
- **terminals**, on your Mac and on the cluster
- an **AI team** you talk to in a chat
- **file transfer**, **Git** and **plots**

The *HPC* (high-performance computing cluster) is the big shared computer your institution runs for heavy jobs. Codeome connects to it for you.

<Shot src="/screens/overview.webp" alt="The Codeome window with the project list, files, editor, agent chat and terminal" width="900" />

</Slide>

<Slide title="Install it" more="/guide/getting-started#install" label="Install steps">

1. Open the [latest release](https://github.com/anttonalberdi/codeome/releases/latest) on GitHub.
2. Download the `.dmg`: **arm64** for Apple silicon (M1 and later), **x64** for Intel.
3. Open it and drag Codeome to *Applications*.

The first time, right-click Codeome in Applications, choose **Open**, then **Open** again. The app is not signed with an Apple certificate, so macOS asks once.

</Slide>

<Slide title="Set up once, in Settings" more="/settings" label="Settings">

Press `⌘,` to open Settings. For a first run you need three things:

1. **HPC login**: the name of your cluster from `~/.ssh/config`, if you have one.
2. **Network**: whether you reach the cluster directly, through a VPN, or through Codeome's own VPN tunnel.
3. **Agents and accounts**: sign in to Claude and/or Codex.

A **setup checklist** in Settings shows what is done and offers a button for each missing step. Changes save as you make them.

<Shot src="/screens/settings.webp" alt="The Settings page with the setup checklist" width="900" />

</Slide>

<Slide title="Projects: one card per piece of work" more="/guide/projects" label="Projects">

A *project* is a folder on your Mac. Press `⌘O` to open one.

- Each open project is a **card** in the left column.
- Every project keeps its **own** editor tabs, terminals, chats and HPC folder.
- Things keep running when you switch to another project.

Cards show running jobs and unsaved files, so you can see what needs attention.

<Shot src="/screens/projects-groups.webp" alt="The project column with several project cards in groups" width="700" />

</Slide>

<Slide title="Write and run code" more="/guide/editor" label="Editor">

Open a file from the **Files** panel. The editor is the same engine as VS Code.

- `⌘↩` runs the current line or selection, as in RStudio.
- R code goes to an **R console** that Codeome starts for you.
- Quarto and R Markdown documents have **Run chunk** buttons and **Knit**.

You can open and edit files on the cluster directly, with no copying back and forth.

<Shot src="/screens/editor.webp" alt="The editor with an R script and the R console" width="900" />

</Slide>

<Slide title="Plots and reports appear in place" more="/guide/plots" label="Plots">

Plots from R open in the **Plots** view (`⌘7`), not in a separate window. You can resize them, step through earlier ones and **export** to PNG, PDF, SVG and more at journal sizes.

Reports (`⇧⌘V`) render Quarto, R Markdown and notebooks next to your code and refresh when you save. See [Reports](/guide/reports).

<Shot src="/screens/plots.webp" alt="The Plots view with an exported-size preview" width="900" />

</Slide>

<Slide title="The agent chat: ask in plain language" more="/guide/agent-chat" label="Agent chat">

Press `⌘1` to open the chat. Type what you want, such as *“Why does this script fail?”* or *“Add a bar chart of counts per sample.”*

- Questions and small edits it handles itself.
- Bigger jobs it **plans first** and hands to specialists.
- It **asks you** before doing anything that matters.

You choose how much freedom it has with the selector under the message box. Start with *Ask before changes*.

<Shot src="/screens/agent-chat.webp" alt="The agent chat with job cards and the permission selector" width="900" />

</Slide>

<Slide title="You stay in control" more="/guide/team" label="The team">

For larger tasks the agent follows a fixed routine:

1. It writes a **plan** and asks you to approve it.
2. Specialists do the work: Claude and Codex, whichever suits the task.
3. The result is **reviewed by the other engine**.
4. You approve again before anything is committed.

Approval questions appear as **buttons** in the chat. Nothing is committed until you say so.

</Slide>

<Slide title="Working on the HPC" more="/guide/hpc" label="HPC connection">

Codeome logs in to the cluster **once** and keeps the connection open. If it needs a password or one-time code, it asks in a dialog.

- Open **HPC shells** from the terminal panel (`⌘J`).
- Watch your jobs in the **Slurm** view: waiting, running, finished, and which ones failed or ran out of memory. See [Slurm](/guide/slurm).
- Agents can work on the cluster too, and keep running if your VPN drops.

</Slide>

<Slide title="Move files between places" more="/guide/files-transfer" label="Files & transfer">

The **Files** panel shows your Mac, the HPC and long-term storage in one place. Drag files between them, or from Finder.

For bigger copies open the **Transfer view** (`⌘8`): two panes side by side and a queue showing progress, so you can pause, retry or cancel a copy.

<Shot src="/screens/files.webp" alt="The Files panel with the Mac, HPC and storage sections" width="900" />

</Slide>

<Slide title="Save your work with Git" more="/guide/git-github" label="Git & GitHub">

Git keeps a history of your project, so you can go back if something breaks.

- See changes, stage, commit, pull and push from the Git panel.
- Publish a project to GitHub and open pull requests from the app.
- Or tell the agent *“commit and push”*. It asks first.

When you publish a release, [Zenodo](/guide/publishing) can give it a citable DOI.

</Slide>

<Slide title="Keep your keys safe, then go further" more="/guide/secrets" label="Secrets">

Store tokens and passwords in **Settings → Secrets**. They are kept encrypted in the macOS Keychain and **never shown again**. Never paste a token into the chat.

**Where next?**

- Read the guide in order, starting with [Getting started](/guide/getting-started).
- Look up shortcuts in [Keyboard shortcuts](/reference/keyboard).
- Know the basics already? The [advanced tour](/slides/advanced) covers routing, policies and the cluster workflow.

</Slide>

</SlideDeck>
