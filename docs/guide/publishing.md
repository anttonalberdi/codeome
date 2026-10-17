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
- Not an R project yet? Right-click the active project (in the project list or on its tag) and choose *Set up as R project…*. A dialog offers a `.Rproj` file (on), renv (`renv::init()`, on for This Mac and off for the HPC), `.gitignore` entries for `.Rproj.user`, `.Rhistory`, `.RData` and `renv/library` (on), and a starter `analysis.Rmd` (off). It works in the project folder on the Mac or the HPC, following the R selector, and never overwrites existing files: skipped ones are named in a message. renv runs in a terminal task, and the R libraries section appears afterwards.

<Shot src="/screens/packages.webp" alt="The Packages view with a Python section listing installed packages and an R libraries section filtered by ggplot" caption="Packages has a Python section and an R libraries section, each on This Mac or the HPC, with an install box and a filter." width="1500" height="940" />

Tokens for Zenodo and PyPI are set in [Settings](/settings) and stored as described under [Secrets](/guide/secrets).
