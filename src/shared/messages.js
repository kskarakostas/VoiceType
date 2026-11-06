// Message action names shared by background, offscreen, content and popup.
// Every message is { action: MSG.X, ...payload }; the plan's Message contract lists who sends what.
// For the offscreen messages the typedefs below are the contract and supersede the plan's table.
/** The port a settings page holds while it types: a post from a closing page lands, a message may not. */
export const SAVE_PORT = 'settings-save';

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
  SET_SITE_MODE: 'setSiteMode',
  SET_SITE_RULE: 'setSiteRule',
  OFFSCREEN_CUE: 'offscreenCue',
  OFFSCREEN_COPY: 'offscreenCopy',
  FRAME_SIGHT: 'frameSight',
  RECORDING_MIRROR: 'recordingMirror',
  GET_LAST_DICTATION: 'getLastDictation',
  GET_HISTORY: 'getHistory',
  CLEAR_HISTORY: 'clearHistory',
  PROCESSING_PING: 'processingPing',
});

/**
 * @typedef {'noKey'|'busy'|'needsPermission'|'denied'|'micError'|'badEdit'} StartFailure
 * @typedef {{ ok: true } | { ok: false, reason: StartFailure, error: string }} StartResponse
 * @typedef {{ text: string, tone: 'info'|'success'|'warning'|'error' }} Notice
 * @typedef {{ state: 'idle'|'processing', reason?: 'maxTime'|'silence'|'ended'|'error'|'permission', notice?: Notice }} RecordingStatePayload
 * @typedef {{ success: true, text: string, raw: string, cost: number, warning: string|null, copied: boolean|null, edit?: true }
 *   | { success: false, error: string, tone: 'warning'|'error', edit?: true, instruction?: string }} DictationMessage
 * `copied` is null when always-copy is off. `edit` marks an edit's result. A failed edit (V46) adds
 * `instruction`, what the user said; a failure before there is one is a plain failure.
 * @typedef {{ ok: true } | { ok: false, reason: 'needsPermission'|'denied', error: string }
 *   | { ok: false, reason: 'micError', error: string, cancelled?: true }} OffscreenStartResponse
 * Offscreen messages carry the service worker's id for one capture: a stop names the capture it
 * stops, and every report names the capture it came from, so a late report never reaches a newer session.
 * @typedef {{ maxSec: number, silenceSec: number, captureId: string }} OffscreenStart
 * @typedef {{ discard: boolean, captureId: string }} OffscreenStop
 * @typedef {{ level: number, captureId: string }} OffscreenLevel
 * @typedef {{ audioBase64: string, mimeType: string, durationSec: number, reason: 'user'|'maxTime'|'silence'|'ended', captureId: string }} OffscreenDone
 * `empty` marks a capture that ended with no audio and no recorder error; it comes with the duration.
 * @typedef {{ error: string, captureId: string, empty?: true, durationSec?: number }} OffscreenError
 * @typedef {'start'|'stop'|'done'|'error'} CueName
 * Both answer { ok: boolean }. `set` is the recording's sound set (V62); the offscreen document plays Soft for a missing or unknown one.
 * @typedef {{ cue: CueName, set?: import('./defaults.js').Settings['soundSet'] }} OffscreenCue
 * @typedef {{ text: string }} OffscreenCopy
 * The rule of the top-level page. Content scripts get this one rule, never `siteRules`.
 * @typedef {{ hidePill: boolean, mode: string|null }} SiteState
 * @typedef {import('./defaults.js').PublicSettings & { site: SiteState }} ContentSettings
 * A subframe's recording indicator came into or went out of the top-level viewport.
 * @typedef {{ seen: boolean }} FrameSight
 * What frame 0 shows for a subframe recording out of sight.
 * @typedef {{ state: 'recording'|'processing'|'idle', elapsedMs: number }} RecordingMirror
 * What a content script may know of the history: the last dictation on its own site, these three fields only.
 * @typedef {{ entry: { raw: string, text: string, edit: boolean } | null }} LastDictation
 */
