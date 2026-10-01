export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random wait (ms) between [min, max] seconds, so the bot doesn't hit Google at a robotic pace. */
export function randomDelayMs([min, max] = [4, 9]) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

/** OpenStreetMap services ask every app to identify itself. */
export function botUserAgent() {
  const repo = process.env.GITHUB_REPOSITORY;
  return `WebsiteHuntingBot/1.0 (+${repo ? `https://github.com/${repo}` : 'personal lead-finding bot'})`;
}

/** Service addresses. The env overrides exist only so tests can point the bot at a fake server. */
export function endpoints() {
  const list = (value, fallback) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback);
  return {
    nominatim: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    overpass: list(process.env.OVERPASS_URLS, [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]),
    maps: process.env.MAPS_BASE_URL || 'https://www.google.com/maps',
    google: process.env.GOOGLE_BASE_URL || 'https://www.google.com',
    brave: process.env.BRAVE_BASE_URL || 'https://search.brave.com',
    braveApi: process.env.BRAVE_API_URL || 'https://api.search.brave.com',
    startpage: process.env.STARTPAGE_BASE_URL || 'https://www.startpage.com',
    bing: process.env.BING_BASE_URL || 'https://www.bing.com',
    duckduckgo: process.env.DDG_BASE_URL || 'https://html.duckduckgo.com',
  };
}

export const today = () => new Date().toISOString().slice(0, 10);
