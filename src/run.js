// One full run: OpenStreetMap → Google Maps → web search → Discord.

import { resolveCategories } from './categories.js';
import { resolveArea, fetchCandidates, pickQueue } from './overpass.js';
import { launchBrowser } from './browser.js';
import { checkMaps, mapsSelfTest } from './maps.js';
import { discoverOnMaps, toCandidate } from './discover.js';
import { createSearcher, engineLabel, ENGINE_NAMES } from './search.js';
import { analyzeResults, classifyUrl, compact, hostOf, prettySite, siteMatchesBusiness, toWhatsApp } from './matching.js';
import { buildMessages, sendMessages } from './discord.js';
import { appendLead, loadState, saveState, writeLastRun, writeRunLeads } from './storage.js';
import { leadsText } from './share.js';
import { findSocials, orderSocials, socialProfile } from './socials.js';
import { FREE_MAIL, confirmByPhone, confirmSite, fetchPage, phonePattern, siteOrigins, streetOf } from './verify.js';
import { loadRecheck, recheckCandidate, saveRecheck } from './recheck.js';
import { emailFrom, factsFromPage, listingsFrom, sinceFrom, socialActivityFrom } from './details.js';
import { aiFindWebsite, aiPickListing, aiSiteBelongs, createAi, visibleText } from './ai.js';
import { endpoints, randomDelayMs, sleep, today } from './util.js';

const KNOWN_ENGINES = ENGINE_NAMES; // google, brave, startpage, bing, duckduckgo

const DEFAULTS = {
  city: '',
  country: '',
  radiusKm: 0,
  center: null,
  categories: ['restaurant'],
  maxChecksPerRun: 30,
  skipChains: true,
  phoneCountryCode: '',
  searchEngines: KNOWN_ENGINES,
  requireMapsCheck: true,
  requireWebSearch: true,
  mapsDiscovery: true, // when OpenStreetMap runs short, find more businesses by searching Google Maps
  findSocials: true, // search for each lead's Instagram (and Facebook) page
  recheck: false, // recheck earlier leads (data/recheck.json) instead of finding new ones
  phoneCheck: true, // a site with the business's phone number on it is theirs, whatever its name
  findEmail: true, // look for each lead's email (one more search when the others didn't show it)
  ai: true, // Gemini double-checks Maps listings and websites (needs GEMINI_API_KEY; skipped without it)
  aiMaxCalls: 250, // AI questions (Google searches included) per run at most
  aiMinIntervalMs: 6500, // the free tier allows 10 questions a minute
  mapsSearch: [], // extra Google Maps searches, e.g. ['roofers'] (the Run workflow form's "any business type" box)
  delaySeconds: [4, 9],
  postSummaryWhenEmpty: true,
  // Fixed on purpose (not in config.js):
  maxRunMinutes: 40, // stop starting new checks after this, so the GitHub job never times out
  maxAttempts: 3, // give up on a business that can't be verified after this many runs
  searchCooldownMinutes: 5, // a search engine that blocks the bot gets one more try after this break
  selfTest: true, // check a known place first, so a broken/blocked Google never produces fake leads
};

export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };
  const notes = [];
  cfg.city = String(cfg.city || '').trim();
  cfg.country = String(cfg.country || '').trim();
  if (!cfg.city) throw new Error('config.js: `city` is empty. Set it to the city you want to search.');
  cfg.radiusKm = Math.max(0, Number(cfg.radiusKm) || 0);
  cfg.maxChecksPerRun = Math.min(200, Math.max(1, Math.round(Number(cfg.maxChecksPerRun) || 30)));
  const delays = Array.isArray(cfg.delaySeconds) ? cfg.delaySeconds : [cfg.delaySeconds, cfg.delaySeconds];
  cfg.delaySeconds = [Number(delays[0]) || 0, Number(delays[1] ?? delays[0]) || 0];
  cfg.phoneCountryCode = String(cfg.phoneCountryCode || '').replace(/\D/g, '');
  cfg.requireWebSearch = cfg.requireWebSearch !== false;
  cfg.mapsDiscovery = cfg.mapsDiscovery !== false;
  cfg.findSocials = cfg.findSocials !== false;
  cfg.phoneCheck = cfg.phoneCheck !== false;
  cfg.findEmail = cfg.findEmail !== false;
  cfg.ai = cfg.ai !== false;
  cfg.recheck = cfg.recheck === true;
  if (cfg.recheck) {
    // Earlier leads come from many cities; each keeps its own city and country.
    cfg.city = 'Earlier leads';
    cfg.country = '';
  }
  cfg.mapsSearch = (Array.isArray(cfg.mapsSearch) ? cfg.mapsSearch : [cfg.mapsSearch])
    .map((t) => String(t ?? '').trim()).filter(Boolean);
  const engines = (Array.isArray(cfg.searchEngines) ? cfg.searchEngines : [cfg.searchEngines])
    .map((e) => String(e).toLowerCase().trim());
  const unknown = engines.filter((e) => !KNOWN_ENGINES.includes(e));
  if (unknown.length) notes.push(`Unknown search engines ignored: ${unknown.join(', ')}`);
  const valid = [...new Set(engines.filter((e) => KNOWN_ENGINES.includes(e)))];
  cfg.searchEngines = valid.length ? valid : KNOWN_ENGINES;
  return { cfg, notes };
}

