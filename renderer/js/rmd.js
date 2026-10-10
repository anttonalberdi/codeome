// R code in the editor, the RStudio way: ⌘↩ sends the whole statement under the cursor
// to the R console, and R Markdown / Quarto documents get runnable chunks (highlighted
// as their language, shaded, with Run chunk / Run above above each one).
(function () {
  const R = {};
  App.views.rmd = R;

  R.isRmd = (p) => ['rmd', 'qmd'].includes(App.ext(p || ''));

  // ---------- chunks ----------
  const OPEN = /^\s*(`{3,})\s*\{\s*([A-Za-z][\w.-]*)([^}]*)\}\s*$/;
  const ENGINE = { r: 'r', python: 'python', bash: 'shell', sh: 'shell', sql: 'sql', julia: 'julia' };

  // [{ start, end, engine, label }] with start/end the fence lines (1-based). An
  // unclosed chunk runs to the end of the document.
  R.parseChunks = (lines) => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(OPEN);
      if (!m) continue;
      const close = new RegExp('^\\s*`{' + m[1].length + ',}\\s*$');
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      const opts = m[3].trim().replace(/^,\s*/, '');
      const label = (opts.match(/^([^=,\s]+)(?:\s*,|$)/) || [])[1] || '';
      out.push({ start: i + 1, end: Math.min(j, lines.length - 1) + 1, closed: j < lines.length, engine: m[2].toLowerCase(), label });
      i = j;
    }
    return out;
  };
  const chunksOf = (model) => R.parseChunks(model.getLinesContent());
  R.chunkAt = (model, line) => chunksOf(model).find((c) => line >= c.start && line <= c.end) || null;
  // The code lines of a chunk (without fences).
  const inner = (c) => ({ lo: c.start + 1, hi: c.closed ? c.end - 1 : c.end });
  const codeOf = (model, c) => { const { lo, hi } = inner(c); return hi < lo ? '' : model.getValueInRange({ startLineNumber: lo, startColumn: 1, endLineNumber: hi, endColumn: model.getLineMaxColumn(hi) }); };

  // ---------- R statements ----------
  // Splits lines into top-level statements, as [first, last] index pairs. A statement
  // goes on while a bracket or string is open, while its last code ends in an operator
  // or comma, or when the next line starts with `else`. Blank lines between statements
  // belong to none.
  const CONT = /(?:[-+*/^&|~=<>!:$@,]|%[^%\s]*%|\|>)$/;
  R.statements = (lines) => {
    const out = [];
    const nextCode = new Array(lines.length).fill(-1);
    for (let i = lines.length - 2, n = -1; i >= 0; i--) { if (lines[i + 1].trim()) n = i + 1; nextCode[i] = n; }
    let start = null, depth = 0, quote = null, cont = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (start === null && !line.trim()) continue;
      if (start === null) start = i;
      let code = '';
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        // String contents count as code but can't look like an operator.
        if (quote) { if (ch === '\\') j++; else if (ch === quote) { quote = null; code += ch; } else code += 's'; continue; }
        if (ch === '#') break;
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        code += ch;
      }
      code = code.trim();
      // Comment and blank lines inside a statement keep it going.
      if (code || quote) cont = !!quote || depth > 0 || CONT.test(code);
      const n = nextCode[i];
      const elseNext = n >= 0 && /^\s*else\b/.test(lines[n]);
      if (!cont && !elseNext) { out.push([start, i]); start = null; depth = 0; }
    }
    if (start !== null) out.push([start, lines.length - 1]);
    return out;
  };

  // The statement around `line` within lines lo..hi of the model (1-based), or null on a
  // blank line. Falls back to the line itself when the code around it doesn't balance.
  R.statementAt = (model, line, lo = 1, hi = model.getLineCount()) => {
    const lines = [];
    for (let i = lo; i <= hi; i++) lines.push(model.getLineContent(i));
    const st = R.statements(lines).find(([a, b]) => line - lo >= a && line - lo <= b);
    if (!st) return null;
    const [a, b] = [st[0] + lo, st[1] + lo];
    if (b - a > 400) return { start: line, end: line };
    return { start: a, end: b };
  };

  // ---------- running ----------
  const tabOf = (model) => App.views.editor.tabs.find((t) => t.model === model);
  // Where the code should run: the HPC for files opened from there; a new console starts
  // in the project (if the file is in it) or the file's folder.
  R.whereFor = (t) => {
    const local = !t.remote && !t.storage;
    const cwd = local && App.project && t.path.startsWith(App.project + '/') ? App.project : (t.storage ? undefined : App.dirname(t.path));
    return { remote: !!t.remote, cwd };
  };

  async function runChunks(model, chunks) {
    const t = tabOf(model); if (!t) return;
    const runnable = chunks.filter((c) => c.engine === 'r');
    const skipped = chunks.length - runnable.length;
    if (chunks.length === 1 && chunks[0].engine !== 'r') {
      // A single non-R chunk (python, bash…) goes to the active terminal.
      const code = codeOf(model, chunks[0]);
      if (code.trim()) App.views.terminals.send(code);
      return;
    }
    if (skipped) App.toast(`${skipped} non-R chunk${skipped > 1 ? 's' : ''} skipped; run ${skipped > 1 ? 'them' : 'it'} one by one.`);
    const code = runnable.map((c) => codeOf(model, c)).filter((s) => s.trim()).join('\n');
    if (code.trim()) await App.views.terminals.sendR(code, R.whereFor(t));
  }
  R.runChunk = (model, line) => { const c = R.chunkAt(model, line); if (c) runChunks(model, [c]); else App.toast('Put the cursor in a code chunk.'); };
  // Every chunk that ends above the cursor's chunk (or above the cursor, outside chunks).
  R.runAbove = (model, line) => { const cur = R.chunkAt(model, line); runChunks(model, chunksOf(model).filter((c) => c.end < (cur ? cur.start : line))); };
  R.runAll = (model) => runChunks(model, chunksOf(model));
  R.runNext = (model, line) => {
    const c = chunksOf(model).find((x) => x.start > line);
    if (!c) return App.toast('No chunk below.');
    const ed = App.views.editor.editor;
    ed.setPosition({ lineNumber: c.start + 1, column: 1 }); ed.revealLineInCenterIfOutsideViewport(c.start);
    runChunks(model, [c]);
  };
  // An empty chunk on the cursor's line (or below it, if the line has text).
  R.insertChunk = (ed) => {
    const model = ed.getModel(), n = ed.getPosition().lineNumber;
    const chunks = chunksOf(model);
    const engine = chunks.length && chunks.every((c) => c.engine === 'python') ? 'python' : 'r';
    const busy = !!model.getLineContent(n).trim();
    const end = model.getLineMaxColumn(n);
    ed.executeEdits('codeome', [{ range: { startLineNumber: n, startColumn: end, endLineNumber: n, endColumn: end }, text: (busy ? '\n\n' : '') + '```{' + engine + '}\n\n```', forceMoveMarkers: true }]);
    ed.setPosition({ lineNumber: n + (busy ? 3 : 1), column: 1 });
    ed.focus();
  };

  // ---------- editor wiring ----------
  R.init = (ed) => {
    const m = window.monaco;
    // Load the languages chunks embed, so their code is highlighted right away.
    for (const id of ['r', 'python', 'shell', 'yaml']) { try { m.editor.createModel('', id).dispose(); } catch {} }

    m.languages.register({ id: 'rmarkdown', extensions: ['.rmd', '.qmd'], aliases: ['R Markdown', 'Quarto'] });
    m.languages.setLanguageConfiguration('rmarkdown', {
      comments: { blockComment: ['<!--', '-->'] },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }, { open: '`', close: '`' }],
      surroundingPairs: [{ open: '*', close: '*' }, { open: '_', close: '_' }, { open: '`', close: '`' }, { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '"', close: '"' }]
    });
    const fence = (lang) => lang ? { token: 'keyword.chunk', next: '@chunk', nextEmbedded: lang } : { token: 'keyword.chunk', next: '@chunk' };
    m.languages.setMonarchTokensProvider('rmarkdown', {
      defaultToken: '',
      start: 'front',
      tokenizer: {
        // A YAML header only at the very top; later `---` lines are rules or slide breaks.
        front: [
          [/^---\s*$/, { token: 'comment', switchTo: '@yaml' }],
          [/^.*$/, { token: '@rematch', switchTo: '@root' }]
        ],
        yaml: [
          [/^(---|\.\.\.)\s*$/, { token: 'comment', switchTo: '@root' }],
          [/^(\s*-?\s*)([\w.-]+)(\s*:)/, ['', 'type', 'delimiter']],
          [/#.*$/, 'comment'],
          [/[^#]+/, 'string']
        ],
        root: [
          [/^\s*`{3,}\s*\{\s*[rR](?=[\s,}]).*$/, fence('r')],
          [/^\s*`{3,}\s*\{\s*python(?=[\s,}]).*$/, fence('python')],
          [/^\s*`{3,}\s*\{\s*(bash|sh)(?=[\s,}]).*$/, fence('shell')],
          [/^\s*`{3,}\s*\{\s*sql(?=[\s,}]).*$/, fence('sql')],
          [/^\s*`{3,}.*$/, fence(null)],
          [/^\s*#{1,6}\s.*$/, 'keyword'],
          [/^\s*([*+-]|\d+[.)])\s/, 'keyword'],
          [/^\s*>.*$/, 'comment'],
          [/<!--/, 'comment', '@htmlcomment'],
          [/`r [^`]*`/, 'variable'],
          [/`[^`]+`/, 'string'],
          [/\*\*[^*]+\*\*|__[^_]+__/, 'strong'],
          [/\*[^*\s][^*]*\*|\b_[^_\s][^_]*_\b/, 'emphasis'],
          [/!?\[[^\]]*\]\([^)]*\)/, 'string.link'],
          [/\$\$?[^$]+\$\$?/, 'number'],
          [/[^`*_[!<$#>]+/, ''],
          [/./, '']
        ],
        chunk: [
          [/^\s*`{3,}\s*$/, { token: 'keyword.chunk', next: '@pop', nextEmbedded: '@pop' }],
          [/[^`]+/, ''],
          [/`/, '']
        ],
        htmlcomment: [[/-->/, 'comment', '@pop'], [/[^-]+/, 'comment'], [/./, 'comment']]
      }
    });

    // CodeLens commands receive the document and the line they sit on.
    const modelFor = (uri) => m.editor.getModel(m.Uri.parse(uri));
    m.editor.registerCommand('codeome.rmd.runChunk', (_a, uri, line) => { const md = modelFor(uri); if (md) R.runChunk(md, line); });
    m.editor.registerCommand('codeome.rmd.runAbove', (_a, uri, line) => { const md = modelFor(uri); if (md) R.runAbove(md, line); });
    m.editor.registerCommand('codeome.rmd.runAll', (_a, uri) => { const md = modelFor(uri); if (md) R.runAll(md); });
    m.editor.registerCommand('codeome.rmd.knit', (_a, uri) => { const md = modelFor(uri); const t = md && tabOf(md); if (t) App.views.editor.preview(t.path, { remote: t.remote, storage: t.storage }); });
    m.languages.registerCodeLensProvider('rmarkdown', {
      provideCodeLenses: (model) => {
        const uri = model.uri.toString();
        const chunks = chunksOf(model);
        const at = (line) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
        const lenses = [];
        const knit = App.ext(model.uri.path) === 'qmd' ? 'Render' : 'Knit';
        lenses.push({ range: at(1), command: { id: 'codeome.rmd.knit', title: `${knit} (⇧⌘K)`, arguments: [uri] } });
        if (chunks.length) lenses.push({ range: at(1), command: { id: 'codeome.rmd.runAll', title: '▶ Run all chunks (⌥⌘R)', arguments: [uri] } });
        chunks.forEach((c, i) => {
          lenses.push({ range: at(c.start), command: { id: 'codeome.rmd.runChunk', title: '▶ Run chunk' + (c.engine === 'r' ? '' : ` (${c.engine})`), arguments: [uri, c.start + 1] } });
          if (i) lenses.push({ range: at(c.start), command: { id: 'codeome.rmd.runAbove', title: 'Run chunks above', arguments: [uri, c.start] } });
        });
        return { lenses, dispose() {} };
      },
      resolveCodeLens: (_model, lens) => lens
    });

    // Shade chunks so code stands apart from prose.
    const deco = ed.createDecorationsCollection([]);
    let timer = null;
    const shade = () => {
      const model = ed.getModel();
      if (!model || model.getLanguageId() !== 'rmarkdown') { deco.clear(); return; }
      const ds = [];
      for (const c of chunksOf(model)) {
        ds.push({ range: { startLineNumber: c.start, startColumn: 1, endLineNumber: c.end, endColumn: 1 }, options: { isWholeLine: true, className: 'rmd-chunk' } });
        ds.push({ range: { startLineNumber: c.start, startColumn: 1, endLineNumber: c.start, endColumn: 1 }, options: { isWholeLine: true, className: 'rmd-fence' } });
        if (c.closed) ds.push({ range: { startLineNumber: c.end, startColumn: 1, endLineNumber: c.end, endColumn: 1 }, options: { isWholeLine: true, className: 'rmd-fence' } });
      }
      deco.set(ds);
    };
    ed.onDidChangeModel(shade);
    ed.onDidChangeModelContent(() => { clearTimeout(timer); timer = setTimeout(shade, 150); });

    // RStudio's keys. ⌥⌘I opens the developer tools here, so inserting a chunk is ⌃⌥I.
    const rmdOnly = 'editorLangId == rmarkdown';
    const K = m.KeyMod, C = m.KeyCode;
    const act = (id, label, keys, run, order) => ed.addAction({ id, label, keybindings: keys, keybindingContext: rmdOnly, precondition: rmdOnly, contextMenuGroupId: order != null ? 'navigation' : undefined, contextMenuOrder: order, run });
    act('codeome.rmd.runAll', 'Run all chunks', [K.CtrlCmd | K.Alt | C.KeyR], (e) => R.runAll(e.getModel()), 1.5);
    act('codeome.rmd.runAbove', 'Run chunks above', [K.CtrlCmd | K.Alt | C.KeyP], (e) => R.runAbove(e.getModel(), e.getPosition().lineNumber));
    act('codeome.rmd.runNext', 'Run next chunk', [K.CtrlCmd | K.Alt | C.KeyN], (e) => R.runNext(e.getModel(), e.getPosition().lineNumber));
    act('codeome.rmd.runCurrent', 'Run current chunk', [K.CtrlCmd | K.Alt | C.KeyC], (e) => R.runChunk(e.getModel(), e.getPosition().lineNumber));
    act('codeome.rmd.insert', 'Insert code chunk', [K.WinCtrl | K.Alt | C.KeyI], (e) => R.insertChunk(e), 1.6);
    act('codeome.rmd.knit', 'Knit / render', [K.CtrlCmd | K.Shift | C.KeyK], () => App.views.editor.previewCurrent());
  };
})();
