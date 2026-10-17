# Editor

Monaco (the VS Code editor core) with syntax highlighting for R, Python, shell, Quarto, R Markdown, Snakemake, YAML and more. Opens files on your Mac *and* directly on the HPC.

<Shot src="/screens/editor.png" alt="The editor showing slurm.js with syntax highlighting, the Files panel on the left and an empty terminal panel below" caption="The editor opens a file in a tab beside the Files panel, with the terminal panel underneath." width="1500" height="940" />

## Running code

`⌘↩` runs the current line or selection, RStudio-style. R code goes to the project's R console (started on demand), and with no selection it sends the whole statement under the cursor; other languages go to the active terminal. `⇧⌘↩` sources an R script into the console, or runs other files in a terminal.

## R Markdown and Quarto

R Markdown and Quarto documents are runnable: chunks are shaded and highlighted in their own language, with *Run chunk* / *Run chunks above* over each and *Knit* / *Run all chunks* at the top. `⇧⌘↩` runs the chunk under the cursor, `⌥⌘R` all chunks, `⌥⌘P` the chunks above, `⌥⌘N` the next one, `⌃⌥I` inserts a chunk and `⇧⌘K` knits.

<Shot src="/screens/rmd.png" alt="analysis.Rmd in the editor with shaded R chunks, Run chunk links above each chunk and an R console below showing summary output" caption="In an R Markdown file each chunk is shaded with Run chunk and Run chunks above over it, Knit and Run all chunks at the top, and the project's R console below." width="1500" height="940" />

## Asking the agent

Right-click → *Ask the agent about this…* puts a reference to the file and selected lines in the [Agent chat](/guide/agent-chat).
