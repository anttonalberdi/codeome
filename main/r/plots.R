# Codeome plots. Sourced into an R console started from Codeome.
# Plots are drawn on an off-screen device. Each finished or changed page is
# saved as a recorded plot (<id>.rds, for re-rendering at any size or format)
# and a PNG snapshot (<id>.png), and Codeome is told through an escape sequence
# in the console output (OSC 7337), which the terminal hides.
local({
  if ("tools:codeome" %in% search()) detach("tools:codeome")
  e <- attach(NULL, name = "tools:codeome")
  root <- file.path(path.expand("~"), ".cache", "codeome", "plots")
  e$dir <- file.path(root, paste0(format(Sys.time(), "%Y%m%d-%H%M%S"), "-", Sys.getpid()))
  dir.create(e$dir, recursive = TRUE, showWarnings = FALSE)
  # Sessions older than a week are cleared out.
  old <- list.dirs(root, recursive = FALSE)
  old <- old[difftime(Sys.time(), file.mtime(old), units = "days") > 7]
  unlink(old, recursive = TRUE)
  # What the out-of-band renderer needs to replay these plots: this R, these libraries.
  writeLines(c(file.path(R.home("bin"), "Rscript"), .libPaths()), file.path(e$dir, "session"))
  e$n <- 0L; e$id <- NULL; e$fresh <- TRUE; e$sig <- NULL; e$dev <- 0L

  osc <- function(...) { cat("\033]7337;", paste(..., sep = ";"), "\a", sep = ""); flush(stdout()) }

  # The canvas Codeome asks for: width and height in inches, resolution, background.
  canvas <- function() {
    v <- tryCatch(strsplit(readLines(file.path(root, "canvas"), n = 1L, warn = FALSE), " ")[[1]], error = function(err) character())
    num <- suppressWarnings(as.numeric(v[1:3]))
    list(w = if (is.finite(num[1]) && num[1] > 0) num[1] else 7, h = if (is.finite(num[2]) && num[2] > 0) num[2] else 5,
         res = if (is.finite(num[3]) && num[3] > 0) num[3] else 96, bg = if (length(v) >= 4 && nzchar(v[4])) v[4] else "white")
  }

  e$device <- function(...) {
    cv <- canvas()
    grDevices::pdf(NULL, width = cv$w, height = cv$h)
    grDevices::dev.control(displaylist = "enable")
    e$dev <- grDevices::dev.cur()
    e$fresh <- TRUE
    invisible()
  }

  # Save the current page if it has anything new; a fresh page gets a new id.
  save_page <- function() {
    if (e$dev < 2L || grDevices::dev.cur() != e$dev) return(invisible())
    rec <- tryCatch(grDevices::recordPlot(), error = function(err) NULL)
    if (is.null(rec) || !length(rec[[1]])) return(invisible())
    sig <- length(rec[[1]])
    if (!e$fresh && identical(sig, e$sig)) return(invisible())
    replace <- !e$fresh && !is.null(e$id)
    if (!replace) { e$n <- e$n + 1L; e$id <- e$n }
    e$fresh <- FALSE; e$sig <- sig
    base <- file.path(e$dir, e$id)
    saveRDS(rec, paste0(base, ".rds"))
    cv <- canvas()
    ok <- tryCatch({
      grDevices::png(paste0(base, ".png"), width = cv$w, height = cv$h, units = "in", res = cv$res, bg = cv$bg)
      d <- grDevices::dev.cur()
      drawn <- tryCatch({ suppressWarnings(grDevices::replayPlot(rec)); TRUE }, error = function(err) FALSE)
      grDevices::dev.off(d)
      drawn
    }, error = function(err) FALSE)
    if (grDevices::dev.cur() != e$dev && e$dev %in% grDevices::dev.list()) grDevices::dev.set(e$dev)
    osc("plot", e$id, as.integer(replace), cv$w, cv$h, cv$res, cv$bg, as.integer(ok), e$dir)
    invisible()
  }
  # A page about to be replaced is finished: save it before it goes.
  before_page <- function(...) {
    if (e$dev >= 2L && grDevices::dev.cur() == e$dev && isTRUE(tryCatch(graphics::par("page"), error = function(err) TRUE))) {
      save_page(); e$fresh <- TRUE
    }
  }
  before_grid <- function(...) {
    if (e$dev >= 2L && grDevices::dev.cur() == e$dev) { save_page(); e$fresh <- TRUE }
  }

  options(device = e$device)
  # Other hooks stay; ours from an earlier source() are swapped for these.
  attr(before_page, "codeome") <- attr(before_grid, "codeome") <- TRUE
  for (hk in c("before.plot.new", "before.grid.newpage")) {
    keep <- Filter(function(f) is.null(attr(f, "codeome")), getHook(hk))
    setHook(hk, NULL, "replace")
    for (f in c(keep, if (hk == "before.plot.new") before_page else before_grid)) setHook(hk, f, "append")
  }
  if ("codeome-plots" %in% getTaskCallbackNames()) removeTaskCallback("codeome-plots")
  addTaskCallback(function(...) { tryCatch(save_page(), error = function(err) NULL); TRUE }, name = "codeome-plots")
  osc("hello", 1L, e$dir)
})
