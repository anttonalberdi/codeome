#!/usr/bin/env python3
"""Compose SVG panels into one multi-panel figure, keeping every panel vector.

  python3 -I compose.py OUT.svg --width 180 --cols 2 [--gap 5] [--labels abc|none] [--label-size 8] PANEL.svg ...

Sizes are in mm. Panels are placed row by row in a grid, each scaled to its column width with its aspect
ratio kept; the figure height follows. Panels are inlined as nested <svg> elements, never linked with
<image>: Inkscape rasterises linked SVGs when it exports to PDF. Ids are prefixed per panel so that clip
paths of different panels cannot collide.
"""
import argparse, re, sys

def unit_to_user(v):
    m = re.fullmatch(r'\s*([\d.]+)\s*(pt|px|mm|cm|in)?\s*', v or '')
    if not m: return None
    n, u = float(m.group(1)), m.group(2) or 'px'
    return n * {'px': 1, 'pt': 4 / 3, 'mm': 96 / 25.4, 'cm': 96 / 2.54, 'in': 96}[u]

def load(path, i):
    s = open(path, encoding='utf-8').read()
    m = re.search(r'<svg\b[^>]*>', s)
    if not m: sys.exit(f'{path}: not an SVG')
    root, body = m.group(0), s[m.end():s.rindex('</svg>')]
    vb = re.search(r'viewBox\s*=\s*[\'"]([^\'"]+)', root)
    if vb: x, y, w, h = (float(n) for n in re.split(r'[\s,]+', vb.group(1).strip()))
    else:
        w = unit_to_user(re.search(r'\bwidth\s*=\s*[\'"]([^\'"]+)', root).group(1))
        h = unit_to_user(re.search(r'\bheight\s*=\s*[\'"]([^\'"]+)', root).group(1))
        x = y = 0
    dw = re.search(r'\bwidth\s*=\s*[\'"]([^\'"]+)', root)
    dmm = unit_to_user(dw.group(1)) * 25.4 / 96 if dw and unit_to_user(dw.group(1)) else None
    p = f'p{i}-'
    body = re.sub(r'(\bid\s*=\s*([\'"]))([^\'"]+)\2', lambda m: f'{m.group(1)}{p}{m.group(3)}{m.group(2)}', body)
    body = re.sub(r'url\(\s*#([^)\s]+)\s*\)', lambda m: f'url(#{p}{m.group(1)})', body)
    body = re.sub(r'((?:xlink:)?href\s*=\s*([\'"]))#([^\'"]+)\2', lambda m: f'{m.group(1)}#{p}{m.group(3)}{m.group(2)}', body)
    return (x, y, w, h), body, dmm

def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument('out'); a.add_argument('panels', nargs='+')
    a.add_argument('--width', type=float, default=180, help='figure width in mm (default 180)')
    a.add_argument('--cols', type=int, default=2)
    a.add_argument('--gap', type=float, default=5, help='gap between panels in mm')
    a.add_argument('--labels', default='abcdefghijklmnopqrstuvwxyz', help='panel letters, or "none"')
    a.add_argument('--label-size', type=float, default=8, help='panel letter size in pt')
    a.add_argument('--font', default='Helvetica, Arial, sans-serif')
    o = a.parse_args()
    cols = max(1, min(o.cols, len(o.panels)))
    cw = (o.width - o.gap * (cols - 1)) / cols
    cells, y, row, scales = [], 0.0, [], []
    for i, path in enumerate(o.panels):
        (vx, vy, vw, vh), body, dmm = load(path, i)
        scales.append(cw / dmm if dmm else None)
        row.append((vx, vy, vw, vh, body, cw * vh / vw))
        if len(row) == cols or i == len(o.panels) - 1:
            rh = max(r[5] for r in row)
            for c, (vx, vy, vw, vh, body, h) in enumerate(row):
                cells.append((c * (cw + o.gap), y, cw, h, f'{vx:g} {vy:g} {vw:g} {vh:g}', body))
            y += rh + o.gap; row = []
    height = y - o.gap
    print('panel scale factors: ' + ', '.join('?' if k is None else f'{k:.2f}' for k in scales) + ' (1.00 = drawn at its final width)')
    ls = o.label_size * 25.4 / 72
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{o.width:g}mm" height="{height:.3f}mm" viewBox="0 0 {o.width:g} {height:.3f}">']
    for i, (x, yy, w, h, vb, body) in enumerate(cells):
        out.append(f'<svg id="panel-{i + 1}" x="{x:.3f}" y="{yy:.3f}" width="{w:.3f}" height="{h:.3f}" viewBox="{vb}">{body}</svg>')
    if o.labels != 'none':
        for i, (x, yy, *_ ) in enumerate(cells):
            if i < len(o.labels):
                out.append(f'<text x="{x:.3f}" y="{yy + ls * 0.8:.3f}" style="font-family:{o.font};font-weight:bold;font-size:{ls:.3f}px">{o.labels[i]}</text>')
    out.append('</svg>')
    open(o.out, 'w', encoding='utf-8').write('\n'.join(out))
    print(f'{o.out}: {len(cells)} panels, {o.width:g} x {height:.1f} mm')

main()
