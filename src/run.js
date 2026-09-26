// One full run: OpenStreetMap → Google Maps → web search → Discord.

import { resolveCategories } from './categories.js';
import { resolveArea, fetchCandidates, pickQueue } from './overpass.js';
import { launchBrowser } from './browser.js';
import { checkMaps, mapsSelfTest } from './maps.js';
import { createSearcher, engineLabel } from './search.js';
import { analyzeResults, classifyUrl, hostOf, prettySite, toWhatsApp, uniqueUrls } from './matching.js';
import { buildMessages, sendMessages } from './discord.js';
import { appendLead, loadState, saveState, writeLastRun } from './storage.js';
import { endpoints, randomDelayMs, sleep, today } from './util.js';

const KNOWN_ENGINES = ['google', 'bing', 'duckduckgo'];

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
  delaySeconds: [4, 9],
  postSummaryWhenEmpty: true,
  // Fixed on purpose (not in config.js):
  maxRunMinutes: 40, // stop starting new checks after this, so the GitHub job never times out
  maxAttempts: 3, // give up on a business that can't be verified after this many runs
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

  if (!maps) notes.push("Google Maps wasn't checked this run, so double-check before pitching");
  else if (maps.status === 'not_found') notes.push('Not on Google Maps. You can also offer to set up their Google Business Profile');
  else {
    if (maps.permanentlyClosed) return { status: 'closed' };
    if (maps.website) {
      const site = classifyUrl(maps.website);
      if (!site || site.kind === 'website') return { status: 'has_website', layer: 2, website: site ? site.host : maps.website };
      notes.push(websiteNote(site));
    }
    if (maps.claimable) notes.push('Their Google listing is unclaimed');
    if (maps.limitedView) notes.push('Google Maps showed a limited view, so double-check the listing before pitching');
  }

  // ── Layer 3: web search ──
  const found = await searcher.search(biz);
  if (found.status !== 'ok') {
    if (found.allDead) {
      warnings.push('Every search engine blocked the bot, so it stopped early. The rest will be checked next run.');
      return { status: 'skipped', stop: true };
    }
    return { status: 'unverified', reason: 'web search failed' };
  }
  const result = analyzeResults(found.results, biz);
  if (result.hasWebsite) return { status: 'has_website', layer: 3, website: hostOf(result.website) };
  for (const host of result.possible) notes.push(`Check first: ${host} might be their website`);

  const mapsSite = maps?.website ? classifyUrl(maps.website) : null;
  const phone = maps?.phone || biz.phone || null;
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
      mapsUrl: maps?.status === 'found' ? maps.mapsUrl : `https://www.google.com/maps/search/?api=1&query=${biz.lat},${biz.lon}`,
      socials: uniqueUrls([...biz.socials, mapsSite?.kind === 'social' ? mapsSite.url : null, ...result.socials]).slice(0, 4),
      notes,
      checks: `Checked: OpenStreetMap ✓ · Google Maps ${maps ? '✓' : '✗'} · ${engineLabel(found.engine)} ✓`,
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
    stats.checked += 1;
    if (!dryRun) saveState(dataDir, state);
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
    searcher = createSearcher({ page: searchPage, order: cfg.searchEngines, ep, delay, log });
    const session = { ...ctx, mapsPage, searcher, delay, mapsOn: true };

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

function summaryText(cfg, stats, warnings, fatal) {
  const lines = [`🎯 **Website Hunting Bot** · ${cfg ? placeName(cfg) : 'setup problem'}`];
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
    lines.push(`🔎 Checked ${stats.checked} this run · ${stats.pending.toLocaleString('en-US')} still in the queue`);
  }
  for (const w of warnings) lines.push(`⚠️ ${w}`);
  return lines.join('\n');
}

export async function run({ config, dataDir, dryRun = false, webhookUrl = process.env.DISCORD_WEBHOOK_URL, log = console.log } = {}) {
  const startedAt = new Date();
  const ep = endpoints();
  const stats = { candidates: 0, checked: 0, leads: 0, hasWebsite: 0, closed: 0, unverified: 0, pending: 0 };
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
    if (!defs.length) throw new Error('config.js: none of the `categories` are valid (see README for the list).');

    log(`🎯 Website Hunting Bot · ${placeName(cfg)}`);

    // ── Layer 1: OpenStreetMap ──
    const area = await resolveArea(cfg, ep, log);
    areaLabel = area.label;
    log(`📍 Area: ${area.label}`);
    const candidates = await fetchCandidates({ cfg, area, defs, ep, log });
    stats.candidates = candidates.length;
    log(`🗺️  Layer 1, OpenStreetMap: ${candidates.length} businesses with no website listed`);
    if (!candidates.length) {
      warnings.push('OpenStreetMap has no businesses without a website for these categories here. Try more categories, a bigger radius or another city.');
    }

    const { queue } = pickQueue(candidates, state, cfg.maxChecksPerRun, cfg.maxAttempts);
    if (queue.length) {
      searcher = await checkQueue({ cfg, ep, queue, state, stats, leads, warnings, dataDir, dryRun, startedAt, log });
    } else if (candidates.length) {
      warnings.push('Every business found has already been checked. Add categories or change the area to find new ones.');
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
