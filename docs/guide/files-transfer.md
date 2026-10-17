# Files & transfer

## Files

Files replaces FileZilla. It has three stacked sections: the Mac project folder, the HPC, and long-term storage over SFTP (such as ERDA; set it up in Settings → Storage). Click a section's header to collapse it, drag the line between sections to resize them (double-click to even them out), and right-click a header to rename it or show only that section. Drag between sections, or from Finder, to copy: Mac ↔ HPC with `rsync` (resumable, incremental, with progress), Mac ↔ storage with `sftp`, and HPC ↔ storage directly from the HPC in a terminal there, so the data doesn't pass through the Mac. Rename, delete, folder size, storage quota, "terminal here", "R console here", "Claude here".

## Transfer view

Open it with `⌘8`, the button below Files in the left rail, or *Transfer view* at the bottom of Files. It shows two file panes side by side in a tab, with the transfer queue below, FileZilla-style.

- Each pane shows this Mac, the HPC or the storage: pick the host in the pane's header (the dot shows whether it is connected). A pane remembers the folder it last showed on each host, and the ⇄ button swaps the two panes. Both panes can be on the same host, to copy between two folders on this Mac or on the HPC.
- Select one or several items (`⌘`-click, `⇧`-click, `⌘A`, or the arrow keys) and use the arrows between the panes, drag them across (onto the list or onto a folder in it), or right-click → *Copy to …*. Files dragged in from Finder or from the Files sidebar are queued too. Click a column title to sort by name, size or date.
- Every copy is a row in the **queue**: waiting, running with its progress and speed, done, failed with the reason, or cancelled. The queue runs two transfers at a time (1 to 4, your choice); *Pause* starts no new ones. A row can be cancelled, tried again or removed, and *Clear finished* tidies up. Copies started in the Files sidebar join the same queue, and the sidebar shows the ones in progress.
- A copy between the HPC and the storage runs in a terminal on the HPC, as before, and its row follows how it ends. Copying within the storage is not possible, as SFTP has no copy.
