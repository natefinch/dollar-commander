import { getSupportedSite } from './shared/sites.js';

document.addEventListener('DOMContentLoaded', async () => {
  const content = document.getElementById('content');
  const tab = await getActiveTab();

  if (!tab?.url) {
    renderMessage(content, 'Unable to read the active tab.');
    return;
  }

  const site = getSupportedSite(tab.url);
  if (!site) {
    renderMessage(content, 'Open Moxfield, Archidekt, or Scryfall to use Dollar Commander.');
    return;
  }

  const status = await queryContentScript(tab.id);
  renderSiteStatus(content, site, status);
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab || null;
}

async function queryContentScript(tabId) {
  if (!tabId) return { ok: false, error: 'No active tab id.' };
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'dollar-commander:get-page-status',
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function renderMessage(container, text) {
  container.className = 'panel muted';
  container.textContent = text;
}

function renderSiteStatus(container, site, status) {
  container.className = 'panel';
  container.textContent = '';

  const label = document.createElement('div');
  label.className = 'muted';
  label.textContent = status?.ok ? 'Extension content script is active.' : 'Supported site detected.';

  const siteName = document.createElement('div');
  siteName.className = 'site';
  siteName.textContent = site.name;

  container.append(label, siteName);
}

