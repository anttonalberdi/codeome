# Codeome: list the R libraries and their packages, for the Packages view.
# R -s -f packages.R [--args outdated]
# Lines start with @@ so whatever .Rprofile prints is skipped:
#   @@R <version>
#   @@LIB <writable 0/1> <path>
#   @@PKG <path> <name> <version> <priority> <source>
#   @@OLD <path> <name> <installed> <available>
local({
  out <- function(...) cat("@@", paste(..., sep = "\t"), "\n", sep = "")
  out("R", paste(R.version$major, R.version$minor, sep = "."))
  libs <- .libPaths()
  for (l in libs) out("LIB", as.integer(file.access(l, 2) == 0), l)
  ip <- installed.packages(lib.loc = libs, fields = c("RemoteType", "biocViews", "Repository"))
  src <- ifelse(!is.na(ip[, "RemoteType"]) & ip[, "RemoteType"] %in% c("github", "gitlab", "bitbucket", "git", "url", "local"), ip[, "RemoteType"],
    ifelse(!is.na(ip[, "biocViews"]), "bioc", ifelse(!is.na(ip[, "Repository"]), ip[, "Repository"], "")))
  pri <- ifelse(is.na(ip[, "Priority"]), "", ip[, "Priority"])
  for (i in seq_len(nrow(ip))) out("PKG", ip[i, "LibPath"], ip[i, "Package"], ip[i, "Version"], pri[i], src[i])
  if ("outdated" %in% commandArgs(TRUE)) {
    repos <- getOption("repos")
    if (is.null(repos) || identical(unname(repos["CRAN"]), "@CRAN@")) repos <- c(CRAN = "https://cloud.r-project.org")
    if (requireNamespace("BiocManager", quietly = TRUE)) repos <- tryCatch(BiocManager::repositories(), error = function(e) repos)
    old <- tryCatch(old.packages(lib.loc = libs, repos = repos), error = function(e) NULL)
    if (!is.null(old)) for (i in seq_len(nrow(old))) out("OLD", old[i, "LibPath"], old[i, "Package"], old[i, "Installed"], old[i, "ReposVer"])
  }
})
