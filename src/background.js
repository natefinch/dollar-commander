const INSTALL_STATE_KEY = 'dollarCommanderInstallState';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.storage.local.set({
    [INSTALL_STATE_KEY]: {
      installedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
    },
  });
});

