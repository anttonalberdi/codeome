# Project settings

Open Project settings with `⌘9`, the last item in the left rail. It sets rules and chat defaults for the agents in the open project: whether they may submit Slurm jobs, publish with git, change things on the HPC or write outside the project, whether they must plan first, and which models, effort, permission mode and engine new chats start with. Each choice is saved as soon as you click it.

## App defaults and project overrides

Most of these settings exist at two levels. **Settings → Agent policy** sets the five switches below as defaults for all projects. **Settings → Agents** sets the Claude and Codex model and effort, and also a *Default permission mode* (*As last used*, *Default*, *Accept edits*, *Auto* or *Plan*) and a *Default engine* (Claude or Codex). Project settings can override any of them for the open project.

The rule is the same everywhere: the project value, else the app default, else the built-in default. A row you have not touched in a project inherits, so later changes to the app default reach it. Picking a value in a project always stores it, even when it equals the built-in default, so that project stops following the app default.

In the Project settings view:

- An inherited row shows *App default: X* under its control.
- An overridden row is marked *overridden* and has a *Use app default* button that removes just that override.
- *Reset to app defaults* at the bottom removes every override in the project, both rules and agent defaults.

The rules are stored per project in Codeome's own config, keyed by the project folder, and the app defaults are stored in the same config. Neither is written into the repository or committed, so they stay on this Mac and are not shared with collaborators.

## Agent defaults

The *Agent defaults* card overrides, for this project only, the Claude model and effort, the Codex model and effort, the default permission mode and the default engine. Leave a row on *Use app default* to inherit it. They apply to chats started from then on; chats already open keep their model.

*Use app default* is the only way to leave a row empty, so a project cannot pin an "empty" choice (*Claude Code default* for the model, *As last used* for the mode) when the app default is something else. Pick the concrete value you want instead.

A choice made in a chat itself still wins. If you pick a permission mode in the selector, or start a chat on a particular engine, that is used instead of the default.

## The switches

These are the five switches in *Agent policy*, in Settings and in each project.

| Switch | Choices (built-in default first) | What it does |
| --- | --- | --- |
| Slurm job submission | *Ask*, *Allow (best effort)*, *Never* | Agents running `sbatch`, `srun` or `salloc`, locally or over SSH. |
| Git publishing | *Ask*, *Never* | Agents running `git commit`, `git push` or `git tag`. |
| HPC access | *Full*, *Read-only* (advisory) | Read-only denies remote commands that change things: `rm`, `mv`, `cp`, write redirects, `scancel`, `sbatch`, `srun` and `salloc`. |
| Writes outside project | *Ask*, *Never* | Agent file edits (Write, Edit, notebook edits) outside the project folder. |
| Require a plan | *Off*, *On* (advisory) | Asks the agent to present a plan before changing files. |

*Ask* leaves things as they were: the agent follows the permission selector in the chat. *Never* denies the action, and the agent is told to prepare the work and tell you the exact command instead.

*Allow* for Slurm pre-approves submissions in Codeome, so you are not asked each time, and tells the agent that the project owner has authorised it. Claude's own safety checks may still refuse to submit. If that happens, submit the job yourself.

Switches marked *advisory* are weaker. *Require a plan* only adds a line to the agent's instructions. *HPC access* adds the same kind of instruction and also denies the commands listed above, but only the ones Codeome recognises.

## HPC folders

The *HPC folders* card lists the cluster folders that belong to this project. The Slurm view's *This project* switch keeps jobs that ran inside any of them (see [Slurm](/guide/slurm)). Type an absolute or `~` path and add it, remove a folder with *Remove*, or click *Use current HPC folder* to add the one open in the HPC Files tab. With none saved, the current HPC folder is used instead. Like the rules, the list is stored per project in Codeome's config on this Mac, not in the repository.

## When changes take effect

- Permission checks (the *Never* denials and the Slurm *Allow* pre-approval) apply to chats that are already running, from their next request.
- The rule text given to the agent, and the matching deny and allow rules passed to the Claude CLI, are fixed when a chat starts. They apply to new chats only.

## Limits

Matching is heuristic and is not a security boundary. Codeome looks at the command the agent runs, including commands after `ssh`, in `bash -c` strings, in `$(...)` and in here-documents. It does not look inside scripts: a script that itself calls `sbatch` is not caught. Treat the switches as guard rails against an agent doing something you did not intend, not as protection against one that is trying to get round them.

Codeome checks a command when the agent asks permission to run it. In a chat running in a mode that never asks (Claude's bypass-permissions mode, or a Codex session whose sandbox never escalates), only the deny rules passed to the agent at start apply, and they match fewer spellings. A *Never* setting is therefore most reliable in the default, accept-edits and auto modes. The deny rules also stop `git tag` in any form, including `git tag -l`, in Claude chats while Git publishing is *Never*.

Jobs that agents start in Codex have no network or SSH access, so the Slurm switch matters mainly for Claude chats and for roles that run on Claude. See [Agent chat](/guide/agent-chat) and [The team](/guide/team).
