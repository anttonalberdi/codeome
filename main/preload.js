// Exposes a narrow, typed bridge to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('codeome', {
  platform: process.platform,
  version: invoke('app:version'),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  config: { get: invoke('config:get'), set: invoke('config:set') },
  secret: { set: (key, value) => ipcRenderer.invoke('secret:set', { key, value }), has: invoke('secret:has') },
  secrets: {
    set: (name, value) => ipcRenderer.invoke('secrets:set', { name, value }), remove: invoke('secrets:remove'),
    has: invoke('secrets:has'), copy: invoke('secrets:copy')
  },
  dialog: { folder: invoke('dialog:folder'), files: invoke('dialog:files'), save: invoke('dialog:save'), confirm: invoke('dialog:confirm') },
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
  vpn: {
    start: invoke('vpn:start'), stop: invoke('vpn:stop'), state: invoke('vpn:state'), log: invoke('vpn:log'),
    answer: (id, value, save) => ipcRenderer.invoke('vpn:answer', { id, value, save }), onState: on('vpn:state')
  },
  login: {
    start: invoke('login:start'), stop: invoke('login:stop'), state: invoke('login:state'), log: invoke('login:log'),
    answer: (target, id, value, save) => ipcRenderer.invoke('login:answer', { target, id, value, save }), onState: on('login:state')
  },
  setup: { status: invoke('setup:status'), testLogin: invoke('setup:testLogin'), testVpn: invoke('setup:testVpn'), install: invoke('setup:install') },
  remote: {
    list: invoke('remote:list'), read: invoke('remote:read'),
    write: (path, content) => ipcRenderer.invoke('remote:write', { path, content }),
    mkdir: invoke('remote:mkdir'), rename: (from, to) => ipcRenderer.invoke('remote:rename', { from, to }),
    delete: invoke('remote:delete'), du: invoke('remote:du')
  },
  storage: {
    status: invoke('storage:status'), disconnect: invoke('storage:disconnect'),
    list: invoke('storage:list'), read: invoke('storage:read'),
    write: (path, content) => ipcRenderer.invoke('storage:write', { path, content }),
    mkdir: invoke('storage:mkdir'), rename: (from, to) => ipcRenderer.invoke('storage:rename', { from, to }),
    delete: (path, dir) => ipcRenderer.invoke('storage:delete', { path, dir }), fetch: invoke('storage:fetch'),
    hpcCommand: (direction, src, destDir) => ipcRenderer.invoke('storage:hpcCommand', { direction, src, destDir })
  },
  transfer: { start: invoke('transfer:start'), cancel: invoke('transfer:cancel'), onProgress: on('transfer:progress'), onDone: on('transfer:done') },
  slurm: {
    queue: invoke('slurm:queue'), history: invoke('slurm:history'), details: invoke('slurm:details'),
    tail: (file, lines) => ipcRenderer.invoke('slurm:tail', { file, lines }),
    cancel: invoke('slurm:cancel'), submit: invoke('slurm:submit'), partitions: invoke('slurm:partitions'), resources: invoke('slurm:resources')
  },
  preview: { render: invoke('preview:render'), fetchRemote: invoke('preview:fetchRemote'), onLog: on('preview:log') },
  git: {
    status: invoke('git:status'), dirty: invoke('git:dirty'), diff: invoke('git:diff'), show: invoke('git:show'),
    run: (root, args) => ipcRenderer.invoke('git:run', { root, args }),
    gh: (root, args) => ipcRenderer.invoke('gh:run', { root, args })
  },
  gitAccounts: {
    list: invoke('gitacct:list'), add: (provider, host, token) => ipcRenderer.invoke('gitacct:add', { provider, host, token }),
    validate: (id) => ipcRenderer.invoke('gitacct:validate', { id }),
    remove: (id) => ipcRenderer.invoke('gitacct:remove', { id }),
    importGh: (host) => ipcRenderer.invoke('gitacct:import-gh', { host }),
    bind: (root, id) => ipcRenderer.invoke('gitacct:bind', { root, id }),
    identityGet: (root) => ipcRenderer.invoke('gitacct:identity-get', { root }),
    identitySet: (root, name, email) => ipcRenderer.invoke('gitacct:identity-set', { root, name, email })
  },
  zenodo: {
    list: invoke('zenodo:list'), create: invoke('zenodo:create'), update: invoke('zenodo:update'),
    upload: invoke('zenodo:upload'), publish: invoke('zenodo:publish'), newVersion: invoke('zenodo:newVersion'),
    onProgress: on('zenodo:progress')
  },
  pip: { list: invoke('pip:list'), hasToken: invoke('pypi:hasToken') },
  plots: {
    install: invoke('plots:install'), render: invoke('plots:render'), copy: invoke('plots:copy'),
    canvas: (where, text) => ipcRenderer.invoke('plots:canvas', { where, text })
  },
  rpkg: { list: invoke('rpkg:list') },
  kit: { status: invoke('kit:status'), install: (project, groups) => ipcRenderer.invoke('kit:install', { project, groups }) },
  skills: { list: invoke('skills:list') },
  global: { list: invoke('global:list'), setAgent: (project, name, patch) => ipcRenderer.invoke('global:setAgent', { project, name, patch }) },
  agents: {
    list: invoke('agents:list'), models: invoke('agents:models'),
    set: (project, name, patch) => ipcRenderer.invoke('agents:set', { project, name, patch })
  },
  jobs: {
    list: invoke('jobs:list'), clear: invoke('jobs:clear'),
    read: (project, id, part) => ipcRenderer.invoke('jobs:read', { project, id, part }),
    cancel: (project, id) => ipcRenderer.invoke('jobs:cancel', { project, id })
  },
  chat: {
    start: invoke('chat:start'), personas: invoke('chat:personas'), stop: invoke('chat:stop'), move: invoke('chat:move'),
    send: (id, text) => ipcRenderer.invoke('chat:send', { id, text }),
    respond: (id, requestId, response) => ipcRenderer.invoke('chat:respond', { id, requestId, response }),
    control: (id, request) => ipcRenderer.invoke('chat:control', { id, request }),
    save: (project, chat) => ipcRenderer.invoke('chat:save', { project, chat }),
    list: invoke('chat:list'), load: (project, id) => ipcRenderer.invoke('chat:load', { project, id }),
    delete: (project, id) => ipcRenderer.invoke('chat:delete', { project, id }),
    onEvent: on('chat:event'), onExit: on('chat:exit')
  },
  stats: { get: invoke('stats:get') },
  usage: {
    get: invoke('usage:get'), refresh: invoke('usage:refresh'), found: invoke('usage:found'),
    setActive: (engine, name) => ipcRenderer.invoke('usage:setActive', { engine, name }),
    onUpdate: on('usage:update')
  },
  gdoc: {
    open: (id, path) => ipcRenderer.invoke('gdoc:open', { id, path }), reload: invoke('gdoc:reload'),
    place: (id, bounds) => ipcRenderer.send('gdoc:place', { id, bounds }),
    dark: (id, on) => ipcRenderer.send('gdoc:dark', { id, on }),
    close: (id) => ipcRenderer.send('gdoc:close', { id }),
    onState: on('gdoc:state')
  },
  env: { detect: invoke('env:detect') },
  tools: { updates: invoke('tools:updates') },
  onMenu: on('menu')
});
