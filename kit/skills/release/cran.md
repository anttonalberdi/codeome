# CRAN

CRAN is reviewed by people, by email, with the maintainer. You prepare the package and the evidence; the maintainer submits.

## Before checking
- `DESCRIPTION`: Title in title case without a full stop; Description of more than one sentence that does not start with the package name or "This package"; `Authors@R` with exactly one `cre` whose email works, and a `cph`; a standard licence; `URL` and `BugReports`.
- Bump `Version` and add the entry to `NEWS.md`.
- Examples, tests and vignettes: no writing outside `tempdir()`, no more than two cores, no network without failing gracefully, each example a few seconds at most. `\dontrun{}` only for code that truly cannot run.
- Keep the source tarball small (aim under 5 MB). Put anything not needed for the build in `.Rbuildignore`.

## Check
1. `R CMD build .` then `R CMD check --as-cran <tarball>`, or `devtools::check(remote = TRUE, manual = TRUE)`. Aim for 0 errors, 0 warnings, 0 notes. A first submission always gets the "New submission" note.
2. `urlchecker::url_check()` and `spelling::spell_check_package()`.
3. Other platforms. These upload the package to outside services, so they need the brief's approval:
   - `devtools::check_win_devel()` and `devtools::check_mac_release()`: results are emailed to the maintainer.
   - `rhub::rhub_check()`: runs on GitHub Actions in the package's repository.
4. For an update with reverse dependencies: `revdepcheck::revdep_check()`. Breaking one requires telling its maintainer in advance.

## cran-comments.md
Write or update it (and keep it in `.Rbuildignore`):
- the test environments and R versions used;
- the check results, with a one-line explanation for every remaining note;
- reverse dependency results;
- for a resubmission, what changed in answer to each point CRAN raised.

## Submit
- `devtools::submit_cran()`, or upload the tarball at `https://cran.r-project.org/submit.html`.
- CRAN emails the maintainer a confirmation link. Nothing is submitted until it is clicked.
- Automated checks answer within hours. A new package then waits for a person, usually days, sometimes longer. Replies go to the maintainer's inbox.
- Do not submit updates more often than about once a month.

## After acceptance
- Tag `v<version>`, create the GitHub release, and move to a development version (`usethis::use_dev_version()`), if the brief says to.
- The `r-<name>` conda-forge feedstock, if one exists, is bumped by its bot.

## Needs the user
- Approval before anything is uploaded to win-builder, R-hub or CRAN.
- Submitting, clicking the confirmation link, and answering CRAN's emails. Stop at "tarball and cran-comments.md ready" unless the brief says otherwise.
