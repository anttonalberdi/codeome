# Changelog

What changed in each version of Codeome, newest first. The version is the one in `package.json`, shown next to the name in the title bar. The agent kit installed into projects has its own version (`kit/manifest.json`), noted here when it changes.

## Unreleased

### Added
- **Find in the active block (⌘F)**: ⌘F opens a find bar for whichever block you last clicked in: the agent chat, a preview, the file list, Slurm, Git and the other panels. It highlights every match, steps through them with Enter and ⇧Enter (or ⌘G and ⇧⌘G), follows live content such as a streaming chat, and closes with Esc. Terminals and the code editor keep their own ⌘F. Previews shown in an embedded frame (HTML, PDF) are not searched.
- **Dates in the file list**: each file and folder in the project's file list shows the date it was added and the date it was last modified next to its size, and the tooltip gives the added date too.
- **Crash logging and Help → Reveal Logs**: Codeome keeps a rotating log (`main.log`, 1 MB with 3 backups) in `~/Library/Logs/Codeome`. It records uncaught exceptions, unhandled rejections, renderer, GPU and child process crashes, unresponsive windows, renderer errors, and chat and terminal process exits, plus a heartbeat every 30 seconds with memory use that warns above 3 GB. Native crash dumps are saved locally and nothing is uploaded. If the previous run did not end with a clean shutdown, the next launch shows "Codeome closed unexpectedly last time" with the last log lines and *Open log* and *Copy report* buttons. *Reveal Logs* in the Help menu opens the folder.

## 1.2.3

