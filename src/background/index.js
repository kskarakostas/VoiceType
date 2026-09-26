// VoiceType service worker. Listeners only; logic lives in router.js and pipeline.js.
import { MSG } from '../shared/messages.js';
import { createStorage } from './storage.js';
import { createRouter, userMessage } from './router.js';
import { runDictation, ADAPTERS } from './pipeline.js';
import { applyUsage, summarize } from './usage.js';

const storage = createStorage(chrome.storage.local);

async function validateKey(provider, key) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter.validateKey({ key, signal: AbortSignal.timeout(15_000) });
}

/** Send toggle to the active tab, injecting the content script if it is not there. */
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING });
  } catch {
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

const handle = createRouter({ storage, runDictation, validateKey, applyUsage, summarize, toggleActiveTab });

chrome.runtime.onInstalled.addListener(() => { storage.getSettings().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.commands.onCommand.addListener((command) => {
  if (command === MSG.TOGGLE_RECORDING) toggleActiveTab().catch(() => {});
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  handle(request).then(
    (response) => sendResponse(response ?? { success: false, error: 'Unknown action' }),
    (err) => sendResponse({ success: false, error: userMessage(err) }),
  );
  return true; // keep the channel open for the async response
});
