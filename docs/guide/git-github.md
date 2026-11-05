# Git & GitHub

Status, diff, stage, commit, pull, push, history; with the GitHub CLI: publish a repo, open pull requests, create releases. Changes, history, account and GitHub are sections that collapse and resize like the ones in Files. The *Account* section binds the project to one of your GitHub accounts, so push, pull and the GitHub actions use that account's token instead of the Mac's `gh` login, and sets this repository's Git name and email.

<Shot src="/screens/git.webp" alt="The Git and GitHub view with a commit message box, Commit all changes, Pull and Push buttons, a list of changed files, history and an Account section" caption="The Git view lists the changed files with Commit all changes, Pull and Push above them, and History, Account and GitHub sections below." width="1500" height="940" />

<Shot src="/screens/git-account.webp" alt="The Git view with a project account lab-research at github.com marked valid and GitHub buttons Open on GitHub, Pull request and Release" caption="With an account bound to the project, the GitHub section offers Open on GitHub, Pull request… and Release…." width="1500" height="940" />

To add GitHub accounts, see [Settings](/settings).

## Issue inbox

Codeome can watch a project's GitHub issues. It polls them, an agent assesses each new one, and you act from the *Issues* section of the Git view. Nothing happens on GitHub unless you click for it.

**Requirements.** A GitHub account bound to the project in the *Account* section, and a token that can read issues: a classic token with `repo`, or a fine-grained token with *Issues: read*. To post replies the token also needs write access (*Issues: read and write*, or `repo`). A missing scope shows a clear error in the section instead of failing silently.

**Turn it on.** Two switches, both off by default: *Issue inbox → Enable* in Settings → Git & GitHub (see [Settings](/settings)), and the project's own switch, in the *Issues* section or in [Project settings](/guide/project-settings). Only issues opened after you enable a project are captured, so turning it on never floods you with old issues. Pull requests and issues opened by bots are skipped.

**Polling.** Codeome checks every 10 minutes (2 to 1440, set in Settings), and again when you return to the Codeome window. *Refresh* in the section checks at once.

**Cards.** Each issue is a card with its number, title, author, age, labels and a status: *new*, *seen* (shown on screen), *in progress*, *snoozed*, *done* or *dismissed*. The filters are *New*, *Open*, *Snoozed* and *Done + Dismissed*, and the section header counts the open ones. The project card shows how many are new. If an issue you dismissed, snoozed or finished is edited on GitHub, it comes back as new.

**Assessment.** Every new issue gets one automatic assessment, shown on its card and labelled *AI suggestion — unverified*:

- an outcome: *No action needed*, *Reply*, *Quick fix* or *Needs a plan*;
- a size (trivial, small, standard, large) and a short summary;
- a collapsible *Proposed plan* (fix and plan) or *Draft reply* (reply).

If the issue's title, text or labels change afterwards, the assessment is marked stale and *Re-assess* replaces it. Issues beyond the per-check limit, or when automatic assessment is off or the daily limit (30 runs) is reached, show an *Assess* button. Each assessment is one agent run, so a busy repository costs usage; the limits are in Settings.

**Actions.**

- *Start work* opens an agent chat that runs `/orchestrate` on the issue. It sizes the task, writes the plan, stops at the plan approval gate and asks before changing anything, committing or commenting. An unassessed issue offers *Start work anyway* after a confirmation. The card shows *In progress* with *Open chat*.
- *Post reply* (for *Reply* issues) shows the draft in an editable box. Edit it, press *Post reply* and confirm: the comment is posted publicly from the bound account. *Discard draft* restores the original.
- *Dismiss*, *Snooze* (1 day, 3 days, 1 week) and *Done* manage the card. *Mark done* is the main button for *No action needed*.

**Notifications.** For each batch of new issues, Codeome shows an OS notification when its window is not in front, and sends an ntfy push if ntfy push is enabled and the phone companion server is running (see [Phone companion](/guide/phone)). Both say only the count and the project folder name, for example "2 new GitHub issues in my-project", never the title or text. Switch them off with *Notify for new issues*.

### Safety

Anyone can write an issue, so its text is treated as untrusted data, never as instructions. The assessment agent runs with no tools and cannot read your files, run commands or open links; its answer is checked against a strict format and discarded if it does not fit. *Start work* hands the issue and the suggested plan to the chat as quoted data, marked as an unverified suggestion from an anonymous issue, and the chat stops for your approval before it changes anything. Replies are posted only when you confirm them. By default issues from everyone are captured; set *Authors* to *Collaborators only* in Settings to capture only the owner, members and collaborators.

