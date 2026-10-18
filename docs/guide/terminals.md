# Terminals

Tabs in the bottom panel (`⌘J`): local shells, HPC shells, R consoles (on the Mac or the HPC; the command is set in Settings → R), and Claude Code / Codex sessions on the cluster. Right-click any terminal → *Send R code here* to make it the one R code goes to, e.g. R inside an interactive job. HPC agent sessions run inside `tmux`, so they keep working if the VPN drops and reattach when you reopen them.

Press `⌘F` in a terminal to search its output (including scrollback). `Enter` and `⇧Enter` jump to the next and previous match; `Esc` closes the search.

<Shot bare src="/screens/terminal-search.webp" alt="A terminal with eight lines of sample output, the word sample highlighted on every line, and a search field at the top right showing sample, the count 1/8, up and down buttons and a close button" caption="The search field at the top right counts the matches and highlights them; the current match has a border." width="978" height="312" />

Copies between the HPC and the storage from [Files](files-transfer) run in terminals named *Transfers 1*, *Transfers 2* and so on: one terminal per transfer slot, each running its copies one after another, so a long queue doesn't fill the panel with tabs.
