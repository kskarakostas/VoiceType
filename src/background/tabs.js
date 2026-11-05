// Service worker helpers for talking to tabs. The chrome APIs are passed in so they stay testable.

/** Tabs whose content scripts are orphaned by an install or update and can take the new one. */
export const REINJECT_URLS = Object.freeze(['http://*/*', 'https://*/*', 'file:///*']);

/** Errors that mean nobody is listening in that frame (it navigated, closed, went into the back-forward cache or never had us). */
const NO_RECEIVER = /Receiving end does not exist|No tab with id|back\/forward cache/i;

/**
 * Send every frame of every tab the message built for that tab. Tabs without a receiver are
 * skipped; never rejects.
 * @param {{ query: (info: object) => Promise<Array<{ id?: number, url?: string }>>, sendMessage: (tabId: number, message: unknown) => Promise<unknown> }} tabsApi
 * @param {(tab: { id?: number, url?: string }) => unknown} messageFor
 * @returns {Promise<void>}
 */
export async function broadcast(tabsApi, messageFor) {
  let tabs;
  try {
    tabs = await tabsApi.query({});
  } catch {
    return;
  }
  const targets = tabs.filter((tab) => typeof tab.id === 'number');
  await Promise.all(targets.map((tab) => tabsApi.sendMessage(tab.id, messageFor(tab)).catch(() => {})));
}

/**
 * Send a message to one frame, or to one document of it. Resolves false only when it has no
 * receiver; a listener that answers nothing still counts as delivered. The frame stays beside
 * documentId: by documentId alone, Chromium leaves a send to a document in the back-forward cache
 * pending with no answer, where the two together are refused at once like any document gone.
 * @param {{ sendMessage: (tabId: number, message: unknown, options: { frameId: number, documentId?: string }) => Promise<unknown> }} tabsApi
 * @param {{ tabId: number, frameId: number, documentId?: string }} endpoint
 * @param {unknown} message
 * @returns {Promise<boolean>}
 */
export async function sendToFrame(tabsApi, { tabId, frameId, documentId }, message) {
  try {
    await tabsApi.sendMessage(tabId, message, documentId ? { frameId, documentId } : { frameId });
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
