const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, v) => fn(v);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('mole', {
  available: () => ipcRenderer.invoke('mole:available'),
  version: () => ipcRenderer.invoke('mole:version'),
  analyze: (p, fresh) => ipcRenderer.invoke('mole:analyze', p, fresh),
  history: () => ipcRenderer.invoke('mole:history'),
  apps: (fresh) => ipcRenderer.invoke('mole:apps', fresh),
  dropCache: (prefixes) => ipcRenderer.invoke('cache:drop', prefixes),
  home: () => ipcRenderer.invoke('mole:home'),
  reveal: (p) => ipcRenderer.invoke('mole:reveal', p),
  appIcon: (p) => ipcRenderer.invoke('app:icon', p),
  quitApp: (app, force) => ipcRenderer.invoke('app:quitProcess', { app, force }),
  watchStatus: () => ipcRenderer.send('status:start'),
  lastStatus: () => ipcRenderer.invoke('status:last'),
  onStatus: on('status'),
  startup: {
    list: () => ipcRenderer.invoke('startup:list'),
    toggle: (a) => ipcRenderer.invoke('startup:toggle', a),
    removeLogin: (name) => ipcRenderer.invoke('startup:removeLogin', name),
    openAutomationSettings: () => ipcRenderer.invoke('perm:open', 'automation'),
  },
  updates: (fresh) => ipcRenderer.invoke('updates:list', fresh),
  ai: {
    scan: () => ipcRenderer.invoke('ai:scan'),
    clean: (ids) => ipcRenderer.invoke('ai:clean', ids),
  },
  schedule: {
    get: () => ipcRenderer.invoke('schedule:get'),
    set: (key, patch) => ipcRenderer.invoke('schedule:set', { key, patch }),
    setAll: (patch) => ipcRenderer.invoke('schedule:setAll', patch),
    runNow: (keys) => ipcRenderer.invoke('schedule:runNow', keys),
    cancel: () => ipcRenderer.invoke('schedule:cancel'),
    read: (ids) => ipcRenderer.invoke('schedule:read', ids),
    remove: (id) => ipcRenderer.invoke('schedule:remove', id),
    onChange: on('schedule'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: on('settings'),
  },
  popoverHeight: (h) => ipcRenderer.send('popover:height', h),
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
