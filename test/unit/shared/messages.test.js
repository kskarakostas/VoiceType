import { describe, it, expect } from 'vitest';
import { MSG } from '../../../src/shared/messages.js';

// The Message contract table of the Phase 1 plan, key by key.
const CONTRACT = {
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
};

describe('MSG', () => {
  it('holds every key of the message contract with its value', () => {
    expect(MSG).toMatchObject(CONTRACT);
  });

  it('gives every action a unique value', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MSG)).toBe(true);
  });

  it('holds exactly the contract: the legacy v2.0 content actions are gone', () => {
    expect(MSG).toEqual(CONTRACT);
    for (const legacy of ['checkApiKey', 'transcribe', 'toggle-recording']) expect(Object.values(MSG)).not.toContain(legacy);
  });
});
