# Agent chat

Open the Agent chat with `⌘1`. It gives you agent chats per project, instead of separate Claude Code and Codex windows. Behind each chat is a headless Claude Code session acting as the orchestrator. It answers questions and makes small changes itself. For anything bigger it plans the work, checks with you, and hands it to specialists, whether Claude subagents or Codex jobs. To give the agent a team of roles, see [The team](/guide/team).

<Shot src="/screens/agent-chat.webp" alt="Agent chat with four chat tabs, a Codex debugger job and a Claude explorer job running, and a message box with a permission selector" caption="The chat sits in the middle column, with tabs for each chat, job cards under the message and the permission selector below the message box." width="1500" height="940" />

## Replies, jobs and permissions

Replies are rendered as Markdown. Tool calls appear as one-line entries you can expand. Each specialist job appears as a card with live status; open a card for the job's brief and result (rendered as Markdown), its conversation (Claude) or activity (Codex, needs kit 0.6.1), and its log.

Permission prompts, questions and the approval gates appear as buttons in the chat. The selector under the message box sets what the agent may do without asking: *Ask before changes*, *Accept edits*, *Auto* or *Plan only*.

The mode a new chat starts in, and the model, effort and engine, can be set for all projects in Settings → Agents or for one project in [Project settings](/guide/project-settings). To restrict Slurm submissions, git publishing, HPC changes or writes outside the project, set the rules in Settings → Agent policy or per project in Project settings.

<Shot bare src="/screens/detail-job-cards.webp" alt="Two running job cards: a Codex debugger job and a Claude explorer job" caption="Each job card shows the engine, the specialist, the job title, its status and how long it has run." width="520" height="158" />

### Job progress

When a specialist reports its steps, the job card gets a collapsible progress block: an overall bar with `stage N/M`, a row per stage, a done/total bar for countable work (such as files), the time elapsed against the usual duration for that stage, and an estimated time left once Codeome has seen the stage before. A stage that is running but has not reported for 120 seconds gets a stall badge. Cards without progress look as before.

The agents report the steps; Codeome does not guess them from logs. Progress is read from the job's `progress.json` rather than saved in the chat history, and shows for running, paused and held jobs and for jobs that ended within the last hour. It needs agent kit 0.7.0, so update the kit in projects that have it installed (see [Agent kit](/reference/agent-kit)). Test-suite output is not parsed yet, and background commands do not get a card of their own.

## Attachments and saved messages

The `+` to the left of the message box attaches files: they show as chips above the box and go to the agent as paths with your next message. The bolt to the right lists the messages you send often (*Commit, push and deploy* to start with); picking one sends it at once. The same menu saves what you have typed and edits the list.

## Specialist personas

An empty chat lists specialists (Analyst, Coder, Manuscript writer) with example requests. Picking one starts the chat with that specialist's instructions in place of the default agent's; typing without picking works as before. The choice locks when you send the first message and shows on the chat tab, next to the engine, and in the chat history. The Manuscript writer always uses Claude, since the Google Docs connectors are Claude-only, so picking it selects Claude and locks the engine choice.

## Several chats at once

Each chat is a tab above the conversation and runs its own session, so one can plan while another fixes a bug. `⇧⌘N` (or the `+` in the tab bar) opens a new chat; the `+` in the chat header creates a new agent, for this project or for all of them; `⇧⌘]` / `⇧⌘[` switch. Each tab shows its state: a spinner while the agent works, amber when it is waiting for you, green when a reply is ready that you haven't seen, red after an error. A badge counts the specialists that chat has running. The line under the tabs sums it up (for example *3 chats · 1 working · 1 needs you · 2 subagents · 1 Codex job*). Click *needs you* or *reply ready* to jump to that chat. Project cards and the rail icon show the same states for every project.

<Shot bare src="/screens/detail-chat-tabs.webp" alt="Chat tab bar with four chats and the summary line 4 chats, 1 working, 1 needs you, 1 reply ready, 1 subagent, 1 Codex job" caption="The line under the tabs counts chats, working, needs you, reply ready, subagents and Codex jobs." width="544" height="82" />

Right-click a chat tab to see the conversation as a time tree, with job branches, plan boxes, timestamps and token counts.

<Shot src="/screens/overview.webp" alt="A chat overview tab drawing the conversation as a tree over time with a plan box and job branches" caption="The overview draws one chat as a tree over time, with the plan in a box and a branch for each job." width="1500" height="940" />

## Saved conversations

Conversations are saved (in `~/.codeome/chats/`) and keep running while you work in another tab or project. Open tabs come back when you reopen the project. Closing a tab stops its session, and the ⋯ menu reopens the conversation later. The ⋯ menu can also move the current chat into a Claude Code terminal session.

<Shot src="/screens/chat-history.webp" alt="The Chat history popover listing four chats from today with a search box, New chat and Show full history" caption="The history button in the chat header lists saved chats with a search box; chats that are open are marked open." width="1500" height="940" />

The chat runs the first Claude command in Settings → Agents (for example `claude --model opus`), with the model chosen there.

## Token use

The meter under the message box shows how full the chat's context window is; click it for what the chat has used so far (turns, tokens, and the figure at API list prices). Past 70% (Settings → Agents) it turns amber and the chat suggests starting a new one, since every turn sends the whole conversation again. Each finished turn is also kept as one line in `~/.codeome/stats/turns.jsonl`, on this Mac only, and ⋯ → *Session statistics* sums them up by day, project, chat and by how full the context was when the turn started. Terminal sessions and Codex jobs are not counted.

<Shot src="/screens/chat-usage.webp" alt="A chat with the This chat popover showing context at 74 percent and token and cost figures, with the Session statistics tab open beside it" caption="Clicking the meter opens This chat with the context fill, turns, tokens and cost, and Statistics opens the Session statistics tab." width="1500" height="940" />

<Shot bare src="/screens/detail-chat-context.webp" alt="The This chat popover: context 74 percent, 148k of 200k tokens, 1 turn, 1.95M tokens processed, 9.1k replies, 2.41 dollars at API prices, model claude-opus-5-5, with New chat and Statistics buttons" caption="The context meter is amber at 74% and the popover suggests starting a new chat." width="385" height="298" />
