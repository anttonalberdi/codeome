# Publishing

## Zenodo

Create drafts, edit metadata, upload files, publish and create new versions (sandbox supported).

::: tip
Link a GitHub repo in Zenodo's GitHub settings and every GitHub release from Codeome gets a DOI.
:::

## Packages

Open Packages with `⌘6`. It has stacked sections, like Files: *Python* (pip) and, in R projects, *R libraries*. Each works on the Mac or the HPC.

- Python: list, install, upgrade and remove packages; build your package and upload it to TestPyPI or PyPI (Publish).
- R: every library in `.libPaths()` (project renv, user, site, system) as its own group, with each package's version and where it came from (CRAN, Bioconductor, GitHub). Install from CRAN, Bioconductor or GitHub (`user/repo`), update, remove, or load one into the R console. *Check for updates* (⋯) marks outdated packages, and you can update them all at once. R runs in the project folder, so renv projects install into their own library.
- A project counts as an R project if it has an `.Rproj`, `DESCRIPTION`, `renv.lock`, `.Rprofile` or R / R Markdown files at the top. Right-click a section header to show or hide R libraries anywhere.

Tokens for Zenodo and PyPI are set in [Settings](/settings) and stored as described under [Secrets](/guide/secrets).
