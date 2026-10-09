// Exposes a narrow, typed bridge to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('codeome', {
  platform: process.platform,
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  config: { get: invoke('config:get'), set: invoke('config:set') },
  secret: { set: (key, value) => ipcRenderer.invoke('secret:set', { key, value }), has: invoke('secret:has') },
  dialog: { folder: invoke('dialog:folder'), files: invoke('dialog:files'), confirm: invoke('dialog:confirm') },
  shell: { open: invoke('shell:open'), reveal: invoke('shell:reveal'), openPath: invoke('shell:openPath') },
  pty: {
    spawn: invoke('pty:spawn'),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: on('pty:data'), onExit: on('pty:exit')
  },
  local: {
    list: invoke('local:list'), read: invoke('local:read'),
    write: (path, content) => ipcRenderer.invoke('local:write', { path, content }),
    mkdir: invoke('local:mkdir'), rename: (from, to) => ipcRenderer.invoke('local:rename', { from, to }),
    trash: invoke('local:trash'), home: invoke('local:home')
  },
  hpc: { status: invoke('hpc:status'), disconnect: invoke('hpc:disconnect'), vpn: invoke('hpc:vpn'), quota: invoke('remote:quota') },
  remote: {
    list: invoke('remote:list'), read: invoke('remote:read'),
    write: (path, content) => ipcRenderer.invoke('remote:write', { path, content }),
    mkdir: invoke('remote:mkdir'), rename: (from, to) => ipcRenderer.invoke('remote:rename', { from, to }),
    delete: invoke('remote:delete'), du: invoke('remote:du')
  },
  transfer: { start: invoke('transfer:start'), cancel: invoke('transfer:cancel'), onProgress: on('transfer:progress'), onDone: on('transfer:done') },
  slurm: {
    queue: invoke('slurm:queue'), history: invoke('slurm:history'), details: invoke('slurm:details'),
    tail: (file, lines) => ipcRenderer.invoke('slurm:tail', { file, lines }),
    cancel: invoke('slurm:cancel'), submit: invoke('slurm:submit'), partitions: invoke('slurm:partitions')
  },
  preview: { render: invoke('preview:render'), fetchRemote: invoke('preview:fetchRemote'), onLog: on('preview:log') },
  git: {
    status: invoke('git:status'), diff: invoke('git:diff'), show: invoke('git:show'),
    run: (root, args) => ipcRenderer.invoke('git:run', { root, args }),
    gh: (root, args) => ipcRenderer.invoke('gh:run', { root, args })
  },
  zenodo: {
    list: invoke('zenodo:list'), create: invoke('zenodo:create'), update: invoke('zenodo:update'),
    upload: invoke('zenodo:upload'), publish: invoke('zenodo:publish'), newVersion: invoke('zenodo:newVersion'),
    onProgress: on('zenodo:progress')
  },
  pip: { list: invoke('pip:list'), hasToken: invoke('pypi:hasToken') },
  kit: { status: invoke('kit:status'), install: (project, groups) => ipcRenderer.invoke('kit:install', { project, groups }) },
  jobs: {
    list: invoke('jobs:list'), clear: invoke('jobs:clear'),
    read: (project, id, part) => ipcRenderer.invoke('jobs:read', { project, id, part }),
    cancel: (project, id) => ipcRenderer.invoke('jobs:cancel', { project, id })
  },
  usage: {
    get: invoke('usage:get'), refresh: invoke('usage:refresh'),
    setActive: (engine, name) => ipcRenderer.invoke('usage:setActive', { engine, name }),
    onUpdate: on('usage:update')
  },
  env: { detect: invoke('env:detect') },
  onMenu: on('menu')
});
