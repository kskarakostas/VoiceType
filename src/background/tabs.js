// Service worker helpers for talking to tabs. The chrome APIs are passed in so they stay testable.

/** Tabs whose content scripts are orphaned by an install or update and can take the new one. */
export const REINJECT_URLS = Object.freeze(['http://*/*', 'https://*/*', 'file:///*']);

/** Errors that mean nobody is listening in that frame (it navigated, closed or never had us). */
const NO_RECEIVER = /Receiving end does not exist|No tab with id/i;

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

/**
 * Send a message to one frame. Resolves false only when the frame has no receiver; a listener
 * that answers nothing still counts as delivered.
 * @param {{ sendMessage: (tabId: number, message: unknown, options: { frameId: number }) => Promise<unknown> }} tabsApi
 * @param {{ tabId: number, frameId: number }} endpoint
 * @param {unknown} message
 * @returns {Promise<boolean>}
 */
export async function sendToFrame(tabsApi, { tabId, frameId }, message) {
  try {
    await tabsApi.sendMessage(tabId, message, { frameId });
    return true;
  } catch (err) {
    return !NO_RECEIVER.test(String(err?.message ?? err));
  }
}

/**
 * Inject content.js into every frame of every open web and file tab. Pages that refuse
 * injection (the Web Store, file URLs without access) are skipped; never rejects.
 * @param {{ query: (info: { url: string[] }) => Promise<Array<{ id?: number }>> }} tabsApi
 * @param {{ executeScript: (injection: { target: { tabId: number, allFrames: boolean }, files: string[] }) => Promise<unknown> }} scriptingApi
 * @returns {Promise<void>}
 */
export async function reinject(tabsApi, scriptingApi) {
  let tabs;
  try {
    tabs = await tabsApi.query({ url: REINJECT_URLS });
  } catch {
    return;
  }
  const ids = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
  await Promise.all(ids.map((tabId) => scriptingApi
    .executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    .catch(() => {})));
}
