// VoiceType service worker. Listeners and wiring only; logic lives in the imported modules.
import { MSG } from '../shared/messages.js';
import { migrateSettings, toPublicSettings } from '../shared/defaults.js';
import { createStorage } from './storage.js';
import { createRouter, createValidateKey, senderKind, userMessage } from './router.js';
import { runDictation, ADAPTERS } from './pipeline.js';
import { applyUsage, summarize } from './usage.js';
import { createDictate } from './dictate.js';
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
const offscreenClient = createOffscreenClient({ runtime: chrome.runtime, offscreen: chrome.offscreen });
const recorder = createRecorder({
  ensureOffscreen: () => offscreenClient.ensure(),
  toOffscreen: (message) => offscreenClient.send(message),
  toTab: (endpoint, message) => sendToFrame(chrome.tabs, endpoint, message),
  openPermissionPage: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }); },
  getSettings: () => storage.getSettings(),
  dictate: createDictate({ storage, runDictation, applyUsage, userMessage }),
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
  identify: (sender) => senderKind(sender, { extensionId: chrome.runtime.id, extensionOrigin, offscreenUrl }),
});

chrome.runtime.onInstalled.addListener(() => {
  storage.getSettings().catch(() => {});
  // Content scripts already in open tabs belong to the old version; give every frame the new one.
  reinject(chrome.tabs, chrome.scripting);
});
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.tabs.onRemoved.addListener((tabId) => { recorder.onTabRemoved(tabId); });

// Content scripts cannot read storage any more, so push key-free settings to every frame.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const next = changes.settings?.newValue;
  if (areaName !== 'local' || !next || typeof next !== 'object') return;
  broadcast(chrome.tabs, { action: MSG.SETTINGS_CHANGED, settings: toPublicSettings(migrateSettings(next)) });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handle(request, sender).then(
    (response) => sendResponse(response ?? { success: false, error: 'Unknown action' }),
    (err) => sendResponse({ success: false, error: userMessage(err) }),
  );
  return true; // keep the channel open for the async response
});
