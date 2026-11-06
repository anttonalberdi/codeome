# Agent chat

Open the Agent chat with `⌘1`. It gives you agent chats per project, instead of separate Claude Code and Codex windows. Behind each chat is a headless Claude Code session acting as the orchestrator. It answers questions and makes small changes itself. For anything bigger it plans the work, checks with you, and hands it to specialists, whether Claude subagents or Codex jobs. To give the agent a team of roles, see [The team](/guide/team).

<Shot src="/screens/agent-chat.webp" alt="Agent chat with four chat tabs, each with its 4-letter code, a Codex debugger job and a Claude explorer job running, and a message box with a permission selector" caption="The chat sits in the middle column, with tabs for each chat, job cards under the message and the permission selector below the message box." width="1500" height="940" />

## Replies, jobs and permissions

Replies are rendered as Markdown. Tool calls appear as one-line entries you can expand. Each specialist job appears as a card with live status; open a card for the job's brief and result (rendered as Markdown), its conversation (Claude) or activity (Codex, needs kit 0.6.1), and its log.

Permission prompts, questions and the approval gates appear as buttons in the chat. The selector under the message box sets what the agent may do without asking: *Ask before changes*, *Accept edits*, *Auto* or *Plan only*.

The mode a new chat starts in, and the model, effort and engine, can be set for all projects in Settings → Agents or for one project in [Project settings](/guide/project-settings). To restrict Slurm submissions, git publishing, HPC changes or writes outside the project, set the rules in Settings → Agent policy or per project in Project settings.

<Shot bare src="/screens/detail-job-cards.webp" alt="Two running job cards: a Codex debugger job and a Claude explorer job" caption="Each job card shows the engine, the specialist, the job title, its status and how long it has run." width="520" height="158" />

### Job progress

When a specialist reports its steps, the job card gets a collapsible progress block: an overall bar with `stage N/M`, a row per stage, a done/total bar for countable work (such as files), the time elapsed against the usual duration for that stage, and an estimated time left once Codeome has seen the stage before. A stage that is running but has not reported for 120 seconds gets a stall badge. Cards without progress look as before.

The agents report the steps; Codeome does not guess them from logs. Progress is read from the job's `progress.json` rather than saved in the chat history, and shows for running, paused and held jobs and for jobs that ended within the last hour. It needs agent kit 0.7.0, so update the kit in projects that have it installed (see [Agent kit](/reference/agent-kit)). Background commands get a card only through the log watcher below.

### Test and build progress

