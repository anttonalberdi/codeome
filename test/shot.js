// Dev helper: launch the app with a throwaway profile, run a UI script, save screenshots, quit.
// Usage: electron test/shot.js <outdir> [scenario]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const rest = process.argv.slice(process.argv.findIndex((a) => a.endsWith('shot.js')) + 1);
const out = path.resolve(rest[0] || 'shots');
const scenario = rest[1] || 'welcome';
app.setPath('userData', path.join(out, 'profile'));
fs.mkdirSync(path.join(out, 'profile'), { recursive: true });
fs.writeFileSync(path.join(out, 'profile', 'config.json'), JSON.stringify({ recentFolders: [path.resolve(__dirname, '..')], hpc: { host: 'myhpc' } }));
require('../main/main.js');

const steps = {
  welcome: [],
  editor: [`App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../main/slurm.js'))})`],
  slurm: [`App.hpcConnected = true; App.emit('hpc', true); App.views.slurm.queue = [{id:'4810231',name:'metaspades_assembly',state:'RUNNING',elapsed:'5:12:40',limit:'1-00:00:00',cpus:'32',partition:'gpu',reason:'node-a17',workdir:'/projects/holo/asm'},{id:'4810240',name:'kraken2_classify',state:'PENDING',elapsed:'0:00',limit:'8:00:00',cpus:'16',partition:'standard',reason:'(Priority)'}]; App.views.slurm.history=[{id:'4810101',name:'fastp_qc',state:'COMPLETED',elapsed:'00:42:10',exitcode:'0:0',maxrss:'3.1G',end:new Date(Date.now()-3600e3).toISOString()},{id:'4810099',name:'bowtie2_map',state:'OUT_OF_MEMORY',elapsed:'01:02:00',exitcode:'0:125',maxrss:'64G',end:new Date(Date.now()-7200e3).toISOString()}]; App.emit('jobs',{running:1,pending:1,failed:1}); App.setView('slurm'); App.views.slurm.refresh = ()=>{}; document.querySelector('[data-view=slurm] .jobs') && App.setView('slurm');`],
  git: [`App.setView('git')`],
  diff: [`App.views.editor.diff({key:'d',title:'x.R',original:'a <- 1\\nb <- 2\\n',modified:'a <- 1\\nb <- 3\\nc <- 4\\n',lang:'r'}); 0`],
  settings: [`document.documentElement.dataset.theme='dark'; App.views.editor.applyTheme(); App.views.terminals.retheme(); App.views.settings.open(); 0`]
};

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 1) console.log('[renderer]', msg); });
    for (const s of steps[scenario] || []) { try { await win.webContents.executeJavaScript(s); } catch (e) { console.log('step error', e.message); } }
    await new Promise((r) => setTimeout(r, 2500));
    if (scenario === 'slurm') await win.webContents.executeJavaScript(`App.views.slurm.stop(); App.views.slurm.render(); App.views.slurm.openJob(App.views.slurm.queue[0]);`).catch((e)=>console.log(e.message));
    await new Promise((r) => setTimeout(r, 800));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, scenario + '.png'), img.toPNG());
    const errs = await win.webContents.executeJavaScript('window.__errs || []').catch(() => []);
    console.log('saved', scenario, errs.length ? errs : '');
    app.exit(0);
  }, 5000);
});
