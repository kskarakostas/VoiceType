// Hash routes of the settings page. A reload keeps the place, and the popup opens a page by its
// hash (`options.html#settings/provider`).

/** Sidebar entries in display order; `id` is the hash without its `#`. */
export const ROUTES = Object.freeze([
  { id: 'home', title: 'Home' },
  { id: 'modes', title: 'Modes' },
  { id: 'dictionary', title: 'Dictionary' },
  { id: 'settings/provider', title: 'Provider' },
  { id: 'settings/recording', title: 'Recording' },
  { id: 'settings/speech', title: 'Speech' },
  { id: 'settings/sites', title: 'Sites' },
  { id: 'settings/appearance', title: 'Appearance' },
  { id: 'settings/sound', title: 'Sound and clipboard' },
  { id: 'settings/usage', title: 'Usage and data' },
].map((route) => Object.freeze(route)));

export const DEFAULT_ROUTE = 'home';

const ROUTE_IDS = new Set(ROUTES.map((route) => route.id));

/**
 * The route a location hash opens. Route ids are ASCII, so the hash is compared as is and never
 * decoded: an unknown, malformed or percent-encoded hash opens Home.
 * @param {string} hash `location.hash`, with or without its leading `#`
 * @returns {string} a route id
 */
export function parseRoute(hash) {
  const id = String(hash ?? '').replace(/^#/, '');
  if (id === 'settings') return 'settings/provider';
  return ROUTE_IDS.has(id) ? id : DEFAULT_ROUTE;
}
