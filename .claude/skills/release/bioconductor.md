# Bioconductor

For R packages that analyse biological data and build on Bioconductor classes (`SummarizedExperiment`, `GRanges`, `phyloseq`…). A package cannot be on both CRAN and Bioconductor.

## Before checking
- `Version: 0.99.0` for a new submission. Raise the last number with every push during review; that is what triggers a new build.
- `DESCRIPTION` has a `biocViews:` field with terms from the official list, and every dependency is on CRAN or Bioconductor. No `Remotes:`.
- At least one vignette (R Markdown or Quarto, `BiocStyle`) that runs real code from installation to a result.
- Unit tests, man pages with runnable examples for every exported object, and a `NEWS` file.
- Reuse existing Bioconductor classes for input and output where one fits, rather than new ones.
- Limits: `R CMD check` in under 10 minutes, source tarball under 5 MB, no single file over 5 MB in the repository history.

## Check
- Use the **devel** version of Bioconductor (`BiocManager::install(version = "devel")`), with the R version it requires. Report the versions you used; if only release was available, say so.
- `R CMD build .`, `R CMD check <tarball>`, then `BiocCheck::BiocCheck("<tarball>", "new-package" = TRUE)`.
- Clear every ERROR and WARNING. Go through the NOTEs: reviewers ask about them.

## Submit
- The package lives in a public GitHub repository whose default branch is `devel`.
- Open an issue at `Bioconductor/Contributions` with its template and the repository URL. One package per issue.
- A bot checks the issue and asks for a webhook on the repository. A reviewer is assigned, and the Single Package Builder posts a build report for each version bump.
- Answer the review by pushing fixes with a version bump, and reply in the issue.
- Accepted packages enter the devel branch, and reach users with the next Bioconductor release (April and October).

## After acceptance
- The canonical repository is `git.bioconductor.org`. Push to it and to GitHub.
- Versions follow `x.y.z`: even `y` in release, odd `y` in devel. Bioconductor bumps `y` at each release. You only raise `z`.
- Fixes for users go to both `devel` and the current `RELEASE_X_Y` branch.
- The `bioconductor-<name>` conda package on Bioconda is created and updated in bulk. No recipe to submit.

## Needs the user
- Approval to open the issue: it is public, and review takes weeks of their attention.
- The maintainer's own accounts: the bioc-devel mailing list, the support site (watching the package's tag), and the SSH key for `git.bioconductor.org`.
- Adding the webhook to the GitHub repository when the bot asks.
