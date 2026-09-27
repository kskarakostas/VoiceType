// Service worker helpers for talking to tabs. The chrome.tabs API is passed in so they stay testable.

/**
 * Send a message to every frame of every tab. Tabs without a receiver are skipped; never rejects.
 * @param {{ query: (info: object) => Promise<Array<{ id?: number }>>, sendMessage: (tabId: number, message: unknown) => Promise<unknown> }} tabsApi
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function broadcast(tabsApi, message) {
  let tabs;
  try {
    tabs = await tabsApi.query({});
  } catch {
    return;
  }
  const ids = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
  await Promise.all(ids.map((id) => tabsApi.sendMessage(id, message).catch(() => {})));
}
