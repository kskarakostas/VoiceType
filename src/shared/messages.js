// Message action names shared by background, offscreen, content and popup.
// Every message is { action: MSG.X, ...payload }; the plan's Message contract lists who sends what.
export const MSG = Object.freeze({
  GET_SETTINGS: 'getSettings',
  SAVE_SETTINGS: 'saveSettings',
  UPDATE_SETTINGS: 'updateSettings',
  VALIDATE_KEY: 'validateKey',
  GET_USAGE: 'getUsageStats',
  CLEAR_USAGE: 'clearUsageStats',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  CANCEL_RECORDING: 'cancelRecording',
  SETTINGS_CHANGED: 'settingsChanged',
  AUDIO_LEVEL: 'audioLevel',
  RECORDING_STATE: 'recordingState',
  DICTATION_RESULT: 'dictationResult',
  OFFSCREEN_START: 'offscreenStart',
  OFFSCREEN_STOP: 'offscreenStop',
  OFFSCREEN_LEVEL: 'offscreenLevel',
  OFFSCREEN_DONE: 'offscreenDone',
  OFFSCREEN_ERROR: 'offscreenError',
  PERMISSION_RESULT: 'permissionResult',
  // Legacy v2.0 content path; removed in Task 11.
  CHECK_KEY: 'checkApiKey',
  TRANSCRIBE: 'transcribe',
  TOGGLE_RECORDING: 'toggle-recording',
});

/**
 * @typedef {'noKey'|'busy'|'needsPermission'|'denied'|'micError'} StartFailure
 * @typedef {{ ok: true } | { ok: false, reason: StartFailure, error: string }} StartResponse
 * @typedef {{ text: string, tone: 'info'|'success'|'warning'|'error' }} Notice
 * @typedef {{ state: 'idle'|'processing', reason?: 'maxTime'|'silence'|'ended'|'error'|'permission', notice?: Notice }} RecordingStatePayload
 * @typedef {{ success: true, text: string, raw: string, cost: number, warning: string|null }
 *   | { success: false, error: string, tone: 'warning'|'error' }} DictationMessage
 * @typedef {{ ok: true } | { ok: false, reason: 'needsPermission'|'denied'|'micError', error: string }} OffscreenStartResponse
 * @typedef {{ audioBase64: string, mimeType: string, durationSec: number, reason: 'user'|'maxTime'|'silence'|'ended' }} OffscreenDone
 */
