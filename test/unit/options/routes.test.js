import { describe, it, expect } from 'vitest';
import { ROUTES, HIDDEN_ROUTES, DEFAULT_ROUTE, parseRoute } from '../../../src/options/routes.js';

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

  it('a bare #settings opens Provider', () => {
    expect(parseRoute('#settings')).toBe('settings/provider');
  });

  it('unknown and malformed hashes resolve to home', () => {
    for (const hash of ['', '#', '#settings/', '#settings/provider/x', '#nope', '#%E0', '#HOME', '##home']) {
      expect(parseRoute(hash), hash).toBe('home');
    }
    expect(DEFAULT_ROUTE).toBe('home');
  });

  it('sidebar order matches the spec', () => {
    expect(ROUTES.map((r) => r.title)).toEqual([
      'Home', 'Modes', 'Dictionary', 'History', 'Provider', 'Recording', 'Speech', 'Sites', 'Appearance', 'Sound and clipboard', 'Usage and data',
    ]);
    expect(Object.isFrozen(ROUTES)).toBe(true);
  });
});
