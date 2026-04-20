'use strict';

const { buildPublicSnapshot } = require('../../snapshotPayload');

function createWebviewBridge(options = {}) {
  const state = options.state;
  const publicConfig = options.publicConfig || {};
  const panels = new Set();
  const readiness = new Map();

  function postState(panel) {
    if (!readiness.get(panel)) return;
    panel.webview.postMessage({
      type: 'state',
      snapshot: buildPublicSnapshot(state, publicConfig)
    });
  }

  function broadcastState() {
    for (const panel of panels) {
      postState(panel);
    }
  }

  function handleWarning(message) {
    for (const panel of panels) {
      if (!readiness.get(panel)) continue;
      panel.webview.postMessage({
        type: 'toast',
        level: 'warn',
        text: String(message)
      });
    }
    if (typeof options.onWarning === 'function') {
      options.onWarning(String(message));
    }
  }

  const onStateUpdate = () => broadcastState();
  state.on('update', onStateUpdate);

  let watcherWarnHandler = null;
  if (options.watcher && typeof options.watcher.on === 'function') {
    watcherWarnHandler = (message) => handleWarning(message);
    options.watcher.on('warn', watcherWarnHandler);
  }

  function detach(panel) {
    panels.delete(panel);
    readiness.delete(panel);
  }

  return {
    attach(panel) {
      panels.add(panel);
      readiness.set(panel, false);

      const receiveDisposable = panel.webview.onDidReceiveMessage((message) => {
        if (!message || typeof message.type !== 'string') return;

        switch (message.type) {
          case 'ready':
            readiness.set(panel, true);
            postState(panel);
            break;
          case 'box':
            if (typeof message.id === 'string') state.manualBox(message.id);
            break;
          case 'unbox':
            if (typeof message.id === 'string') state.manualUnbox(message.id);
            break;
          case 'hardReset':
            if (typeof options.onHardReset === 'function') options.onHardReset();
            break;
          default:
            break;
        }
      });

      const disposeDisposable = panel.onDidDispose(() => {
        detach(panel);
      });

      return {
        dispose() {
          receiveDisposable.dispose();
          disposeDisposable.dispose();
          detach(panel);
        }
      };
    },

    dispose() {
      state.off('update', onStateUpdate);
      if (options.watcher && watcherWarnHandler && typeof options.watcher.off === 'function') {
        options.watcher.off('warn', watcherWarnHandler);
      }
      panels.clear();
      readiness.clear();
    }
  };
}

module.exports = {
  createWebviewBridge
};
