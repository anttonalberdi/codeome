---
name: figures
description: How to turn R or Python figures into publication-ready ones with Inkscape's command line — SVG export, multi-panel composition, journal-size PDF/PNG/TIFF export, and the pre-submission checklist. Read it before briefing or doing figure work.
user-invocable: false
---

# Publication figures with Inkscape

Inkscape is an installed desktop app with a headless command line. **Before anything else**, read what Codeome found:

```bash
cat "${CODEOME_HOME:-$HOME/.codeome}/inkscape.json"     # {"path": "...", "version": "...", "checkedAt": "..."}
```

- `path` is the binary to use: it is `INK` below, and it honours the location the user set in Settings → Figures. Use it instead of guessing; on macOS `inkscape` is usually not on the PATH.
- If `path` is empty, or the file is missing and `inkscape --version` fails, **stop**. Report under Status that Inkscape is not installed and that the user can install it from Settings → Figures (Install…) or `brew install --cask inkscape`. Do not work around it, and do not draw the figure some other way unless the brief says so.
- Panels drawn by R or Python and the SVG composition (`compose.py`) do not need Inkscape; only the export and the preview do.

## Workflow

1. **Draw** in R or Python as vector, at the final physical size, with the final font and font size (journals want 5-7 pt text):
   ```r
   library(svglite)
   ggsave("figures/raw/fig1a.svg", p, width = 85, height = 70, units = "mm", device = svglite)
   ```
   Python: `fig.savefig("figures/raw/fig1a.svg")` with `matplotlib.rcParams["svg.fonttype"] = "none"` so text stays text. For a plot with very many points, rasterise only the points layer (`ggrastr::rasterise()`, `rasterized=True`) and keep axes and text as vectors.
2. **Compose** panels into one figure (inlined, vector). Create the folders first (`mkdir -p figures/src figures/final`):
   ```bash
   python3 -I .claude/skills/figures/compose.py figures/src/fig1.svg --width 180 --cols 2 figures/raw/fig1a.svg figures/raw/fig1b.svg
   ```
   Widths are in mm; panel letters a, b, c… are added automatically (`--labels none` to disable, `--label-size` in pt). Each panel is rescaled to its column width, and the script prints the scale factors: draw panels at the width they will occupy (here 87.5 mm for 180 mm wide, 2 columns and a 5 mm gap) so the factor is about 1 and text keeps its size; otherwise text sizes shift by that factor. Never link panels with `<image href="panel.svg">`: Inkscape rasterises them when exporting to PDF (measured: a 322×265 px bitmap).
3. **Touch up** by hand only if needed. Open `figures/src/fig1.svg` in Inkscape (`open -a Inkscape <file>` on macOS) and tell the user what to change. Re-running R and `compose.py` regenerates the figure, so manual edits belong in a copy named `fig1.edited.svg`, not in the generated file.
4. **Export**:
   ```bash
   # vector PDF, text converted to outlines (no font problems at the journal)
   $INK figures/src/fig1.svg --export-type=pdf --export-text-to-path --export-filename=figures/final/fig1.pdf
   # raster at a journal DPI, white background
   $INK figures/src/fig1.svg --export-type=png --export-dpi=600 --export-background=white --export-filename=figures/final/fig1.png
   # PNG comes out RGBA; for a journal that wants no alpha channel: magick figures/final/fig1.png -background white -alpha remove -alpha off figures/final/fig1.png
   # plain SVG with outlined text
   $INK figures/src/fig1.svg --export-type=svg --export-plain-svg --export-text-to-path --export-filename=figures/final/fig1.svg
   ```
   Other targets: `--export-type=eps`, `--export-type=emf`. TIFF: export a PNG, then convert it (`magick`, or R `magick`/`tiff`), and say which tool was used.
5. **Look at it.** Export a PNG at 100–150 dpi, open it with Read, and check it against the list below.

## Handy commands
- Size of a file in px (96 per inch): `$INK file.pdf --query-width --query-height`; 85 mm = 321.26 px. Query the exported PDF or PNG, not a composed SVG: on nested `<svg>` panels the query returns wrong numbers (measured 910×750 px for a 180×72 mm figure). The composed SVG's size is its root `width`/`height` attributes, which `compose.py` prints. Inkscape prints harmless warnings when it opens a PDF.
- Scripted edits: `$INK file.svg --actions="select-all;transform-scale:0.5;export-type:png;export-dpi:300;export-filename:out.png;export-do"`. Quote the whole `--actions` string; list the available actions with `$INK --action-list`.
- Exports take about a second. Run them as often as you need.

## Journal sizes (check the journal's own guide: these are common values)
| Target | Width | Notes |
|---|---|---|
| Single column | 85–90 mm | |
| 1.5 columns | 114–140 mm | |
| Double column | 174–183 mm | |
| Text size | 5–7 pt | no smaller than 5 pt after scaling |
| Line art | 600–1200 dpi | combination (line + shading) 600 dpi, photographs 300 dpi |

Nature, Science, Cell and PLOS differ in details: when the user names a journal, fetch its current figure guidelines rather than relying on this table, and record the numbers used in the report.

## Checklist before saying a figure is ready
- Width and height in mm match the target: query the exported PDF (px ÷ 96 × 25.4), or PNG pixels ÷ dpi × 25.4.
- Text is outlined in a PDF exported with `--export-text-to-path`: `grep -a -c "/Type /Font" out.pdf` (on the qpdf output below) is 0.
- A vector export contains no bitmap of a panel: `qpdf --qdf --object-streams=disable in.pdf out.pdf; grep -a -c "/Subtype /Image" out.pdf` is 0 for line art (rasterised point layers are fine, and then there is exactly that count).
- Text is readable at final size, in one font family throughout, with units on every axis.
- Colours are distinguishable in greyscale and for colour-blind readers (avoid red/green pairs; prefer viridis or Okabe-Ito).
- Panel letters are present, consistent and not overlapping data.
- The data shown are those of the raw figure: same points, same axis limits.
- **CMYK:** Inkscape does not write CMYK or ICC profiles. If the journal requires CMYK, say so and name Ghostscript or the journal's own converter as the last step; do not claim the PDF is CMYK.

## Pitfalls
- Fonts: a font missing from the machine is silently replaced, which reflows text. Use `--export-text-to-path` for finals, and check the font used in the raw SVG (`grep -o "font-family[^;>]*" fig.svg | sort -u`).
- `svglite` panels share CSS class names and clip-path ids; `compose.py` prefixes the ids, a hand-made composition must do the same.
- Bitmaps in SVG (from `ggplot2` raster geoms) are embedded; keep their resolution high enough for the final size.