For a long test run or build, the agent can start `codeome-agent watch` in the background. It tails the log and parses Vitest, pytest, `tsc -b`, Snakemake or a custom pattern. The chat then shows a card of its own, but only for a Bash or Monitor call that contains `codeome-agent watch ... --task <key>`; other background commands get no card. The card has the same block as a job card: a bar, the time left estimated from past runs (see [Expected durations](#expected-durations)), and a stall badge after 120 seconds without an update. The progress file decides the outcome, so a run with failed tests ends the card as failed even though the command itself exits 0. A finished card stays in the chat history as its last snapshot.

The same card follows a Snakemake run (steps, local or Slurm executor) and, on the HPC, Slurm jobs and arrays or a Snakemake log. The HPC forms go through the ssh connection Codeome already has open, so they need a connected HPC (Settings > HPC) and are for Claude chats and the Claude `hpc-operator`; Codex chats use only local logs. Nothing is installed on the HPC.

It needs agent kit 0.9.0 (0.8.0 for the local Vitest, pytest and tsc parsers); projects with an older kit see it as outdated. The parsers and options are in [Agent kit](/reference/agent-kit#watching-a-log).

### Expected durations

Progress cards and specialist job cards show how long things usually take, but only from what Codeome has recorded in the project, never from a guess. On a progress card, a waiting stage reads `expected ~2m (5 runs)` (`1 run` for a single earlier run); a running stage reads `elapsed 1m 5s / ~4m`; a stage with a known total keeps its `~Z left`; a done stage shows its actual time. A waiting stage with nothing recorded says `no estimate yet`. If the agent supplied its own figure, the card shows `expected ~3m (agent estimate)` until real history exists, and then history replaces it. A queued or running Codex or Claude job card shows `usually ~9m (10 runs)`, the median of the last 10 successful jobs with the same role and engine. The range (for example 5m-9m) is in the tooltip, and only with 3 or more runs.

Agents are told to run `codeome-agent estimate` before a long run and quote it, and not to invent a duration. In the orchestrator's plan approval step, the task table has an `Est.` column and a total, with `no history` where there is none. Only run time is estimated, so the queue wait of a Slurm job is not; the first run of anything has no estimate, and different suites need different stage ids. How the history is kept is in [Agent kit](/reference/agent-kit#expected-durations).

## Attachments and saved messages

The `+` to the left of the message box attaches files: they show as chips above the box and go to the agent as paths with your next message. The bolt to the right lists the messages you send often (*Commit, push and deploy* to start with); picking one sends it at once. The same menu saves what you have typed and edits the list.

## Specialist personas

An empty chat lists specialists (Analyst, Coder, Manuscript writer) with example requests. Picking one starts the chat with that specialist's instructions in place of the default agent's; typing without picking works as before. The choice locks when you send the first message and shows on the chat tab, next to the engine, and in the chat history. The Manuscript writer always uses Claude, since the Google Docs connectors are Claude-only, so picking it selects Claude and locks the engine choice.

## Several chats at once

Each chat is a tab above the conversation and runs its own session, so one can plan while another fixes a bug. `⇧⌘N` (or the `+` in the tab bar) opens a new chat; the `+` in the chat header creates a new agent, for this project or for all of them; `⇧⌘]` / `⇧⌘[` switch. Each tab shows its state: a spinner while the agent works, amber when it is waiting for you, green when a reply is ready that you haven't seen, red after an error. A badge counts the specialists that chat has running. The line under the tabs sums it up (for example *3 chats · 1 working · 1 needs you · 2 subagents · 1 Codex job*). Click *needs you* or *reply ready* to jump to that chat. Project cards and the rail icon show the same states for every project.

<Shot bare src="/screens/detail-chat-tabs.webp" alt="Chat tab bar with four chats, each showing its 4-letter code, and the summary line 4 chats, 1 working, 1 needs you, 1 reply ready, 1 subagent, 1 Codex job" caption="The line under the tabs counts chats, working, needs you, reply ready, subagents and Codex jobs." width="544" height="82" />

Every chat has a 4-letter code, shown in its tab between the status dot and the name (on inactive tabs it is hidden when more than five tabs are open) and in the tab tooltip. The code uses consonants only, so it never spells a word, and it is unique within the project and saved with the chat. Chats saved before codes existed get one when loaded; Forum seats have none. Right-click a tab and choose *Copy code XXXX* to copy it.

To point one chat at another, give its code: "see what KFBT is doing". The agent looks the chat up with `codeome-agent sessions KFBT` and reads its status, note, running jobs and files. Each agent is told its own code when it starts, so chats started before the update need a restart to know theirs.

Right-click a chat tab and choose *Overview* to see the conversation as a time tree, with job branches, plan boxes, timestamps and token counts.

<Shot src="/screens/overview.webp" alt="A chat overview tab drawing the conversation as a tree over time with a plan box and job branches" caption="The overview draws one chat as a tree over time, with the plan in a box and a branch for each job." width="1500" height="940" />

### Two chats editing the same file

Every live chat records the files it edits in `.codeome/touched/` (git-ignored); the record is deleted when the chat closes. If a Claude chat is about to edit a file that another live chat edited in the last 30 minutes, it asks you to approve the edit and names the other chat, with its code and note. It asks once per file. The chat then shows a yellow notice (`Also edited by CODE chat-title (engine): path`, followed by the other chat's note when it has one), the other chat's tab gets a badge with a tooltip, and the line under the tabs adds *N collisions*, all for 30 minutes.

<Shot bare src="/screens/detail-chat-collision.webp" alt="Two chat tabs with 4-letter codes, one with a collision badge, and the summary line under the tabs ending in 2 collisions" caption="The other chat's tab carries a badge, and the line under the tabs counts the collisions." />

<Shot bare src="/screens/detail-chat-notice.webp" alt="Yellow notice: Also edited by BCDF Update parser (Claude): renderer/js/chat.js, note: Parser edits need review." caption="The notice names the other chat by code and title, the file and, when it left one, its note." />

Codex chats get no approval prompt: their edits are recorded, they are warned through the prompt, and they can run `codeome-agent touched` themselves.

To change how Claude reacts, set `CODEOME_COLLISIONS` in the environment Codeome starts from: `off`, `warn` (tell the agent, no prompt), `ask` (default) or `deny` (refuse the edit). There is no setting for it in the app yet.

This is awareness, not locking: the check and the edit are not one step, and edits made through Bash (`sed`, formatters, `git checkout`) are not seen. The approval prompt needs the project's agent kit at 0.9.2, and codes and notes in it need 0.9.3; the banner offers the update.

### Messages between chats

An agent can ask to message another live chat by its code, broadcast to all of them, open a new chat, or hand over a task with a written brief. Nothing is sent until you approve it: the request appears as an *Awaiting your approval* card in the sender's chat with Approve, Edit and Decline (a broadcast lists the recipients to tick; a new chat or handoff shows what will be started). Approval is bound to exactly what the card shows, and cards expire after 1 hour.

The recipient chat gets the text framed as an untrusted message from another agent, plus an *incoming message* card with an untrusted badge, receipts (delivered, read) and a Reply button; a reply you write needs no approval. A handoff adds a card with *Start task* and *Dismiss*, and the agent sees nothing until you click Start. A new chat opens in the same project with the default permission settings, not the sender's. When two chats edit the same file, Codeome itself tells both with a *Codeome notice* card.

Limits: 6 requests a minute, 5 pending per chat, 3 broadcasts and 3 new chats an hour. This needs the project's agent kit at 0.9.4 (the banner offers the update). It guards this channel only; agents can still influence each other through shared files. See [the agent kit](/reference/agent-kit#messaging-other-chats).

## Notifications

Codeome can raise a macOS notification when a chat needs you while you are elsewhere. There are four events, each with its own switch: *Agent finished or stopped with an error*, *Agent needs your input (permission or question)*, *Approval needed for a message between chats* and *New message from another chat*. A Stop you press yourself does not notify, and neither does restoring a chat or reloading old cards. Receipts and Codeome's own conflict notices do not notify either.

The text is only the project folder name and the kind of event, for example "my-project: approval needed", never chat text. The first notification for a chat is immediate; a burst within the interval is merged into one "<folder>: new activity". Clicking a notification brings Codeome to the front and opens that chat.

By default notifications are on for all four events, only when Codeome is not the front window, at most one per chat every 30 seconds (5 to 600), with sound, and with quiet hours off. Quiet hours default to 22:00 to 08:00, may cross midnight, and suppress notifications entirely inside the window. Set these defaults in Settings → Notifications; the Notifications card in [Project settings](/guide/project-settings#notifications) overrides each of them per project. *Send test notification* checks the setup and ignores quiet hours.

These are separate from the issue-inbox switch (Settings → Git & GitHub, *Notify for new issues*) and from [phone push](/guide/phone#ntfy-notifications). Allow Codeome under System Settings → Notifications; macOS Focus modes silence them. When Codeome runs from source (`npm start`) notifications appear under the name "Electron", so check the look on the packaged app. The test button says when notifications are unsupported.

## Saved conversations

Conversations are saved (in `~/.codeome/chats/`) and keep running while you work in another tab or project. Open tabs come back when you reopen the project. Closing a tab stops its session, and the ⋯ menu reopens the conversation later. The ⋯ menu can also move the current chat into a Claude Code terminal session.

<Shot src="/screens/chat-history.webp" alt="The Chat history popover listing four chats from today with a search box, New chat and Show full history" caption="The history button in the chat header lists saved chats with a search box; chats that are open are marked open." width="1500" height="940" />

The chat runs the first Claude command in Settings → Agents (for example `claude --model opus`), with the model chosen there.

## Token use

The meter under the message box shows how full the chat's context window is; click it for what the chat has used so far (turns, tokens, and the figure at API list prices). Past 70% (Settings → Agents) it turns amber and the chat suggests starting a new one, since every turn sends the whole conversation again. Each finished turn is also kept as one line in `~/.codeome/stats/turns.jsonl`, on this Mac only, and ⋯ → *Session statistics* sums them up by day, project, chat and by how full the context was when the turn started. Terminal sessions and Codex jobs are not counted.

<Shot src="/screens/chat-usage.webp" alt="A chat with the This chat popover showing context at 74 percent and token and cost figures, with the Session statistics tab open beside it" caption="Clicking the meter opens This chat with the context fill, turns, tokens and cost, and Statistics opens the Session statistics tab." width="1500" height="940" />

<Shot bare src="/screens/detail-chat-context.webp" alt="The This chat popover: context 74 percent, 148k of 200k tokens, 1 turn, 1.95M tokens processed, 9.1k replies, 2.41 dollars at API prices, model claude-opus-5-5, with New chat and Statistics buttons" caption="The context meter is amber at 74% and the popover suggests starting a new chat." width="385" height="298" />
