# Projects

## Projects

Every open project is a card in the leftmost column. Each one keeps its own editor tabs, terminal and agent sessions, and HPC folder; sessions keep running while you work in another project. Cards show running agent jobs, live sessions and unsaved files. `⌘O` opens another project, `⌃⇥` / `⌃⇧⇥` switch, `⇧⌘W` closes one; drag cards to reorder, or collapse the column to monograms. *+ Group* makes a named group: drag cards onto its header (or use a card's right-click menu) to fill it, and click the header to fold the group to one line, which then shows the most pressing state of the projects inside. *Connect to projects…* in a card's right-click menu ties projects together: the agent chat of each one can then read and edit the files of the others, and the card shows a chain with how many it is connected to.

The menu in the project column also saves the open projects as a named project group, which you can later load, rename or delete. Loading a group opens its projects alongside those already open and skips folders that no longer exist. When you open a project manually and it has connected projects that are not open, a window lists them all ticked; untick any you do not want before they are opened.

<Shot src="/screens/projects-groups.webp" alt="Left column listing projects in the groups THESIS, TEACHING and SIDE PROJECTS next to the Files panel" caption="Groups fold to one line: THESIS is open with two projects, TEACHING is folded, and SIDE PROJECTS is empty and says Drag a project here." width="1500" height="940" />

<Shot bare src="/screens/detail-project-cards.webp" alt="Project cards for codeome and kit inside the THESIS group, and test outside any group" caption="Each card shows the project name and folder, a chain icon with the number of connected projects, and its running jobs." width="189" height="293" />

<Shot src="/screens/project-links.webp" alt="The Connect codeome to popover with checkboxes for kit, main, renderer and test; kit and test are ticked" caption="The Connect popover lists the other projects as checkboxes; ticking one lets the agent chats of both read and edit each other's files." width="1500" height="940" />

## Usage limits

The title bar shows the 5-hour and weekly usage of Claude and Codex for the active account; click either for every account, reset times, and to switch or add accounts.

<Shot src="/screens/usage-popover.webp" alt="Claude usage popover over the editor listing two accounts with 5-hour and weekly meters, reset times and a Make active button" caption="Clicking the Claude meter opens a popover with each account's 5-hour and weekly usage, its reset times, Make active, Add account… and Settings." width="1500" height="940" />

<Shot bare src="/screens/detail-usage-meters.webp" alt="Title-bar usage meters for Claude and Codex above the open usage popover" caption="The title-bar meters show 5-hour and weekly use per tool; in the popover the account at 93% is drawn in red." width="554" height="388" />
