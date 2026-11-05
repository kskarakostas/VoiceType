// VoiceType service worker. Listeners and wiring only; logic lives in the imported modules.
import { MSG, SAVE_PORT } from '../shared/messages.js';
import { migrateSettings, toPublicSettings } from '../shared/defaults.js';
import { ruleFor } from '../shared/sites.js';
import { createStorage } from './storage.js';
import { createRouter, createValidateKey, senderKind, userMessage } from './router.js';
import { runDictation, ADAPTERS } from './pipeline.js';
import { applyUsage, summarize } from './usage.js';
import { createDictate } from './dictate.js';
import { createHistory } from './history.js';
import { createRecorder } from './recorder.js';
import { createOffscreenClient } from './offscreen-client.js';
import { broadcast, reinject, sendToFrame } from './tabs.js';

// Keys live in storage.local; only the service worker and extension pages may read it.
(async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    console.warn('VoiceType: could not restrict storage access', err);
  }
})();

const storage = createStorage(chrome.storage.local);
const history = createHistory({ area: chrome.storage.session });
const offscreenClient = createOffscreenClient({ runtime: chrome.runtime, offscreen: chrome.offscreen });
const recorder = createRecorder({
  ensureOffscreen: () => offscreenClient.ensure(),
  toOffscreen: (message) => offscreenClient.send(message),
  toTab: (endpoint, message) => sendToFrame(chrome.tabs, endpoint, message),
  openPermissionPage: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }); },
  getSettings: () => storage.getSettings(),
  dictate: createDictate({ storage, history, runDictation, applyUsage, userMessage }),
});

// Built from the id: URL parsers outside Chrome give chrome-extension: URLs an opaque 'null' origin,
// which content scripts in sandboxed frames also report.
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const handle = createRouter({
  storage,
  validateKey: createValidateKey(ADAPTERS),
  summarize,
  recorder,
  history,
  identify: (sender) => senderKind(sender, { extensionId: chrome.runtime.id, extensionOrigin, offscreenUrl }),
});

chrome.runtime.onInstalled.addListener((details) => {
  storage.getSettings().catch(() => {});
  // Content scripts already in open tabs belong to the old version; give every frame the new one.
  reinject(chrome.tabs, chrome.scripting);
  // Only a first install: an update or a browser update opens nothing.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#welcome') }).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.tabs.onRemoved.addListener((tabId) => { recorder.onTabRemoved(tabId); });

// Content scripts cannot read storage any more, so push key-free settings to every frame, each
// tab with the rule of its own site only.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const next = changes.settings?.newValue;
  if (areaName !== 'local' || !next || typeof next !== 'object') return;
  const migrated = migrateSettings(next);
  // Turning it off clears what is held (V27). Only the turn does: a later save while off has nothing to clear.
  if (changes.settings.oldValue?.keepHistory !== false && migrated.keepHistory === false) {
    history.clear().catch((err) => console.warn('VoiceType: could not clear history', err));
  }
  const pub = toPublicSettings(migrated);
  broadcast(chrome.tabs, (tab) => ({ action: MSG.SETTINGS_CHANGED, settings: { ...pub, site: ruleFor(migrated, tab.url) } }));
});

/** @returns {Promise<object>} what the sender gets back, an error included */
const answer = (request, sender) => handle(request, sender).then(
  (response) => response ?? { success: false, error: 'Unknown action' },
  (err) => ({ success: false, error: userMessage(err) }),
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  answer(request, sender).then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SAVE_PORT) return;
  port.onMessage.addListener(({ id, message }) => {
    answer(message, port.sender).then((reply) => {
      try {
        port.postMessage({ id, reply });
      } catch {
        // The page closed after its last post, which is what the port is for.
      }
    });
  });
});
