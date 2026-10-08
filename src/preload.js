const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, v) => fn(v);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('mole', {
  available: () => ipcRenderer.invoke('mole:available'),
  version: () => ipcRenderer.invoke('mole:version'),
  analyze: (p) => ipcRenderer.invoke('mole:analyze', p),
  history: () => ipcRenderer.invoke('mole:history'),
  apps: () => ipcRenderer.invoke('mole:apps'),
  home: () => ipcRenderer.invoke('mole:home'),
  reveal: (p) => ipcRenderer.invoke('mole:reveal', p),
  appIcon: (p) => ipcRenderer.invoke('app:icon', p),
  watchStatus: () => ipcRenderer.send('status:start'),
  lastStatus: () => ipcRenderer.invoke('status:last'),
  onStatus: on('status'),
  startup: {
    list: () => ipcRenderer.invoke('startup:list'),
    toggle: (a) => ipcRenderer.invoke('startup:toggle', a),
    removeLogin: (name) => ipcRenderer.invoke('startup:removeLogin', name),
    openAutomationSettings: () => ipcRenderer.invoke('perm:open', 'automation'),
  },
  updates: () => ipcRenderer.invoke('updates:list'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  perms: {
    check: () => ipcRenderer.invoke('perm:check'),
    automation: () => ipcRenderer.invoke('perm:automation'),
    open: (pane) => ipcRenderer.invoke('perm:open', pane),
  },
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  updateMole: () => ipcRenderer.invoke('mole:update'),
  onMoleUpdated: on('mole:updated'),
  app: {
    open: (view) => ipcRenderer.send('app:open', view),
    run: (opts) => ipcRenderer.send('app:run', opts),
    quit: () => ipcRenderer.send('app:quit'),
    onNavigate: on('navigate'),
    onRun: on('run'),
  },
  session: {
    start: (opts) => ipcRenderer.invoke('session:start', opts),
    input: (d) => ipcRenderer.send('session:input', d),
    resize: (size) => ipcRenderer.send('session:resize', size),
    kill: () => ipcRenderer.send('session:kill'),
    onData: on('session:data'),
    onExit: on('session:exit'),
  },
});
