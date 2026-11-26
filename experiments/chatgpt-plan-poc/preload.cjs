const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenSpirit', {
  getState: () => ipcRenderer.invoke('poc:get-state'),
  beginSelection: () => ipcRenderer.invoke('poc:begin-selection'),
  beginClipboard: () => ipcRenderer.invoke('poc:begin-clipboard'),
  integrationsDetect: () => ipcRenderer.invoke('poc:integrations-detect'),
  integrationsSave: (enabled) => ipcRenderer.invoke('poc:integrations-save', enabled),
  defaultTargetSet: (targetId) => ipcRenderer.invoke('poc:default-target-set', targetId),
  permissionsStatus: () => ipcRenderer.invoke('poc:permissions-status'),
  permissionsOpen: (kind) => ipcRenderer.invoke('poc:permissions-open', kind),
  appRelaunch: () => ipcRenderer.invoke('poc:app-relaunch'),
  languageSet: (lang) => ipcRenderer.invoke('poc:language-set', lang),
  openInstallLink: (id) => ipcRenderer.invoke('poc:open-install-link', id),
  builtinRetry: () => ipcRenderer.invoke('poc:builtin-retry'),
  cliLogin: (targetId) => ipcRenderer.invoke('poc:cli-login', targetId),
  listProjects: (targetId) => ipcRenderer.invoke('poc:projects-list', targetId),
  pickProject: (options) => ipcRenderer.invoke('poc:projects-pick', options),
  spiritsList: () => ipcRenderer.invoke('poc:spirits-list'),
  spiritsCreate: () => ipcRenderer.invoke('poc:spirits-create'),
  spiritsSave: (spirit) => ipcRenderer.invoke('poc:spirits-save', spirit),
  spiritsDelete: (id) => ipcRenderer.invoke('poc:spirits-delete', id),
  spiritsPickSource: (kind) => ipcRenderer.invoke('poc:spirits-pick-source', kind),
  labWindow: (mode) => ipcRenderer.invoke('poc:lab-window', mode),
  wfCatalog: () => ipcRenderer.invoke('poc:wf-catalog'),
  wfList: () => ipcRenderer.invoke('poc:wf-list'),
  wfGet: (id) => ipcRenderer.invoke('poc:wf-get', id),
  wfSave: (workflow) => ipcRenderer.invoke('poc:wf-save', workflow),
  wfDelete: (id) => ipcRenderer.invoke('poc:wf-delete', id),
  wfValidate: (workflow) => ipcRenderer.invoke('poc:wf-validate', workflow),
  wfRun: (options) => ipcRenderer.invoke('poc:wf-run', options),
  wfCancel: () => ipcRenderer.invoke('poc:wf-cancel'),
  wfPick: () => ipcRenderer.invoke('poc:wf-pick'),
  wfOpenOutput: (options) => ipcRenderer.invoke('poc:wf-open-output', options),
  wfFinishStep: (nodeId) => ipcRenderer.invoke('poc:wf-finish-step', nodeId),
  wfSaveOutput: (options) => ipcRenderer.invoke('poc:wf-save-output', options),
  onWorkflowEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('poc:workflow-event', wrapped);
    return () => ipcRenderer.removeListener('poc:workflow-event', wrapped);
  },
  beginSpiritTask: () => ipcRenderer.invoke('poc:begin-spirit-task'),
  saveImage: (options) => ipcRenderer.invoke('poc:save-image', options),
  skinModels: () => ipcRenderer.invoke('poc:skin-models'),
  skinDraft: (spiritId) => ipcRenderer.invoke('poc:skin-draft', spiritId),
  skinGet: (spiritId) => ipcRenderer.invoke('poc:skin-get', spiritId),
  skinBusy: (spiritId) => ipcRenderer.invoke('poc:skin-busy', spiritId),
  skinStart: (options) => ipcRenderer.invoke('poc:skin-start', options),
  skinBuild: (options) => ipcRenderer.invoke('poc:skin-build', options),
  skinCard: (spiritId) => ipcRenderer.invoke('poc:skin-card', spiritId),
  skinRemove: (spiritId) => ipcRenderer.invoke('poc:skin-remove', spiritId),
  skinSuggestHero: (options) => ipcRenderer.invoke('poc:skin-suggest-hero', options),
  skinSamStatus: () => ipcRenderer.invoke('poc:skin-sam-status'),
  skinSamInstall: () => ipcRenderer.invoke('poc:skin-sam-install'),
  skinDesktopGet: () => ipcRenderer.invoke('poc:skin-desktop-get'),
  previewSpirit: (spiritId) => ipcRenderer.invoke('poc:preview-spirit', spiritId),
  skinDesktopSet: (spiritId) => ipcRenderer.invoke('poc:skin-desktop-set', spiritId),
  onSkinProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('poc:skin-progress', listener);
    return () => ipcRenderer.removeListener('poc:skin-progress', listener);
  },
  kbLocations: () => ipcRenderer.invoke('poc:kb-locations'),
  kbChooseHome: (options) => ipcRenderer.invoke('poc:kb-choose-home', options),
  kbClearHome: (spiritId) => ipcRenderer.invoke('poc:kb-clear-home', spiritId),
  kbList: (options) => ipcRenderer.invoke('poc:kb-list', options),
  kbRead: (options) => ipcRenderer.invoke('poc:kb-read', options),
  kbReveal: (options) => ipcRenderer.invoke('poc:kb-reveal', options),
  kbOpen: (options) => ipcRenderer.invoke('poc:kb-open', options),
  memoryCurateTest: (spiritId) => ipcRenderer.invoke('poc:memory-curate-test', spiritId),
  spiritGenerateLimits: (options) => ipcRenderer.invoke('poc:spirit-generate-limits', options),
  spiritGenerateRole: (options) => ipcRenderer.invoke('poc:spirit-generate-role', options),
  spiritGenerateSop: (options) => ipcRenderer.invoke('poc:spirit-generate-sop', options),
  spiritGenerateCancel: () => ipcRenderer.invoke('poc:spirit-generate-cancel'),
  onOpenIntegrations: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('poc:open-integrations', listener);
    return () => ipcRenderer.removeListener('poc:open-integrations', listener);
  },
  setLayoutMode: (mode) => ipcRenderer.invoke('poc:set-layout-mode', mode),
  drawerAction: (action) => ipcRenderer.invoke('poc:drawer-action', action),
  hideChat: () => ipcRenderer.invoke('poc:hide-chat'),
  finishConversation: () => ipcRenderer.invoke('poc:finish-conversation'),
  listHistory: () => ipcRenderer.invoke('poc:list-history'),
  openHistory: (id) => ipcRenderer.invoke('poc:open-history', id),
  deleteHistory: (id) => ipcRenderer.invoke('poc:delete-history', id),
  clearHistory: () => ipcRenderer.invoke('poc:clear-history'),
  signIn: () => ipcRenderer.invoke('poc:sign-in'),
  setModel: (model) => ipcRenderer.invoke('poc:set-model', model),
  setPresentationMode: (mode) => ipcRenderer.invoke('poc:set-presentation-mode', mode),
  send: (input) => ipcRenderer.invoke('poc:send', input),
  deliver: (input) => ipcRenderer.invoke('poc:deliver', input),
  mixrouteSetKey: (key) => ipcRenderer.invoke('poc:mixroute-set-key', key),
  mixrouteClearKey: () => ipcRenderer.invoke('poc:mixroute-clear-key'),
  mixrouteRefreshModels: () => ipcRenderer.invoke('poc:mixroute-refresh-models'),
  mixrouteClearBlocked: () => ipcRenderer.invoke('poc:mixroute-clear-blocked'),
  cancel: () => ipcRenderer.invoke('poc:cancel'),
  clear: () => ipcRenderer.invoke('poc:clear'),
  manageUsage: () => ipcRenderer.invoke('poc:manage-usage'),
  disconnect: () => ipcRenderer.invoke('poc:disconnect'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('poc:state', listener);
    return () => ipcRenderer.removeListener('poc:state', listener);
  },
  onDelta: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('poc:delta', listener);
    return () => ipcRenderer.removeListener('poc:delta', listener);
  },
  onPresentation: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('poc:presentation', listener);
    return () => ipcRenderer.removeListener('poc:presentation', listener);
  },
  onSelectionResult: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('poc:selection-result', listener);
    return () => ipcRenderer.removeListener('poc:selection-result', listener);
  },
  onClipboardResult: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('poc:clipboard-result', listener);
    return () => ipcRenderer.removeListener('poc:clipboard-result', listener);
  },
  onOpenChat: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('poc:open-chat', listener);
    return () => ipcRenderer.removeListener('poc:open-chat', listener);
  },
  onFinishConversation: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('poc:conversation-finished', listener);
    return () => ipcRenderer.removeListener('poc:conversation-finished', listener);
  },
  onHistoryOpened: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('poc:history-opened', listener);
    return () => ipcRenderer.removeListener('poc:history-opened', listener);
  },
});
