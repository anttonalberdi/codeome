# Plots

Open the Plots view with `⌘7`. Plots from R consoles started in Codeome (on the Mac or the HPC) open in the Plots view instead of a separate window, RStudio-style. Each plot is kept with its recording, so it can be redrawn at any size afterwards.

## Canvas

*Fit to panel* draws at the panel's size and redraws when you resize it. Presets cover journal widths (89, 120 and 183 mm), a 16:9 slide, a square and A4, or you can type a width and height in in, cm, mm or px. Set the dpi and a white or transparent background. The panel shows the plot at the chosen size, so text and point sizes look as they will in the file. *Actual size* (the magnifier) shows it at print size.

## Export

Export to PNG, PDF, SVG, TIFF, JPEG or EPS at that size and dpi (raster files carry the dpi), or Copy it as a PNG. The ⋯ menu copies the matching `ggsave()` call or device code (`pdf(...)` … `dev.off()`) for your script.

## History

‹ › or the arrow keys step through plots, the thumbnails jump to one, ⌫ removes one. *Open in a tab* gives a large view with the controls beside it.

## Redrawing

Redrawing runs in a separate R process with the session's R and libraries, so the console is never interrupted. For R started another way (say, inside an interactive job), right-click its terminal tab → *Show R plots in Codeome*. Settings → R turns this off.
