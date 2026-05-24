import assert from 'node:assert/strict';
import test from 'node:test';

import { getSupportedSite, isSupportedSite } from '../src/shared/sites.js';

test('recognizes supported Magic deck and search sites', () => {
  assert.equal(getSupportedSite('https://moxfield.com/decks/example')?.id, 'moxfield');
  assert.equal(getSupportedSite('https://archidekt.com/decks/123')?.id, 'archidekt');
  assert.equal(getSupportedSite('https://scryfall.com/search?q=usd%3C%3D1')?.id, 'scryfall');
});

test('rejects unsupported sites and invalid URLs', () => {
  assert.equal(isSupportedSite('https://example.com'), false);
  assert.equal(isSupportedSite('not a url'), false);
});

