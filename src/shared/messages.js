// Message action names shared by background, content and popup.
export const MSG = Object.freeze({
  GET_SETTINGS: 'getSettings',
  SAVE_SETTINGS: 'saveSettings',
  CHECK_KEY: 'checkApiKey',
  VALIDATE_KEY: 'validateKey',
  TRANSCRIBE: 'transcribe',
  GET_USAGE: 'getUsageStats',
  CLEAR_USAGE: 'clearUsageStats',
  TOGGLE_RECORDING: 'toggle-recording',
});

/**
 * @typedef {{ action: 'transcribe', audioBase64: string, mimeType: string, mode: string, audioDuration: number }} TranscribeRequest
 * @typedef {{ success: true, text: string, raw: string, cost: number } | { success: false, error: string }} TranscribeResponse
 * @typedef {{ action: 'validateKey', provider: 'openai'|'gemini', key: string }} ValidateKeyRequest
 */
