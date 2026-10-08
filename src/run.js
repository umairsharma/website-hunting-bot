// One full run: OpenStreetMap → Google Maps → web search → Discord.

import { resolveCategories } from './categories.js';
import { resolveArea, fetchCandidates, pickQueue } from './overpass.js';
import { launchBrowser } from './browser.js';
import { checkMaps, mapsSelfTest } from './maps.js';
import { discoverOnMaps, toCandidate } from './discover.js';
import { createSearcher, engineLabel, ENGINE_NAMES } from './search.js';
import { analyzeResults, classifyUrl, compact, hostOf, prettySite, toWhatsApp } from './matching.js';
import { buildMessages, sendMessages } from './discord.js';
import { appendLead, loadState, saveState, writeLastRun, writeRunLeads } from './storage.js';
import { leadsText } from './share.js';
import { findSocials, orderSocials, socialProfile } from './socials.js';
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
 * A lead's Instagram (and Facebook, if none was found yet): one more search each, e.g.
 * "Roy's Plumbing Abbeville instagram". Only profiles that are clearly this business are kept.
 */
async function findSocialPages(biz, known, address, ctx) {
  const has = (network) => known.some((url) => socialProfile(url)?.network === network);
  // For a run over a whole state, the business's own town from its address ("…, Abbeville, MS 38601").
  const parts = String(address || '').split(',').map((x) => x.trim()).filter(Boolean);
  const inCity = compact(address).includes(compact(biz.city));
  const town = (!inCity && parts.length >= 3 && !/\d/.test(parts.at(-2)) ? parts.at(-2) : null) || biz.city;
  const found = [];
  for (const network of ['instagram', 'facebook']) {
    if (has(network) || found.some((p) => p.network === network)) continue;
    await sleep(ctx.delay());
    const results = await ctx.searcher.find([biz.searchName, town, network].filter(Boolean).join(' '));
    if (!results) break; // every engine is busy; not worth stopping the run for
    found.push(...findSocials(results, biz).filter((p) => !has(p.network)));
  }
  for (const p of found) ctx.log(`   📱 ${p.label}: ${p.display}`);
  return found.map((p) => p.url);
}

async function checkBusiness(biz, ctx) {
  const { cfg, ep, mapsPage, searcher, delay, warnings } = ctx;
  const notes = [];
  let maps = null;

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
    if (maps.temporarilyClosed) notes.push('Google Maps says it is temporarily closed');
    if (maps.claimable) notes.push('Their Google listing is unclaimed');
    if (maps.limitedView) notes.push('Google Maps showed a limited view, so double-check the listing before pitching');
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
  for (const host of result.possible) notes.push(`Check first: ${host} might be their website`);
  if (!found) notes.push("Web search wasn't available, so double-check they don't have a website before pitching");

  const mapsSite = maps?.website ? classifyUrl(maps.website) : null;
  const phone = maps?.phone || biz.phone || null;
  const socials = [...biz.socials, mapsSite?.kind === 'social' ? mapsSite.url : null, ...result.socials,
    ...(found ? findSocials(found.results, biz).map((p) => p.url) : [])];
  if (found && cfg.findSocials) socials.push(...await findSocialPages(biz, socials, maps?.address || biz.address, ctx));
  return {
    status: 'lead',
    lead: {
      key: biz.key,
      name: biz.name,
      category: biz.category,
      categoryLabel: biz.categoryLabel,
      phone,
      whatsapp: toWhatsApp(maps?.phoneTel || phone, cfg.phoneCountryCode),
      email: biz.email,
      address: maps?.address || biz.address,
      rating: maps?.rating ?? null,
      reviews: maps?.reviews ?? null,
      mapsUrl: maps?.status === 'found' ? maps.mapsUrl : (biz.placeUrl || `https://www.google.com/maps/search/?api=1&query=${biz.lat},${biz.lon}`),
      onMaps: maps?.status === 'found', // mapsUrl is their own listing, not just the spot on the map
      socials: orderSocials(socials).slice(0, 4),
      notes,
      checks: `Checked: OpenStreetMap ✓ · Google Maps ${maps ? '✓' : '✗'} · ${found ? `${engineLabel(found.engine)} ✓` : 'web search ✗'}`,
      city: cfg.city,
      osmUrl: biz.osmUrl,
      foundOn: today(),
    },
  };
}

function record(outcome, biz, { cfg, state, stats, leads, dataDir, dryRun, log }) {
  const prev = state.places[biz.key];
  const base = { name: biz.name, checked: today() };
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
      log(`   🌐 Has a website: ${outcome.website} (found by ${outcome.layer === 2 ? 'Google Maps' : 'web search'})`);
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
    searcher = createSearcher({
      page: searchPage, order: cfg.searchEngines, ep, delay, log, deadline, cooldownMs: cfg.searchCooldownMinutes * 60000,
    });
    const session = { ...ctx, mapsPage, searcher, delay, mapsOn: true, searchOn: true };

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
    lines.push(stats.leads
      ? `✅ **${stats.leads} new lead${stats.leads === 1 ? '' : 's'}**: no website on OpenStreetMap, Google Maps or web search`
      : '➖ No new leads this run.');
    const bits = [];
    if (stats.hasWebsite) bits.push(`🌐 ${stats.hasWebsite} already have a website`);
    if (stats.closed) bits.push(`🚫 ${stats.closed} closed`);
    if (stats.unverified) bits.push(`⏳ ${stats.unverified} to retry`);
    if (bits.length) lines.push(bits.join(' · '));
    lines.push(`🔎 Checked ${stats.checked} this run${stats.discovered ? ` (${stats.discovered} found by searching Google Maps)` : ''} · ${stats.pending.toLocaleString('en-US')} still in the queue`);
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
  } catch (err) {
    fatal = err;
    log(`❌ ${err.message}`);
  }

  if (searcher) warnings.push(...engineWarnings(searcher.state));
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
