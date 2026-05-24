export const SUPPORTED_SITES = [
  {
    id: 'moxfield',
    name: 'Moxfield',
    host: 'moxfield.com',
  },
  {
    id: 'archidekt',
    name: 'Archidekt',
    host: 'archidekt.com',
  },
  {
    id: 'scryfall',
    name: 'Scryfall',
    host: 'scryfall.com',
  },
];

export function getSupportedSite(input) {
  const url = toUrl(input);
  if (!url) return null;
  return SUPPORTED_SITES.find(site => url.hostname === site.host) || null;
}

export function isSupportedSite(input) {
  return getSupportedSite(input) !== null;
}

function toUrl(input) {
  if (input instanceof URL) return input;
  try {
    return new URL(String(input));
  } catch {
    return null;
  }
}