const placeName = (cfg) => `${cfg.city}${cfg.country ? `, ${cfg.country}` : ''}`;

function websiteNote(site) {
  const name = prettySite(site.host);
  if (site.kind === 'dead') return 'Their Google Maps "website" is an old Google site (shut down in 2024)';
  if (site.kind === 'social') return `Their Google Maps "website" is just a ${name} page`;
  return `Their Google Maps "website" is a ${name} listing, not their own site`;
}

/**
 * A lead's Instagram (and Facebook, when it comes up too): one more search, e.g.
 * "Roy's Plumbing Abbeville instagram". Only profiles that are clearly this business are kept.
 */
/** For a run over a whole state, the business's own town from its address ("…, Abbeville, MS 38601"). */
function townOf(biz, address) {
  const parts = String(address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const inCity = compact(address).includes(compact(biz.city));
  return (!inCity && parts.length >= 3 && !/\d/.test(parts.at(-2)) ? parts.at(-2) : null) || biz.city;
}

// Returns { urls: the new profiles, results: all search results looked at }.
async function findSocialPages(biz, known, address, ctx) {
  const has = (network) => known.some((url) => socialProfile(url)?.network === network);
  const town = townOf(biz, address);
  const found = [];
  const seen = []; // every result, for the card's extra details (followers, other listings)
  // One search, for Instagram: free search engines block the bot after a few dozen searches, so each one
  // counts. Facebook pages usually come up in it (or in the name search) anyway.
  if (!has('instagram')) {
    await sleep(ctx.delay());
    const results = await ctx.searcher.find([biz.searchName, town, 'instagram'].filter(Boolean).join(' '));
    if (results) { // null: every engine is busy; not worth stopping the run for
      seen.push(...results);
      found.push(...findSocials(results, biz).filter((p) => !has(p.network)));
    }
  }
  for (const p of found) ctx.log(`   📱 ${p.label}: ${p.display}`);
  return { urls: found.map((p) => p.url), results: seen };
}

// Universities, hospitals, councils, schools and the like have their organisation's website: not leads.
// Only clear signs: "County Line BBQ" or "State of Grace" are real small businesses.
export const INSTITUTION_NAME = /\b(university|school of|school district|isd|hospital|health system|department of|dept\.? of|city of|police department|fire department|public library|embassy|consulate)\b/i;

/**
 * Google Maps showed other names for the search (a longer name, the owner's name…): the AI says which, if
 * any, is this business, and that listing is read instead.
 */
async function aiMatchListing(biz, maps, ctx) {
  const options = maps.shown
    ? [{ label: maps.shown.title, detail: [maps.shown.category, maps.shown.address].filter(Boolean).join(', ') }]
    : (maps.candidates || []).map((c) => ({ label: c.label }));
  if (!options.length) return maps;
  const who = { name: biz.name, category: biz.categoryLabel, address: biz.address, city: biz.city || ctx.cfg.city, country: ctx.cfg.country, phones: biz.phone ? [biz.phone] : [] };
  const i = await aiPickListing(ctx.ai, who, options);
  if (i === null) return maps;
  ctx.log(`   🤖 AI: it's on Google Maps as "${options[i].label}"`);
  if (maps.shown) return { status: 'found', ...maps.shown };
  const again = await checkMaps(ctx.mapsPage, { ...biz, placeUrl: maps.candidates[i].href, names: [...(biz.names || [biz.name]), options[i].label] }, { mapsBase: ctx.ep.maps });
  await sleep(ctx.delay());
  return again.status === 'found' ? again : maps;
}

async function checkBusiness(biz, ctx) {
  const { cfg, ep, mapsPage, searcher, delay, warnings } = ctx;
  const notes = [];
  const aiCallsBefore = ctx.ai?.state.calls || 0;
  let maps = null;
  if (INSTITUTION_NAME.test(biz.name)) return { status: 'excluded', reason: 'part of a larger organisation (university, hospital, council…)' };

  // ── Layer 2: Google Maps ──
  if (ctx.mapsOn) {
    maps = await checkMaps(mapsPage, biz, { mapsBase: ep.maps });
    if (maps.status === 'blocked') {
      ctx.mapsOn = false;
      maps = null;
      if (cfg.requireMapsCheck) {
        warnings.push('Google Maps started blocking the bot mid-run, so it stopped early. The rest will be checked next run.');
        return { status: 'skipped', stop: true };
      }
      warnings.push('Google Maps started blocking the bot mid-run. The rest were checked with web search only.');
    } else if (maps.status === 'error') {
      return { status: 'unverified', reason: `Google Maps: ${maps.reason}` };
    } else {
      await sleep(delay());
      if (maps.status === 'not_found' && ctx.ai?.enabled) maps = await aiMatchListing(biz, maps, ctx);
    }
  }

  const cid = maps?.mapsUrl && (maps.mapsUrl.match(/[?&]cid=(\d+)/) || [])[1];
  if (cid) biz.mapsKey = `gmaps/${cid}`;

  if (!maps) notes.push("Google Maps wasn't checked this run, so double-check before pitching");
  else if (maps.status === 'not_found') notes.push('Not on Google Maps. You can also offer to set up their Google Business Profile');
  else {
    if (maps.permanentlyClosed) return { status: 'closed' };
    if (maps.website) {
      const site = classifyUrl(maps.website);
      if (!site || site.kind === 'website') return { status: 'has_website', layer: 2, website: site ? site.host : maps.website };
      notes.push(websiteNote(site));
    }
    // Their site can also be a "booking link" (spinkandspan.square.site) rather than the Website button.
    for (const link of maps.links || []) {
      const site = classifyUrl(link);
      if (site?.kind === 'website') return { status: 'has_website', layer: 2, website: site.host, how: 'their booking/menu link on Google Maps' };
      if (site && ['booking', 'delivery'].includes(site.kind)) notes.push(`Takes bookings/orders through ${prettySite(site.host)}`);
    }
    if (maps.temporarilyClosed) notes.push('Google Maps says it is temporarily closed');
    if (maps.claimable) notes.push('Their Google listing is unclaimed');
  }

  // ── Layer 3: web search ──
  let found = null;
  if (ctx.searchOn) {
    found = await searcher.search(biz);
    if (found.status !== 'ok') {
      if (!found.allDead) return { status: 'unverified', reason: 'web search failed' };
      ctx.searchOn = false;
      found = null;
      if (cfg.requireWebSearch) {
        warnings.push('Every search engine blocked the bot, so it stopped early. The rest will be checked next run.');
        return { status: 'skipped', stop: true };
      }
      warnings.push('Every search engine blocked the bot, so the rest were checked with OpenStreetMap + Google Maps only (those leads say "double-check").');
    }
  }
  const result = found ? analyzeResults(found.results, biz) : { hasWebsite: false, possible: [], socials: [] };
  if (result.hasWebsite) return { status: 'has_website', layer: 3, website: hostOf(result.website) };

  // A website named differently from the business (cpimemphis.com for "Culpepper Plumbing") only
  // shows itself by having their phone number on it: check the sites the search found, then search
  // for the number itself.
  const phoneForCheck = maps?.phoneTel || maps?.phone || biz.phone;
  const allResults = found ? [...found.results] : []; // for the card's extra details
  if (found && cfg.phoneCheck && phonePattern(phoneForCheck)) {
    let site = await confirmByPhone(siteOrigins(found.results), phoneForCheck);
    if (!site && ctx.searchOn) {
      await sleep(delay());
      const byPhone = await searcher.find(`"${maps?.phone || biz.phone || phoneForCheck}"`);
      if (byPhone) {
        allResults.push(...byPhone);
        site = await confirmByPhone(siteOrigins(byPhone), phoneForCheck);
      }
    }
    if (site) return { status: 'has_website', layer: 3, website: hostOf(site), how: 'their phone number is on it' };
  }
  for (const host of result.possible) notes.push(`Check first: ${host} might be their website`);
  if (!found) notes.push("Web search wasn't available, so double-check they don't have a website before pitching");

  const mapsSite = maps?.website ? classifyUrl(maps.website) : null;
  const phone = maps?.phone || biz.phone || null;
  const generic = biz.profile?.tokenSets?.length === 0;
  const socials = [...biz.socials, mapsSite?.kind === 'social' ? mapsSite.url : null,
    ...(found && !generic ? findSocials(found.results, biz).map((p) => p.url) : [])];
  // A name that's only the place and the trade ("Atlanta car detailing") matches anyone's Instagram.
  if (found && cfg.findSocials && biz.profile?.tokenSets?.length !== 0) {
    const extra = await findSocialPages(biz, socials, maps?.address || biz.address, ctx);
    socials.push(...extra.urls);
    allResults.push(...extra.results);
  }
  // ── What their listings say: every phone number, email and street address they go by ──
  // Directory pages (Yelp, Yellow Pages, BBB…) can list another number or address than Google Maps, and
  // often their email. Opening a page isn't a search, so it doesn't use up the search engines.
  const town = townOf(biz, maps?.address || biz.address);
  const facts = { phones: [], emails: [], streets: [], websites: [] };
  const digitsOf = (p) => String(p).replace(/\D/g, '').slice(-10);
  const addFacts = (f, from) => {
    const added = [];
    for (const k of Object.keys(facts)) {
      for (const v of f[k] || []) {
        const dup = k === 'phones' ? facts.phones.some((x) => digitsOf(x) === digitsOf(v)) : facts[k].some((x) => x.toLowerCase() === v.toLowerCase());
        if (v && !dup) {
          facts[k].push(v);
          added.push(k);
        }
      }
    }
    if (from && added.length) ctx.log(`   📇 Their ${from} listing: ${[...new Set(added)].map((k) => ({ phones: 'phone', emails: 'email', streets: 'address', websites: 'website' }[k])).join(', ')}`);
  };
  addFacts({
    phones: [maps?.phone || maps?.phoneTel, biz.phone].filter(Boolean),
    emails: [biz.email, emailFrom(allResults, biz)].filter(Boolean),
    streets: [streetOf(maps?.address), streetOf(biz.address)].filter(Boolean),
  });
  const readListings = async (results, max) => {
    for (const listing of listingsFrom(results, biz).slice(0, max)) {
      const html = await fetchPage(listing.url, { timeoutMs: 8000 });
      if (html) addFacts(factsFromPage(html, biz, listing.url), listing.name);
    }
  };
  if (found && (cfg.findEmail || cfg.phoneCheck) && !generic) await readListings(allResults, 4);
  // No email yet: one search for it (and the listing pages that brings up).
  if (!facts.emails.length && found && cfg.findEmail && ctx.searchOn && !generic) {
    await sleep(delay());
    const results = await searcher.find([biz.searchName, town, 'email'].filter(Boolean).join(' '));
    if (results) {
      allResults.push(...results);
      addFacts({ emails: [emailFrom(results, biz)].filter(Boolean) });
      if (!facts.emails.length) await readListings(results, 3);
    }
  }
  const email = cfg.findEmail ? facts.emails[0] || null : biz.email || null;
  if (email && !biz.email) ctx.log(`   ✉️ Email: ${email}`);
  const otherPhones = facts.phones.filter((p) => digitsOf(p) !== digitsOf(phoneForCheck || ''));
  if (otherPhones.length) notes.push(`Also listed with phone ${otherPhones.slice(0, 2).join(', ')}`);

  // Last checks before calling it a lead: a website found through any of their phone numbers, emails or
  // street addresses. A site counts when it shows one of their numbers or emails, or their address and
  // name (same rule as the phone check, so a directory or someone else's site never counts).
  const allFacts = {
    phone: phoneForCheck, phones: facts.phones, emails: facts.emails, streets: facts.streets, nameKeys: biz.profile?.keys || [],
  };
  const tried = new Set();
  const confirmNew = async (origins, more = {}) => {
    const fresh = origins.filter((o) => !tried.has(o));
    fresh.forEach((o) => tried.add(o));
    return fresh.length ? confirmSite(fresh, { ...allFacts, ...more }) : null;
  };
  if (found && cfg.phoneCheck) {
    // The website their listing links to, and info@joesplumbing.com → joesplumbing.com.
    const named = { nameKeys: [...allFacts.nameKeys, ...(biz.profile?.tokenSets || []).map((t) => t.join(''))] };
    const domains = facts.emails.filter((e) => !FREE_MAIL.test(e)).map((e) => `https://${e.split('@')[1]}/`)
      .filter((u) => classifyUrl(u)?.kind === 'website');
    let site = await confirmNew([...facts.websites, ...domains].map((u) => new URL(u).origin), named);
    // Each other phone number they're listed with gets its own search…
    for (const other of otherPhones.slice(0, 2)) {
      if (site || !ctx.searchOn) break;
      await sleep(delay());
      const results = await searcher.find(`"${other}"`);
      if (results) {
        allResults.push(...results);
        site = await confirmNew(siteOrigins(results));
      }
    }
    // …and their emails and street addresses one more.
    const streets = facts.streets.slice(0, 2);
    if (!site && ctx.searchOn && (facts.emails.length || streets.length)) {
      await sleep(delay());
      const query = [...facts.emails.slice(0, 2).map((e) => `"${e}"`), ...streets.map((st) => `"${st}" ${town}`)].join(' OR ');
      const results = await searcher.find(query);
      if (results) {
        allResults.push(...results);
        site = await confirmNew(siteOrigins(results));
      }
    }
    if (site) return { status: 'has_website', layer: 3, website: hostOf(site.origin), how: site.by };
  }

  // ── AI (Gemini): does any site that came up belong to them? Then it searches Google itself. ──
  if (ctx.ai?.enabled) {
    const who = {
      name: biz.name, category: maps?.category || biz.categoryLabel, address: maps?.address || biz.address,
      city: town, country: cfg.country, phones: facts.phones, emails: facts.emails,
    };
    const words = [...(biz.profile?.tokenSets || []).flat(), ...(biz.profile?.keys || [])].filter((w) => w.length >= 4);
    // Is the site at this address theirs? { how } yes, { unreachable } couldn't open it, null no.
    const judge = async (url) => {
      const origin = new URL(url).origin;
      const html = await fetchPage(url, { timeoutMs: 10000 }) || (url !== `${origin}/` ? await fetchPage(origin, { timeoutMs: 10000 }) : null);
      if (!html) return { unreachable: true };
      const byFacts = await confirmSite([origin], allFacts);
      if (byFacts) return { how: byFacts.by };
      const verdict = await aiSiteBelongs(ctx.ai, who, url, visibleText(html));
      return verdict?.belongs ? { how: `the AI read it: ${verdict.reason}` } : null;
    };
    // Sites from the searches that mention their name (others can't be theirs, so aren't worth asking about).
    let asked = 0;
    for (const origin of found && !generic ? siteOrigins(allResults, 8) : []) {
      if (asked >= 3 || !ctx.ai.enabled) break;
      const html = await fetchPage(origin, { timeoutMs: 8000 });
      const text = html ? visibleText(html, 30000) : '';
      const squashed = compact(text);
      if (!words.some((w) => squashed.includes(w))) continue;
      asked += 1;
      const verdict = await aiSiteBelongs(ctx.ai, who, origin, text);
      if (verdict?.belongs) return { status: 'has_website', layer: 3, website: hostOf(origin), how: `the AI read it: ${verdict.reason}` };
    }
    const a = await aiFindWebsite(ctx.ai, who);
    if (a) ctx.log(`   🤖 AI on Google: ${a.hasWebsite ? `website ${a.url || '(no link given)'}` : 'no website'}${a.reason ? ` · ${a.reason}` : ''}`);
    const site = a?.hasWebsite && a.url ? classifyUrl(a.url) : null;
    if (site?.kind === 'website') {
      const v = await judge(site.url);
      if (v?.how) return { status: 'has_website', layer: 3, website: site.host, how: `the AI found it on Google; ${v.how}` };
      // A site that won't open (down, or blocking bots), named after them, that the AI is sure about.
      if (v?.unreachable && a.high && siteMatchesBusiness(site.siteKey, biz.profile, '')) {
        return { status: 'has_website', layer: 3, website: site.host, how: 'the AI found it on Google (named after them)' };
      }
      if (a.confident) notes.push(`Check first: the AI thinks ${site.host} is their website${a.reason ? ` (${a.reason})` : ''}`);
    }
  }
  const since = sinceFrom(allResults, biz);
  return {
    status: 'lead',
    lead: {
      key: biz.key,
      name: biz.name,
      category: biz.category,
      categoryLabel: biz.categoryLabel,
      phone,
      whatsapp: toWhatsApp(maps?.phoneTel || phone, biz.phoneCountryCode ?? cfg.phoneCountryCode),
      email,
      address: maps?.address || biz.address,
      rating: maps?.rating ?? null,
      reviews: maps?.reviews ?? null,
      mapsUrl: maps?.status === 'found' ? maps.mapsUrl : (biz.placeUrl || `https://www.google.com/maps/search/?api=1&query=${biz.lat},${biz.lon}`),
      onMaps: maps?.status === 'found', // mapsUrl is their own listing, not just the spot on the map
      socials: orderSocials(socials).slice(0, 4),
      socialActivity: socialActivityFrom(allResults), // { 'instagram/handle': '1.2K followers · 340 posts' }
      listings: listingsFrom(allResults, biz), // [{ name: 'Yelp', url }]
      since: since ? `${since.year} (${since.source})` : null,
      category: maps?.category || null, // Google's category, e.g. "Hair salon"
      hours: maps?.hours || (biz.openingHours ? { status: null, days: [], text: biz.openingHours } : null),
      notes,
      checks: `Checked: OpenStreetMap ✓ · Google Maps ${maps ? '✓' : '✗'} · ${found ? `${engineLabel(found.engine)} ✓` : 'web search ✗'}${ctx.ai ? ` · AI ${ctx.ai.state.calls > aiCallsBefore ? '✓' : '✗'}` : ''}`,
      city: biz.city || cfg.city,
      osmUrl: biz.osmUrl,
      foundOn: today(),
    },
  };
}

function record(outcome, biz, { cfg, state, stats, leads, dataDir, dryRun, log }) {
  const prev = state.places[biz.key];
  biz.outcome = outcome.status; // rechecks look at this
  const base = { name: biz.name, checked: today(), ...(biz.recheck ? { recheckedOn: today() } : {}) };
  switch (outcome.status) {
    case 'lead':
      state.places[biz.key] = { status: 'lead', ...base };
      leads.push(outcome.lead);
      stats.leads += 1;
      if (!dryRun) appendLead(dataDir, outcome.lead);
      log(`   ✅ LEAD: no website anywhere${outcome.lead.phone ? ` · ${outcome.lead.phone}` : ''}`);
      break;
    case 'has_website':
      state.places[biz.key] = { status: 'has_website', ...base, website: outcome.website, layer: outcome.layer };
      stats.hasWebsite += 1;
      log(`   🌐 Has a website: ${outcome.website} (found by ${outcome.layer === 2 ? 'Google Maps' : 'web search'}${outcome.how ? `, ${outcome.how}` : ''})`);
      break;
    case 'excluded':
      state.places[biz.key] = { status: 'excluded', ...base, reason: outcome.reason };
      log(`   ⏭️  Not a lead: ${outcome.reason}`);
      break;
    case 'closed':
      state.places[biz.key] = { status: 'closed', ...base };
      stats.closed += 1;
      log('   🚫 Permanently closed on Google Maps');
      break;
    case 'unverified': {
      const attempts = (prev?.attempts || 0) + 1;
      const status = attempts >= cfg.maxAttempts ? 'gave_up' : 'unverified';
      state.places[biz.key] = { status, ...base, attempts, reason: outcome.reason };
      stats.unverified += 1;
      log(`   ⏳ Couldn't verify (${outcome.reason})${status === 'gave_up' ? ', giving up on this one' : ', will retry'}`);
      break;
    }
    default:
      log('   ⏭️  Skipped, will check next run');
  }
  if (outcome.status !== 'skipped') {
    // Also file it under its Google Maps place, so a Google Maps search never brings it back.
    if (biz.mapsKey && biz.mapsKey !== biz.key) state.places[biz.mapsKey] = { ...state.places[biz.key], sameAs: biz.key };
    stats.checked += 1;
    if (!dryRun) saveState(dataDir, state);
  }
}

/**
 * Fills the rest of this run's queue with businesses found by searching Google Maps, one search per
 * category, sharing the free places between them. Places whose result shows their own website are
 * filed as "has website" right away.
 */
async function topUpFromMaps(session, page) {
  const { cfg, ep, queue, state, stats, warnings, dataDir, dryRun, area, delay, log } = session;
  const knownNames = new Set(Object.values(state.places).map((p) => compact(p.name)));
  for (const biz of queue) knownNames.add(compact(biz.name));
  const isKnown = (key) => Boolean(state.places[key]);
  const defs = session.discover;
  let room = cfg.maxChecksPerRun - queue.length;
  for (let i = 0; i < defs.length && room > 0; i += 1) {
    const def = defs[i];
    const want = Math.ceil(room / (defs.length - i));
    const found = await discoverOnMaps(page, {
      term: def.search, city: cfg.city, country: cfg.country, area, mapsBase: ep.maps, want, isKnown, log,
    });
    if (found.blocked) {
      warnings.push('Google Maps blocked the search for more businesses. The rest will be found next run.');
      session.mapsOn = false;
      return;
    }
    let added = 0;
    let listed = 0;
    for (const place of found.places) {
      if (added >= want) break;
      if (knownNames.has(compact(place.name))) continue; // already checked (or queued) under another name source
      const site = place.website ? classifyUrl(place.website) : null;
      if (site && site.kind === 'website') {
        state.places[place.key] = { status: 'has_website', name: place.name, checked: today(), website: site.host, layer: 'maps list' };
        listed += 1;
        continue;
      }
      queue.push(toCandidate(place, { def, city: cfg.city }));
      knownNames.add(compact(place.name));
      added += 1;
    }
    stats.discovered += added;
    stats.mapsListed += found.total;
    room -= added;
    log(`   → ${added} added to this run${listed ? `, ${listed} skipped (their listing shows a website)` : ''}`);
    if (!dryRun && listed) saveState(dataDir, state);
    await sleep(delay());
  }
}

async function checkQueue(ctx) {
  const { cfg, ep, queue, warnings, startedAt, log } = ctx;
  const delay = () => randomDelayMs(cfg.delaySeconds);
  const deadline = startedAt.getTime() + cfg.maxRunMinutes * 60000;
  const { browser, context } = await launchBrowser();
  let searcher = null;
  try {
    const mapsPage = await context.newPage();
    const searchPage = await context.newPage();
    const ai = cfg.ai ? createAi({ log, maxCalls: cfg.aiMaxCalls, minIntervalMs: cfg.aiMinIntervalMs }) : null;
    if (ai && !ai.enabled) warnings.push('GEMINI_API_KEY is not set, so the AI checks were skipped this run.');
    else if (ai) log('🤖 AI checks on (Gemini), and Gemini searches Google first');
    searcher = createSearcher({
      page: searchPage, order: cfg.searchEngines, ep, ai, delay, log, deadline, cooldownMs: cfg.searchCooldownMinutes * 60000,
    });
    const session = { ...ctx, mapsPage, searcher, delay, mapsOn: true, searchOn: true, ai: ai?.enabled ? ai : null };
    if (ai) ctx.stats.ai = ai.state; // questions asked, and why the AI stopped (if it did)

    if (cfg.selfTest) {
      log('🔧 Google Maps self-test…');
      const test = await mapsSelfTest(mapsPage, { mapsBase: ep.maps }, log);
      if (test.ok) {
        log('   ✓ Google Maps OK');
      } else {
        session.mapsOn = false;
        const why = test.reason === 'blocked'
          ? 'Google Maps blocked the bot'
          : "The bot couldn't read Google Maps (its layout may have changed)";
        if (cfg.requireMapsCheck) {
          warnings.push(`${why}, so nothing was checked this run. It will try again next run. If this keeps happening, set requireMapsCheck: false in config.js.`);
          return searcher;
        }
        warnings.push(`${why}. Checked with OpenStreetMap + web search only this run.`);
      }
      await sleep(delay());
    }

    if (ctx.discover?.length && session.mapsOn) await topUpFromMaps(session, mapsPage);

    for (let i = 0; i < queue.length; i += 1) {
      if (Date.now() > deadline) {
        warnings.push('Hit the time limit. The rest will be checked next run.');
        break;
      }
      const biz = queue[i];
      log(`\n[${i + 1}/${queue.length}] ${biz.name} · ${biz.categoryLabel}`);
      const outcome = await checkBusiness(biz, session);
      if (!browser.isConnected()) {
        // Browser crashed or the job is being cancelled: don't blame the business for it.
        warnings.push('The browser stopped unexpectedly. The rest will be checked next run.');
        break;
      }
      record(outcome, biz, ctx);
      if (outcome.stop) break;
      if (i < queue.length - 1) await sleep(delay());
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return searcher;
}

function engineWarnings(state) {
  const entries = Object.entries(state);
  const problems = entries.filter(([, s]) => s.status === 'blocked' || s.status === 'broken');
  if (!problems.length) return [];
  const used = entries.filter(([, s]) => s.status === 'ok').map(([name]) => engineLabel(name));
  const what = problems
    .map(([name, s]) => `${engineLabel(name)} ${s.status === 'blocked' ? 'blocked the bot' : "didn't work"}`)
    .join(', ');
  return [`Web search: ${what}${used.length ? `, so it used ${used.join(' + ')}` : ''}.`];
}

// Link to data/run-leads.txt on GitHub (every lead of this run as text, with a "Copy raw file" button).
const runLeadsLink = () => (process.env.GITHUB_REPOSITORY
  ? `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/${process.env.GITHUB_REF_NAME || 'main'}/data/run-leads.txt`
  : null);

function summaryText(cfg, stats, warnings, fatal) {
  const lines = [`🎯 **Website Hunting Bot** · ${cfg ? placeName(cfg) : 'setup problem'}`];
  if (cfg?.runLabel) lines.push(`🖐️ ${cfg.runLabel}`);
  if (fatal) {
    lines.push(`❌ **Run failed:** ${String(fatal.message).split('\n')[0].slice(0, 300)}`);
  } else {
    if (cfg?.recheck) {
      lines.push(`♻️ **Rechecked ${stats.checked} earlier lead${stats.checked === 1 ? '' : 's'}** with the latest checks: ${stats.leads} still have no website (below), ${stats.hasWebsite} have one (dropped)${stats.closed ? `, ${stats.closed} closed` : ''}`);
    } else {
      lines.push(stats.leads
        ? `✅ **${stats.leads} new lead${stats.leads === 1 ? '' : 's'}**: no website on OpenStreetMap, Google Maps or web search`
        : '➖ No new leads this run.');
    }
    const bits = [];
    if (stats.hasWebsite && !cfg?.recheck) bits.push(`🌐 ${stats.hasWebsite} already have a website`);
    if (stats.closed) bits.push(`🚫 ${stats.closed} closed`);
    if (stats.unverified) bits.push(`⏳ ${stats.unverified} to retry`);
    if (bits.length) lines.push(bits.join(' · '));
    if (stats.ai?.calls) lines.push(`🤖 Gemini: ${stats.ai.calls} questions, ${stats.ai.searches} of them Google searches`);
    lines.push(cfg?.recheck
      ? `🔎 ${stats.pending.toLocaleString('en-US')} earlier leads still to recheck${stats.pending ? '' : ' · all done ✅'}`
      : `🔎 Checked ${stats.checked} this run${stats.discovered ? ` (${stats.discovered} found by searching Google Maps)` : ''} · ${stats.pending.toLocaleString('en-US')} still in the queue`);
    if (stats.leads) {
      const all = runLeadsLink();
      lines.push(`📲 Each card has a "Send this lead to WhatsApp" link${all ? ` · [All ${stats.leads} leads as text](${all}) (tap Copy raw file)` : ''}`);
    }
  }
  for (const w of warnings) lines.push(`⚠️ ${w}`);
  return lines.join('\n');
}

export async function run({ config, dataDir, dryRun = false, webhookUrl = process.env.DISCORD_WEBHOOK_URL, log = console.log } = {}) {
  const startedAt = new Date();
  const ep = endpoints();
  const stats = { candidates: 0, discovered: 0, mapsListed: 0, checked: 0, leads: 0, hasWebsite: 0, closed: 0, unverified: 0, pending: 0 };
  const warnings = [];
  const leads = [];
  let cfg = null;
  let state = null;
  let areaLabel = null;
  let searcher = null;
  let fatal = null;

  try {
    const normalized = normalizeConfig(config);
    cfg = normalized.cfg;
    warnings.push(...normalized.notes);
    state = loadState(dataDir);
    const { defs, unknown } = resolveCategories(cfg.categories);
    if (unknown.length) warnings.push(`Unknown categories ignored: ${unknown.join(', ')} (see README for the list)`);
    // Business types typed into the form: Google Maps search only (OpenStreetMap needs exact tags).
    const custom = cfg.mapsSearch.map((term) => ({ id: 'custom', label: term.charAt(0).toUpperCase() + term.slice(1), tags: [], search: term }));
    if (!defs.length && !custom.length) throw new Error('config.js: none of the `categories` are valid (see README for the list).');

    log(`🎯 Website Hunting Bot · ${placeName(cfg)}`);

    if (cfg.recheck) {
      // ── Rechecking earlier leads ──
      const todo = loadRecheck(dataDir);
      const batch = todo.slice(0, cfg.maxChecksPerRun);
      log(`♻️ Rechecking earlier leads: ${todo.length} to go, ${batch.length} this run`);
      if (batch.length) {
        const queue = batch.map(recheckCandidate);
        searcher = await checkQueue({ cfg, ep, queue, state, stats, leads, warnings, dataDir, dryRun, startedAt, log, area: null, discover: [] });
        const outcomeOf = new Map(batch.map((item, i) => [item, queue[i].outcome])); // set by record()
        const left = todo.filter((item) => {
          const outcome = outcomeOf.get(item);
          if (!outcome || outcome === 'skipped') return true; // not reached this run
          if (outcome !== 'unverified') return false; // done: still a lead (sent) or dropped
          item.attempts = (item.attempts || 0) + 1;
          return item.attempts < cfg.maxAttempts;
        });
        // Still to do go first, the ones that couldn't be verified to the back.
        left.sort((a, b) => (a.attempts || 0) - (b.attempts || 0));
        if (!dryRun) saveRecheck(dataDir, left);
        stats.pending = left.length;
      }
      stats.recheckLeft = stats.pending;
    } else {

      // ── Layer 1: OpenStreetMap ──
      const area = await resolveArea(cfg, ep, log);
      areaLabel = area.label;
      log(`📍 Area: ${area.label}`);
      const canDiscover = cfg.mapsDiscovery && [...custom, ...defs].some((d) => d.search);
      const { candidates, notes: osmNotes } = defs.length
        ? await fetchCandidates({ cfg, area, defs, ep, dataDir, save: !dryRun, log }).catch((err) => {
          // OpenStreetMap down (or the area too big for it): Google Maps can still find businesses.
          if (!canDiscover) throw err;
          log(`⚠️ ${err.message} Searching Google Maps only.`);
          return { candidates: [], notes: ['OpenStreetMap servers could not be reached, so only Google Maps was searched this run.'] };
        })
        : { candidates: [], notes: [] };
      warnings.push(...osmNotes);
      stats.candidates = candidates.length;
      if (defs.length) log(`🗺️  Layer 1, OpenStreetMap: ${candidates.length} businesses with no website listed`);

      const { queue } = pickQueue(candidates, state, cfg.maxChecksPerRun, cfg.maxAttempts);
      // Not enough from OpenStreetMap (or a typed-in business type): search Google Maps for more.
      const discover = cfg.mapsDiscovery && queue.length < cfg.maxChecksPerRun ? [...custom, ...defs].filter((d) => d.search) : [];
      if (queue.length || discover.length) {
        searcher = await checkQueue({ cfg, ep, queue, state, stats, leads, warnings, dataDir, dryRun, startedAt, log, area, discover });
      }
      if (!stats.checked && !stats.discovered && !stats.leads) {
        warnings.push(candidates.length || stats.mapsListed
          ? 'Every business found has already been checked. Add categories or change the area to find new ones.'
          : 'No businesses without a website were found here for these categories. Try more categories, a bigger radius or another city.');
      }
      stats.pending = pickQueue(candidates, state, Infinity, cfg.maxAttempts).pending;
    }
  } catch (err) {
    fatal = err;
    log(`❌ ${err.message}`);
  }

  if (searcher) warnings.push(...engineWarnings(searcher.state));
  const aiState = stats.ai;
  if (aiState?.off && aiState.calls) warnings.push(`AI (Gemini): ${aiState.off}, so the rest were checked without it.`);
  const finishedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    minutes: Math.round((finishedAt - startedAt) / 6000) / 10,
    place: cfg ? placeName(cfg) : null,
    area: areaLabel,
    ...stats,
    searchEngines: searcher ? Object.fromEntries(Object.entries(searcher.state).map(([k, v]) => [k, v.status])) : {},
    warnings,
    error: fatal ? fatal.message : null,
  };
  if (!dryRun && state) {
    saveState(dataDir, state);
    writeLastRun(dataDir, summary);
    if (leads.length) writeRunLeads(dataDir, leadsText(leads, placeName(cfg)));
  }

  const text = summaryText(cfg, stats, warnings, fatal);
  log(`\n${text}`);
  if (leads.length || fatal || warnings.length || cfg?.postSummaryWhenEmpty !== false) {
    const messages = buildMessages(text, leads);
    if (dryRun) {
      log(`\n[dry run] Would send ${messages.length} Discord message(s):\n${JSON.stringify(messages, null, 2)}`);
    } else if (!webhookUrl) {
      log('\n⚠️ DISCORD_WEBHOOK_URL is not set, so nothing was sent to Discord. Leads are saved in data/leads.csv.');
    } else {
      const sent = await sendMessages(webhookUrl, messages, log);
      log(`\n📨 Discord: sent ${sent.sent}/${sent.total} message(s)`);
    }
  }
  return { ...summary, leads };
}
