// ─────────────────────────────────────────────────────────────
//  WEBSITE HUNTING BOT · SETTINGS
//  Change the values below, then tap "Commit changes".
//  Keep the quote marks '...' and the comma at the end of each line.
// ─────────────────────────────────────────────────────────────

export default {
  // Where to hunt. Any city in the world works.
  city: 'Nashville', // Tennessee
  country: 'United States',

  // 0 = the whole city (or 5 km around `center` below, if you set one).
  // Or a number like 5 = only businesses within 5 km of the city centre (or of `center` below).
  radiusKm: 0,

  // Optional: an exact centre point, e.g. a busy market.
  // On Google Maps, long-press the spot and copy the two numbers, like this:
  // center: { lat: 31.5204, lon: 74.3587 },
  center: null,

  // Types of businesses to look for. Full list in README.md.
  // You can also use any OpenStreetMap tag, like 'shop=bicycle'.
  categories: ['restaurant', 'cafe', 'bakery', 'salon', 'dentist', 'clinic', 'gym', 'car_repair', 'clothes', 'real_estate'],

  // How many businesses to check each run. 20–40 is safe. Higher = more likely Google blocks the bot.
  maxChecksPerRun: 30,

  // Skip big chains like KFC or McDonald's. They always have websites.
  skipChains: true,

  // Your country's calling code, used to make WhatsApp links. USA = '1', UK = '44', Pakistan = '92'.
  phoneCountryCode: '1',

  // Web search engines for layer 3, tried in this order. If one blocks the bot, it moves to the next.
  // Options: 'google', 'brave', 'startpage', 'bing', 'duckduckgo'.
  // Brave never blocks if you add a free BRAVE_API_KEY secret (see README).
  searchEngines: ['google', 'brave', 'startpage', 'bing', 'duckduckgo'],

  // If Google Maps can't be read (blocked or changed):
  //   true  = check nothing that run, so you never get half-checked leads
  //   false = still check with OpenStreetMap + web search (leads get a warning note)
  requireMapsCheck: true,

  // If every web search engine blocks the bot:
  //   true  = stop checking for that run (leads are always checked 3 ways)
  //   false = keep going with OpenStreetMap + Google Maps only (those leads get a "double-check" note)
  requireWebSearch: true,

  // Random pause between checks, in seconds [min, max]. Slower = less chance of being blocked.
  delaySeconds: [4, 9],

  // Send a Discord summary even when there are no new leads (so you know it ran).
  postSummaryWhenEmpty: true,
};
