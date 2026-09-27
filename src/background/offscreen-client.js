const JUSTIFICATION = 'Record dictation audio from the microphone.';

/**
 * The one offscreen document that records audio. Chrome allows a single offscreen document per
 * extension, so creation is shared between concurrent callers, and the "single offscreen document"
 * rejection (a create that raced ours, or one this worker forgot after a restart) counts as success.
 * @param {{
 *   runtime: Pick<typeof chrome.runtime, 'getContexts'|'getURL'|'sendMessage'>,
 *   offscreen: Pick<typeof chrome.offscreen, 'createDocument'>,
 *   path?: string,
 * }} deps
 * @returns {{ ensure: () => Promise<void>, send: (message: object) => Promise<any> }}
 */
export function createOffscreenClient({ runtime, offscreen, path = 'offscreen.html' }) {
  /** @type {Promise<void>|null} */
  let creating = null;

  async function ensure() {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
    if (!creating) {
      creating = offscreen
        .createDocument({ url: runtime.getURL(path), reasons: ['USER_MEDIA'], justification: JUSTIFICATION })
        .catch((err) => {
          if (!/single offscreen document/i.test(String(err?.message ?? err))) throw err;
        })
        .finally(() => { creating = null; });
    }
    await creating;
  }

  return {
    ensure,
    send: (message) => runtime.sendMessage(message),
  };
}
