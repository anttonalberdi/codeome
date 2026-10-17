# Forum & Ideas

## Forum

The *Forum* tab of the Agent view (next to *Chat* and *Jobs*) is a moderated discussion between a Claude seat and a Codex seat, with you as moderator.

- Post a message. Each seat is quietly asked whether it has something new to add; those that do raise a hand with a short reason, and you click *Allow* or *Dismiss*. Allowed seats reply one at a time on a shared transcript that both can see. *Auto-allow* lets a set number of hands through per message without asking (default 0, set in Settings → Agents → Forum).
- Attach a local `.md` file or a `.gdoc` to make it the subject. Seats are **read-only by default**: *Edit…* on a seat lets that seat alone edit the attached document for one turn.
- **Cost.** Every message you post triggers one small check per seat (a short one-shot call, Haiku by default for Claude), on top of the replies themselves. Past a size set in Settings, older messages are folded into a summary. Each seat shows its tokens and cost.
- Forums are saved in `~/.codeome/forums/`, apart from chat history; *Forums* in the pane header reopens or deletes them.

<Shot src="/screens/forum.webp" alt="The Forum tab with a release readiness review: messages from You, Claude and Codex, two Allow and Dismiss requests and a Post box" caption="In the Forum tab you post a message, the seats reply on a shared transcript, and raised hands appear as Allow and Dismiss buttons above the message box." width="1500" height="940" />

<Shot bare src="/screens/detail-forum-seats.webp" alt="The Claude and Codex seats with token counts 18k and 7.9k and Mute and Edit buttons" caption="Each seat shows its token count with Mute and Edit… beside it." width="454" height="73" />

::: warning Codex cannot edit Google Docs
A Codex seat cannot edit an attached Google Doc.
:::

## Ideas

A chat and a forum that are not tied to any project, for discussing a new project or an idea that fits none of the existing ones. Open it from the welcome screen or the project bar. Chats and forums are saved under `~/.codeome` (its working folder is `~/.codeome/scratch`). The agent kit is not installed there (no jobs or specialists), the Files, Git and Slurm views are hidden, and Ideas is left out of the project lists and the usage statistics.

<Shot src="/screens/ideas.webp" alt="The Ideas workspace with an empty agent chat and the text Chat and forum with no project" caption="Ideas has its own card in the project column and an empty chat and forum, with only the Agent view in the rail." width="1500" height="940" />
