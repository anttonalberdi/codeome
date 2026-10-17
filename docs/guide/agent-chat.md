# Agent chat

Open the Agent chat with `⌘1`. It gives you agent chats per project, instead of separate Claude Code and Codex windows. Behind each chat is a headless Claude Code session acting as the orchestrator. It answers questions and makes small changes itself. For anything bigger it plans the work, checks with you, and hands it to specialists, whether Claude subagents or Codex jobs. To give the agent a team of roles, see [The team](/guide/team).

## Replies, jobs and permissions

Replies are rendered as Markdown. Tool calls appear as one-line entries you can expand. Each specialist job appears as a card with live status; open a card for the job's brief and result (rendered as Markdown), its conversation (Claude) or activity (Codex, needs kit 0.6.1), and its log.

Permission prompts, questions and the approval gates appear as buttons in the chat. The selector under the message box sets what the agent may do without asking: *Ask before changes*, *Accept edits*, *Auto* or *Plan only*.

## Attachments and saved messages

The `+` to the left of the message box attaches files: they show as chips above the box and go to the agent as paths with your next message. The bolt to the right lists the messages you send often (*Commit, push and deploy* to start with); picking one sends it at once. The same menu saves what you have typed and edits the list.

## Specialist personas

An empty chat lists specialists (Analyst, Coder, Manuscript writer) with example requests. Picking one starts the chat with that specialist's instructions in place of the default agent's; typing without picking works as before. The choice locks when you send the first message and shows on the chat tab, next to the engine, and in the chat history. The Manuscript writer always uses Claude, since the Google Docs connectors are Claude-only, so picking it selects Claude and locks the engine choice.

## Several chats at once

Each chat is a tab above the conversation and runs its own session, so one can plan while another fixes a bug. `⇧⌘N` (or the `+` in the tab bar) opens a new chat; the `+` in the chat header creates a new agent, for this project or for all of them; `⇧⌘]` / `⇧⌘[` switch. Each tab shows its state: a spinner while the agent works, amber when it is waiting for you, green when a reply is ready that you haven't seen, red after an error. A badge counts the specialists that chat has running. The line under the tabs sums it up (for example *3 chats · 1 working · 1 needs you · 2 subagents · 1 Codex job*). Click *needs you* or *reply ready* to jump to that chat. Project cards and the rail icon show the same states for every project.

## Saved conversations

Conversations are saved (in `~/.codeome/chats/`) and keep running while you work in another tab or project. Open tabs come back when you reopen the project. Closing a tab stops its session, and the ⋯ menu reopens the conversation later. The ⋯ menu can also move the current chat into a Claude Code terminal session.

The chat runs the first Claude command in Settings → Agents (for example `claude --model opus`), with the model chosen there.

## Token use

The meter under the message box shows how full the chat's context window is; click it for what the chat has used so far (turns, tokens, and the figure at API list prices). Past 70% (Settings → Agents) it turns amber and the chat suggests starting a new one, since every turn sends the whole conversation again. Each finished turn is also kept as one line in `~/.codeome/stats/turns.jsonl`, on this Mac only, and ⋯ → *Session statistics* sums them up by day, project, chat and by how full the context was when the turn started. Terminal sessions and Codex jobs are not counted.