### Added
- **Inkscape in Settings → Figures and the file list**: Settings has a *Figures* section that finds Inkscape (in Applications or on the PATH), shows its version and path, offers to install it with Homebrew when it is missing, and lets you set a path for an unusual installation. Right-clicking an SVG, PDF, EPS or EMF in the file list offers *Open in Inkscape*, or *Install Inkscape…* when it is missing. Codeome checks at startup and records the result in `~/.codeome/inkscape.json`, so the agents use the location you set, and the figure-designer and orchestrator stop and offer to install Inkscape instead of failing midway (agent kit 0.6.9).
- **Figure designer** (agent kit): a new role in the research group, with a `figures` skill, that turns R or Python figures into publication-ready ones with Inkscape's command line. It assembles SVG panels into a multi-panel figure that stays vector (`compose.py`; linked panels would be rasterised by Inkscape's PDF export), exports PDF, PNG or SVG to a journal's size, and checks the result against a pre-submission list. It never changes the data a figure shows: such requests go back to the analyst. Needs Inkscape installed.
- **Saved project groups**: a menu in the project column saves the open projects as a named project group, and lets you load, rename or delete saved groups. Loading a group opens its projects alongside those already open and skips folders that no longer exist.
- **Open connected projects**: when you open a project manually and it has connected projects that are not open, a window lists them all, ticked, so you can untick any before they are opened.
- **Pause and Resume for Codex jobs**: a running Codex job card has *Pause job* (in its menu and in its log view's toolbar), which waits for the reply in progress to finish and then stops the job cleanly. A paused job has *Resume job*, which continues the same Codex conversation (agent kit 0.6.7).
- **Auto-refreshing file tabs**: a file open in the editor is re-read about every second and a half and when the window regains focus, so changes made by an agent or a terminal appear without reopening it. A tab with unsaved edits is left alone.
- **Connect to projects from the project tag menu**: the project tag's menu has *Connect to projects…*, and its picker now anchors correctly when the project card is hidden because the list is collapsed.

### Changed
- **Narrow windows**: when the window becomes too narrow for the editor and terminal pane, it folds away so the sidebar fills the window, and it unfolds again at its previous width when the window is widened.

### Fixed
- **Secret toggles reverting**: in Settings → Secrets, only the first change to a secret's scopes, note or project list stuck; later ones were lost because the row kept an outdated copy of the secret. Each change now applies to the current one.

## 1.2.2

### Added
- **New project from scratch**: the *New project* popup has a *Create a new project…* wizard. Pick a type (R project, R package, Python project or notebook, Python package, Quarto report, Snakemake workflow, or empty), then name it and choose a licence. Codeome writes a starter layout that follows the community standard for that type (usethis/devtools, PyPA src layout, Cookiecutter Data Science, Snakemake standardized usage), optionally runs `git init` with a first commit, and opens it.
- **HPC login wizard**: Settings → HPC has a *Set up…* button that asks for the cluster's address and your username (and a jump host or port if needed) and saves the login, so nobody has to edit `~/.ssh/config`. The beginner guide now points to it.

## 1.2.1

### Added
- **Reorderable groups**: project groups can be dragged to reorder them, and the projects within a group are indented under it.
- **Scrollbar in terminals**: terminals show an always-visible vertical scrollbar to scroll back through history.

### Changed
- **Dates on chat and forum stamps**: when a message is not from today, its time stamp also shows the date.

### Fixed
- **Links to files in connected projects** open: agents give absolute paths, and the chat now resolves project-prefixed relative links.
- **Project list scroll position** is kept when the list re-renders.
- **"Launch in a new session"** on a prompt in chat opens a new chat tab with that prompt as its first message, on the same engine and account as the chat it came from, instead of opening a terminal. The new chat uses the project's default model and effort.

## 1.2.0

### Changed
- **HPC terminal colours**: the HPC terminal starts bash with `ls` and `grep` colours, `LS_COLORS` and a coloured prompt, unless your own config already sets them.

### Added
- **Docs: two slideshow tours** (beginners and advanced bioinformaticians) that cover the basics as slides and link to the detailed guide pages, which stay as the deepest level.
- **Name clashes in transfers**: when a file or folder being copied already exists at the destination, a window asks whether to replace or skip it, with a tick box to give the same answer to the rest of the queue. Skipped transfers show as "Skipped (already exists)".
- **Clear queued** button in the transfer queue: cancels and removes every transfer that is still waiting, leaving the running ones alone.
- **Secrets on the HPC (opt-in)**: each secret has a third switch, *HPC*, and Settings → Secrets has a *Sync to HPC* button. Syncing writes the project's enabled secrets to a private file (mode `0600`, in a `0700` folder) in your HPC home, which Codeome HPC terminals source automatically. Values are stored in plaintext there, and the per-project scope limits what is synced. Agents get guidance on using secrets without printing them.
- **Agent kit 0.6.4**: agents ask before deleting intermediate files, with clean-up guidance in the chat prompts and the specialist report rules.

### Fixed
- **HPC ↔ storage copies reuse one connection**: each copy used to open its own `sftp` login to the storage, so a long queue made many connections and got the HPC blocked. Copies now share one connection (kept for 30 minutes), which also asks for the password only once.
- **Code-block copy button** in chat finds the code through the block again, so copying works.

## 1.1.1

### Changed
- **HPC ↔ storage copies share terminals**: instead of one terminal per copy, Files opens as many terminals as the *at a time* setting allows (named "Transfers 1", "Transfers 2"…) and each runs its copies one after another. Cancelling a running copy closes its terminal.

### Added
- **Find in terminals**: `⌘F` in a terminal opens a search field at its top right. Matches are highlighted with a count, `Enter` / `⇧Enter` step forward and back, and `Esc` closes it.
- **Worktree selector in Files**: when a project has two or more linked git worktrees (for example the ones agents create), This Mac shows a dropdown above the path bar, labelled with branch names and "(main)" for the main worktree. Picking one browses that worktree's files and search follows it; the *Project folder* button returns to the project. Chat and agents are unaffected, and projects without linked worktrees look the same as before.

## 1.1.0

### Changed
- **Hidden files** are listed by default in the Files and Transfer panes; an eye button in the header hides or shows them.
- **Slurm scope** is a sliding *This project / All jobs* switch instead of a text link.
- **Ideas** no longer has a card in the project list. When no project exists, its chat says it is the general chat.
- **Documentation and README**: the README opens with the download link and badges, and building from source is described as the advanced route.

### Added
- **Project settings**: a new view, the last item in the rail (`⌘9`), with per-project rules for agents: Slurm job submission (ask, allow, never), Git publishing (ask, never), HPC access (full, read-only), writes outside the project (ask, never) and require a plan. They are saved in Codeome's config, not in the repository. Permission checks apply to running chats at once; the rule text and CLI rules apply to new chats. Matching is heuristic and not a security boundary, and HPC access and require a plan are advisory.
- **App-wide defaults with project overrides**: Settings → Agent policy sets the five switches as defaults for all projects, and Settings → Agents gains a default permission mode and a default engine. Project settings shows "App default: X" on inherited rows, marks overridden rows, and has *Use app default* per row and *Reset to app defaults* at the bottom. A new *Agent defaults* card overrides the Claude and Codex model and effort, default permission mode and default engine for one project. The value used is the project's, else the app default, else the built-in default; a value picked in a project is always stored, even if it equals the built-in default. A permission mode chosen in a chat still wins.

## 1.0.2

### Added
- **Launch code blocks as prompts**: code blocks in chat have icon buttons to run them as a prompt in a new session, next to copy.
- **Drop files on a terminal**: dropping files on a terminal types their absolute paths.
- **Agent kit 0.6.2**: Codex reads Google documents through snapshots in `.codeome/context/` (now git-ignored).
- **Set up as R project**: right-click the active project when it is not detected as an R project and choose *Set up as R project…* to add a `.Rproj` file, initialise renv, add R entries to `.gitignore` and optionally a starter `analysis.Rmd`. renv is on by default on the Mac and off for the HPC. It works on the Mac or the HPC project folder, following the R selector, never overwrites existing files (skipped ones are named), and the R libraries section appears afterwards.

### Changed
- The default zsh prompt uses the terminal palette and local terminals enable `CLICOLOR`.

### Fixed
- Dependabot alerts: `dompurify` and `vite` overridden to patched versions.

## 1.0.1

### Added
- **Transfer favourites**: star a folder in a Transfer pane (or right-click a folder → Add to favourites) and pick it later from the favourites list next to the star. Settings has a new Transfer section to add, reorder and remove favourites for this Mac, the HPC and the storage.

## 1.0.0

First stable release.

### Added
- **Slurm project filter**: the Slurm view shows only the jobs run in the project's HPC folder by default; a toggle in its header switches to all your jobs.

### Added
- **Move Ideas to a project**: select chats or forums in Ideas and use *Move to project…* to move them into an open project or any folder. They leave Ideas and open in the project with their history, so an idea can grow into a project. A conversation whose transcript is missing is still moved, with a warning.
- **Ideas**: a chat and a forum that belong to no project, for talking through a new project or an idea that fits none of the existing ones. Open it from the welcome screen or the project bar. Its chats and forums are saved in `~/.codeome/scratch`. The agent kit is not installed there, so there are no jobs or specialists, and the Files, Git and Slurm views are hidden. Ideas does not appear in the project lists and its chats are left out of the usage statistics.
- **Google documents for Codex (kit 0.6.2)**: Codex cannot reach Google, so the Claude chat now exports a document it needs to read as a Markdown (or CSV) snapshot in `.codeome/context/` and names that path in the Codex brief. Codex can read the snapshot and draft text; only Claude writes to the live document. `.codeome/context/` is added to the project's `.gitignore`. Update the kit in each project to get it.

## 0.4.4

### Added
- **Formatted Markdown view**: a *Formatted* button beside *Wrap* shows the open Markdown file as a rendered document in its own tab, updating as you type.
- **Formatted job tab**: a job's Result and Brief are rendered as Markdown, with a *Raw* toggle. The Log is unchanged.
- **Conversation view for Claude subagent jobs**: shows the subagent's transcript with collapsible tool calls and thinking; tool results are cut at 4 KB. It updates live while the job runs.
- **Activity view for Codex jobs**: shows what Codex did, built from its structured events. This needs kit 0.6.1: the runner now runs `codex exec --json` and writes `events.jsonl` next to `log.txt`, which keeps its readable lines. Update the kit in each project (Settings → *Update kit to 0.6.1…*) to get it; older jobs and projects not yet updated keep showing the Log.

### Changed
- **Job tab refresh**: an open job tab refreshes every 3 seconds while the job is running, even when *Follow* is unticked.

## 0.4.3

### Added
- **File search**: the This Mac pane of the Files view has a *Search files in project…* field under the folder path. It matches file and folder names (and paths) anywhere in the project, skipping `node_modules`, `.git` and similar; double-click a result to open it, or a folder to go there. Esc or × clears it.
- **Suggested replies**: under a question that offers no options, the chat suggests a few clickable replies, written by a small Haiku call.
- **Clickable file names in chat**: file names in agent replies open the file, including bare names that live in a subfolder of the project.

### Changed
- **Folder path**: the path bar in each Files pane shows as plain text and only gets a box on hover or focus, so it no longer looks like the search field.

## 0.4.2

### Added
- **New project dialog**: pick an existing folder or clone a git URL to start a project, with a default project folder set in Settings.
- **Groups from a checkbox list**: a new group takes its projects from a checkbox list, with ungrouped projects listed first.

### Fixed
- **Release lookup**: Codeome releases are looked up through `gh`, so a private repository is no longer read as having no release.

## 0.4.1

### Added
- **Wrap toggle for Markdown**: a *↵ Wrap* button beside the A−/A+ buttons, shown while a Markdown file is open, breaks long lines at the window edge instead of scrolling sideways. The choice is remembered.
- **Tooltips**: buttons and other controls with a title or label now show a Codeome-style tooltip on hover, in place of the system one.

### Changed
- **File browser updates itself**: the local pane re-reads its folder every 2 seconds and the HPC pane every 15, so changes made by agents appear without pressing refresh.

### Fixed
- **Toasts over Google documents**: the notification that an agent has finished or has a question is no longer hidden behind a Google Doc, Sheet or Slides tab.

## 0.4.0

### Added
- **Git & GitHub accounts**: *Settings → Git & GitHub* holds GitHub accounts, on github.com or a GitHub Enterprise host over https. Add one by pasting a personal access token, or import the one the `gh` CLI is signed in with. Each token is checked with GitHub when added and whenever the section opens, then encrypted with the macOS Keychain and never shown again. Each account shows its login and a status: valid, missing scopes, invalid or could not check. Classic tokens need `repo` (and `workflow` to push workflow files); fine-grained tokens need Contents and Pull requests access.
- **Account per project**: *Git view → Account* binds a project to an account. Push, pull and fetch over https, and the pull request, release and repository actions, then use that account instead of the Mac's default `gh` login. The token is handed to Git per command, only to the account's own host, and is never written to `.git/config`, the project or the config file. A project bound to an account that has become invalid cannot push or pull until you validate it again or choose another account; local commits keep working. SSH remotes use the SSH key as before.
- **Git identity per repository**: *Git view → Account → Identity* sets this repository's `user.name` and `user.email`, stored in its `.git/config` only.
- **Forum**: a new pane in the Agent view, between *Chat* and *Jobs*, where you moderate a discussion between one Claude and one Codex seat on the same transcript. Both see every message, and the ⋯ menu of the Agent view opens it too.
  - **Hand-raising.** When you post, each seat is asked privately, with a small one-shot call that is not added to the transcript, whether it has something new to say. Seats that do raise a hand with a short reason, shown as a chip with *Allow* and *Dismiss*. Allowed seats speak one at a time. *Auto-allow* lets a number of raised hands (0 to 20, default 0, so you approve every turn) through per message without asking. Each seat can be muted.
  - **Shared document.** Attach a local `.md` (or `.txt`) file or a `.gdoc` pointer, and it becomes the subject of the discussion. Seats are read-only by default; *Edit…* on a seat asks that seat alone to edit the document for one turn, after which it is read-only again. Codex cannot edit Google Docs, so its button is disabled for a `.gdoc`.
  - **Long discussions.** Past a token threshold, older messages are folded into a rolling summary, and only recent messages go into the raise-hand checks.
  - **Usage per seat.** Each seat shows its tokens (spoken turns and checks), with turns, tokens and cost in the tooltip.
  - Forums are saved under `~/.codeome/forums/`, separate from chat history, and *Forums* lists, reopens and deletes them. A dot on the *Forum* tab marks activity you have not seen.
- **Settings → Agents → Forum**: the default auto-allow rounds, how large the discussion grows before it is summarised (1,000 to 50,000 tokens, default 6,000), and the models of the raise-hand checks (Claude: Haiku by default; Codex: its own default). Changes apply to forums opened afterwards.

- **New agent dialog**: the `+` in the chat header is now *New agent* (the `+` in the tab bar still opens a new chat). The dialog asks for a name, when to use it, the engine, the tool access and the scope.
  - **This project** writes `.claude/agents/<name>.md` in the project and adds its row to `routing.md`.
  - **General** writes Codeome's own store, `~/.codeome/agents` (or `$CODEOME_HOME/agents`). It is mirrored into the `agents/` folder of every Claude account, at start and when accounts change or are switched, without overwriting files Codeome did not write or that you edited.
  - Codex jobs fall back to the general store when a project has no agent with that name.
- **Expand scope…** in *Settings → Agents* copies a project agent to the general store and/or to other projects (connected projects are ticked). It never overwrites: a target that already has the agent is reported as *exists*.

### Changed
- Git and `gh` commands run from the Git view are limited to the forms the view uses: no custom Git options, URLs as remotes, or `gh` subcommands such as `clone`, `run` or `checkout`.
- Known limitation: hooks and local Git config in a project you open still run during push and pull, with the account's token in their environment, as with any Git client.

## 0.3.4

### Added
- **Specialist personas**: the empty agent chat lists specialists (*Analyst*, *Coder*, *Manuscript writer*) instead of only example sentences. Picking one starts the chat with that specialist's instructions in place of the default agent's; typing without picking works as before. The choice locks when the first message is sent and is shown on the chat tab next to the engine and in the chat history. The Manuscript writer always uses Claude, as the Google Docs connectors are Claude-only, so picking it selects Claude and locks the engine choice. Personas are files in `kit/personas/` that ship with the app and are not installed into projects.
- **No Claude co-author trailer**: *Settings → Agents → Commits* has a *Remove the Claude co-author trailer* option, on by default. While it is on, Claude Code sessions started by Codeome on this Mac (chats and terminals) add no `Co-Authored-By: Claude` trailer to commits and no "Generated with Claude Code" line to pull requests. It is passed to Claude with `--settings`, so your own Claude settings files are untouched, and it applies to sessions started after the change.
- **Scratchpad**: each project has a single free-form page for notes and reminders (such as what to ask an agent next), shown under the project's name and path whenever no file is open. It saves as you type. It replaces the row of shortcut buttons and the keyboard overview that used to fill that space.
- **Collapsible sidebar and editor**: dragging the separator between the sidebar and the editor past either limit folds that side into a thin band at the edge, which opens it again when clicked. Dragging back also reopens it, and so does picking a view in the left rail while the sidebar is folded away. Only one side folds at a time.
- **Chat overview**: right-clicking a chat tab shows the conversation as a time tree, with job branches, plan boxes, timestamps and token counts.

### Changed
- Codex chats in Auto mode allow command, edit and access requests without asking.
- The Analyst and Report writer roles use ggplot2 (R) and matplotlib (Python) as the default plotting libraries, and fall back to a project `.venv` when matplotlib is missing.

### Fixed
- An account chosen with *Make active* stays active: later settings saves no longer revert it.
- A Codex job that ends in a project you are not looking at now raises that project card's "task finished" marker, as a Claude subagent already did. Codex jobs are followed in every open project, not only the active one.
- *Settings → This Mac* no longer shows a stray "null" under the Claude Code and Codex versions.
- Pop-up messages in the bottom-right corner follow the dark theme instead of showing white.

## 0.3.3

### Added
- **Uncommitted-changes marker**: the *Git & GitHub* button in the left rail shows an amber dot when the project has uncommitted changes, next to the dots for agents working and replies ready. It is kept current while the view is closed, so edits made by the agents show up, and the tooltip gives the count.
- **Update check from the title bar**: clicking the version next to CODEOME looks up the latest release on GitHub right away.
- **Install Claude Code and Codex from Codeome**: when the `claude` or `codex` command is not on this Mac, adding or signing in to an account, and starting a chat, offer to install it with the vendor's own installer (`curl -fsSL https://claude.ai/install.sh | bash`, `curl -fsSL https://chatgpt.com/codex/install.sh | sh`) after asking, in a visible terminal, then carry on. *Settings → This Mac* lists both with an *Install…* button, and the start-up notice has an *Install* action.
- **Weekly update suggestions**: Codeome looks up the latest Codeome (its GitHub releases; *View release* opens the page to download it), Claude Code and Codex versions about once a week and, when yours is older, suggests updating (each way of installing is updated its own way: the vendor script, Homebrew or npm). *Settings → This Mac* shows the versions with a *Check for updates* button.

### Changed
- Agent chat messages are spaced further apart, and each agent reply is separated from its timestamp by a rule.
- **Agent kit 0.6.0**: projects with an older kit are offered the update. The team now knows what the app does for it.
  - The chat and the `hpc-operator` are told about the HPC connection Codeome keeps open and use it, instead of reporting that there is no connection. The agent chat's instructions give the exact command; the `analyst`, `report-writer` and `pipeline-engineer` hand cluster commands to the orchestrator in their notes.
  - Codex specialists can write to the folders of connected projects: Codeome tells the job runner which they are, and it passes them to Codex as writable. The orchestrator is told to name those folders in briefs.
  - Google Docs, Sheets and Slides are edited by the orchestrator or a `general-purpose` subagent. Named roles have fixed tool lists without the Google connectors, so they could not do it before.
  - Roles use the secrets saved in Settings → Secrets by variable name, never print them, and say when one is missing. Work that needs a secret, the network or the HPC goes to a Claude role, as Codex hides such variables and has no network.
  - A Codex chat says in one line when work needs a Claude chat, instead of trying.

## 0.3.2

### Added
- **GitHub Actions**: a *CI* workflow runs the tests on every push to `main` and on pull requests, and a *Build macOS app* workflow builds the unsigned `.dmg` files on every push to `main` (the *Codeome-mac* artifact) and attaches them to a GitHub release when a `v*` tag matching the version in `package.json` is pushed.

### Fixed
- A Codex that fails to start no longer crashes the app: the broken pipe on its input is now handled.

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
- **HPC name**: Settings → *HPC* → *Name* gives the cluster a name, such as the cluster's own name. The title bar and the HPC files pane show it instead of the login; hover the title bar's HPC segment to see the login.
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
