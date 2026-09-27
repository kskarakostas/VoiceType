// VoiceType service worker. Listeners and wiring only; logic lives in the imported modules.
import { MSG } from '../shared/messages.js';
import { migrateSettings, toPublicSettings } from '../shared/defaults.js';
import { createStorage } from './storage.js';
import { createRouter, createValidateKey, senderKind, userMessage } from './router.js';
import { ADAPTERS } from './pipeline.js';
import { summarize } from './usage.js';
import { broadcast } from './tabs.js';

// Keys live in storage.local; only the service worker and extension pages may read it.
(async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    console.warn('VoiceType: could not restrict storage access', err);
  }
})();

const storage = createStorage(chrome.storage.local);

// Recording moves to the offscreen recorder; until it is wired every recording request fails cleanly.
const unavailable = async () => ({ ok: false, reason: 'micError', error: 'Recording is not available yet.' });
const recorder = {
  start: unavailable, stop: unavailable, cancel: unavailable, onLevel: unavailable,
  onDone: unavailable, onOffscreenError: unavailable, onPermissionResult: unavailable, onTabRemoved: unavailable,
};

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

/** Send toggle to the active tab, injecting the content script if it is not there. */
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  try {
    // Always ask first: tab.url can be missing without a host permission for the page.
    await chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING });
  } catch {
    // No content script answered. Inject only into pages content scripts can run on.
    if (!/^(https?|file):/.test(tab.url || '')) return false;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      setTimeout(() => { chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING }).catch(() => {}); }, 150);
    } catch {
      // Page forbids injection (browser UI, store pages). Nothing to do.
    }
  }
  return true;
}

chrome.runtime.onInstalled.addListener(() => { storage.getSettings().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.commands.onCommand.addListener((command) => {
  if (command === MSG.TOGGLE_RECORDING) toggleActiveTab().catch(() => {});
});

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
