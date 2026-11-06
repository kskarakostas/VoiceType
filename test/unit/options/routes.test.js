import { describe, it, expect } from 'vitest';
import { ROUTES, SETTINGS_PARTS, HIDDEN_ROUTES, DEFAULT_ROUTE, parseRoute, pageOf } from '../../../src/options/routes.js';

describe('settings page routes', () => {
  it('known routes resolve to themselves', () => {
    for (const { id } of ROUTES) expect(parseRoute(`#${id}`)).toBe(id);
  });

  it('Welcome is a known route outside the sidebar list', () => {
    expect(HIDDEN_ROUTES).toEqual([{ id: 'welcome', title: 'Welcome' }]);
    expect(Object.isFrozen(HIDDEN_ROUTES)).toBe(true);
    expect(parseRoute('#welcome')).toBe('welcome');
    expect(ROUTES.map((r) => r.id)).not.toContain('welcome');
  });

  it.each(SETTINGS_PARTS.map((r) => r.id))('%s lives on the Settings page', (id) => {
    expect(parseRoute(`#${id}`)).toBe(id);
    expect(pageOf(id)).toBe('settings');
  });

  it('the other pages are their own', () => {
    for (const id of ['home', 'modes', 'dictionary', 'history', 'welcome']) expect(pageOf(id)).toBe(id);
  });

  it('a bare #settings is the Settings page itself', () => {
    expect(parseRoute('#settings')).toBe('settings');
    expect(pageOf('settings')).toBe('settings');
  });

  it('unknown and malformed hashes resolve to home', () => {
    for (const hash of ['', '#', '#settings/', '#settings/provider/x', '#nope', '#%E0', '#HOME', '##home']) {
      expect(parseRoute(hash), hash).toBe('home');
    }
    expect(DEFAULT_ROUTE).toBe('home');
  });

  it('sidebar order matches the spec', () => {
    expect(ROUTES.map((r) => r.title)).toEqual([
      'Home', 'Modes', 'Dictionary', 'History', 'Settings',
    ]);
    expect(Object.isFrozen(ROUTES)).toBe(true);
  });

  it('the parts of the Settings page keep their order and their old hashes', () => {
    expect(SETTINGS_PARTS.map((r) => r.id)).toEqual([
      'settings/provider', 'settings/recording', 'settings/speech', 'settings/sites', 'settings/appearance', 'settings/sound', 'settings/usage',
    ]);
    expect(SETTINGS_PARTS.map((r) => r.title)).toEqual([
      'Provider', 'Recording', 'Speech', 'Sites', 'Appearance', 'Sound and clipboard', 'Usage and data',
    ]);
    expect(Object.isFrozen(SETTINGS_PARTS)).toBe(true);
  });
});
