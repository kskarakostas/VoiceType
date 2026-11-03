// Opens the settings page at a hash route from the popup (V6). runtime.openOptionsPage() takes no
// route, so the popup finds an open settings tab itself and reuses it, or opens a new one.

/**
 * Focus the open settings tab, at `route` when one is given, or open a new tab at `route` (Home
 * when null). The tab is found by its document URL without the fragment: getContexts reports
 * the URL with the hash, and its `documentUrls` filter is an exact match that would miss it.
 * A hash-only change in the open tab is a same-document navigation; the page follows hashchange.
 * When that tab cannot be updated a new tab opens instead. Rejects when no tab could be opened.
 * @param {{ runtime: typeof chrome.runtime, tabs: typeof chrome.tabs, windows: typeof chrome.windows }} apis
 * @param {string|null} route a hash route without '#', or null to keep an open tab's route
 * @returns {Promise<void>}
 */
export async function openSettings({ runtime, tabs, windows }, route) {
  const base = runtime.getURL('options.html');
  let contexts = [];
  try {
    contexts = await runtime.getContexts({ contextTypes: ['TAB'] });
  } catch {
    // No contexts known: open a new tab.
  }
  const open = (contexts ?? []).find((context) => context.documentUrl?.split('#')[0] === base);
  const create = () => tabs.create({ url: `${base}#${route ?? 'home'}` });
  if (!open) {
    await create();
    return;
  }
  try {
    await tabs.update(open.tabId, route ? { active: true, url: `${base}#${route}` } : { active: true });
  } catch {
    // The tab closed or cannot be reached: open a new one instead.
    await create();
    return;
  }
  try {
    await windows.update(open.windowId, { focused: true });
  } catch {
    // The tab is already active in its window.
  }
}
