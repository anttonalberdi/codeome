# Codeome plots: re-render a recorded plot at another size or in another format.
# Rscript --vanilla render.R <session dir> <id> <format> <width in> <height in> <res> <bg> <out>
a <- commandArgs(trailingOnly = TRUE)
dir <- a[1]; id <- a[2]; fmt <- tolower(a[3])
w <- as.numeric(a[4]); h <- as.numeric(a[5]); res <- as.numeric(a[6]); bg <- a[7]; out <- a[8]
# The libraries of the session that drew the plot, so its packages (ggplot2, grid, ...) load.
s <- readLines(file.path(dir, "session"), warn = FALSE)
.libPaths(s[-1][dir.exists(s[-1])])
rec <- readRDS(file.path(dir, paste0(id, ".rds")))
# Cairo writes the resolution into raster files (Quartz always says 72 dpi).
type <- if (capabilities("cairo")) "cairo" else getOption("bitmapType")
open <- switch(fmt,
  png = function() grDevices::png(out, width = w, height = h, units = "in", res = res, bg = bg, type = type),
  jpeg = , jpg = function() grDevices::jpeg(out, width = w, height = h, units = "in", res = res, quality = 95, bg = if (bg == "transparent") "white" else bg, type = type),
  tiff = , tif = function() grDevices::tiff(out, width = w, height = h, units = "in", res = res, compression = "lzw", bg = bg, type = type),
  pdf = function() if (capabilities("cairo")) grDevices::cairo_pdf(out, width = w, height = h, bg = bg) else grDevices::pdf(out, width = w, height = h, bg = bg, useDingbats = FALSE),
  svg = function() grDevices::svg(out, width = w, height = h, bg = bg),
  eps = function() grDevices::postscript(out, width = w, height = h, horizontal = FALSE, onefile = FALSE, paper = "special", bg = bg),
  stop("Unknown format: ", fmt))
open()
tryCatch(grDevices::replayPlot(rec, reloadPkgs = TRUE), error = function(e) grDevices::replayPlot(rec))
invisible(grDevices::dev.off())
if (!file.exists(out)) stop("Nothing was written to ", out)
cat("ok\n")
