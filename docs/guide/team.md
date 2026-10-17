# The team

Install the *agent kit* into a project (from the banner in the chat) and the agent gains a team. What the install writes into the project is listed in the [agent kit reference](/reference/agent-kit).

## Roles

15 roles in four groups, chosen at install: core (planner, explorer, implementer, debugger, tester, reviewer), research computing (analyst, pipeline-engineer, hpc-operator, report-writer), web stack (backend, frontend, security-reviewer), release & docs (docs-writer, release-manager).

The release & docs group also brings playbooks for publishing to PyPI, Bioconda, conda-forge, CRAN and Bioconductor. The release-manager reads the one a task names, prepares and checks the package, and stops at the steps only you can do (a CRAN confirmation email, a public pull request).

<Shot src="/screens/personas.png" alt="An empty chat offering the specialists Analyst, Coder and Manuscript writer and three example requests" caption="An empty chat lists the specialists with a line about each, and the Manuscript writer is marked Claude." width="1500" height="940" />

## Routing and the pipeline

Jobs are routed by type. Well-specified implementation and debugging go to Codex; planning, exploration, docs and anything that needs the network or the HPC go to Claude. Reviews run on whichever engine did *not* write the change.

The agent picks the level of each message itself. Larger tasks run the pipeline: size → plan → **you approve** → specialists implement, the orchestrator verifies each result → cross-review → **you approve** → commit. You can still type `/orchestrate <task>`, `/delegate` (one job) or `/cross-review` to choose yourself.

Codex jobs run in the background; the chat wakes up when one finishes. The chat's *Jobs* tab lists every job, Codex runs and Claude subagents alike.

<Shot src="/screens/settings-skills.png" alt="Settings Agents page listing roles with AI, model and effort dropdowns and the project skills cross-review, delegate, orchestrate and release" caption="In Settings → Agents each role has an AI, a model and an effort selector, Edit .md and Expand scope…, and the skills of the project are listed below." width="1500" height="940" />

<Shot src="/screens/settings-agents.png" alt="Settings Agents page with the orchestrator model, effort, Codex chat model, suggested replies and the new chat threshold of 70 percent" caption="The top of Settings → Agents sets the orchestrator's model and effort, the Codex chat model, and the percentage at which a chat suggests starting a new one." width="1500" height="940" />

## Accounts and limits

Codex jobs run on the active Codex account while it has headroom, and otherwise on the account with the most. New chats do the same with Claude accounts (pick one under the message box before the first message; afterwards, click the account's email there to move the conversation to another account). Once an account passes the stop threshold (90% of either window by default), Codeome holds new jobs back. A Codex job exits with code 75 and a Claude subagent call is refused, and the orchestrator re-routes the work or pauses and tells you. *Resume plan on …* (in the chat's usage notice) starts a new chat on another account that picks up the plan where the last one stopped.
