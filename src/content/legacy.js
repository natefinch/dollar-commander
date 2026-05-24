import { getSupportedSite } from '../shared/sites.js';

const ROOT_ID = 'dollar-commander-root';
const MESSAGE_TAG = 'dollar-commander';

const site = getSupportedSite(window.location.href);
if (site) {
  injectStatusBadge(site);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dollar-commander:get-page-status') return false;
  sendResponse({
    ok: true,
    site,
    url: window.location.href,
  });
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.dollarCommander !== MESSAGE_TAG || event.data?.from !== 'main') return;
  if (event.data.type === 'ready') {
    document.documentElement.dataset.dollarCommanderMainReady = 'true';
  }
});

function injectStatusBadge(currentSite) {
  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'dollar-commander-badge';

  const title = document.createElement('strong');
  title.textContent = 'Dollar Commander';

  const body = document.createElement('span');
  body.textContent = `Ready on ${currentSite.name}`;

  root.append(title, body);
  document.documentElement.appendChild(root);
}

