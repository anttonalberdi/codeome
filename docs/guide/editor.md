# Editor

Monaco (the VS Code editor core) with syntax highlighting for R, Python, shell, Quarto, R Markdown, Snakemake, YAML and more. Opens files on your Mac *and* directly on the HPC.

## Running code

`⌘↩` runs the current line or selection, RStudio-style. R code goes to the project's R console (started on demand), and with no selection it sends the whole statement under the cursor; other languages go to the active terminal. `⇧⌘↩` sources an R script into the console, or runs other files in a terminal.

## R Markdown and Quarto

R Markdown and Quarto documents are runnable: chunks are shaded and highlighted in their own language, with *Run chunk* / *Run chunks above* over each and *Knit* / *Run all chunks* at the top. `⇧⌘↩` runs the chunk under the cursor, `⌥⌘R` all chunks, `⌥⌘P` the chunks above, `⌥⌘N` the next one, `⌃⌥I` inserts a chunk and `⇧⌘K` knits.

## Asking the agent

Right-click → *Ask the agent about this…* puts a reference to the file and selected lines in the [Agent chat](/guide/agent-chat).
