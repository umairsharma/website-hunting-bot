// Full runs of the bot (real headless Chromium) against the fake services in mock-server.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from './mock-server.js';
import { run } from '../src/run.js';
import { launchBrowser } from '../src/browser.js';
import { checkMaps } from '../src/maps.js';
import { createSearcher } from '../src/search.js';
import { endpoints } from '../src/util.js';

const CONFIG = {
  city: 'Lahore',
  country: 'Pakistan',
  categories: ['restaurant', 'cafe', 'bakery', 'dentist', 'clothes'],
  maxChecksPerRun: 30,
  phoneCountryCode: '92',
  searchEngines: ['google', 'bing', 'duckduckgo'],
  delaySeconds: [0, 0],
  searchCooldownMinutes: 0.005, // 0.3 s instead of 5 min
};

async function withServer(scenario, fn) {
  const server = await startMockServer(scenario);
  const env = {
    NOMINATIM_URL: `${server.base}/nominatim`,
    OVERPASS_URLS: `${server.base}/overpass/interpreter`,
    MAPS_BASE_URL: `${server.base}/maps`,
    GOOGLE_BASE_URL: `${server.base}/google`,
    BING_BASE_URL: `${server.base}/bing`,
    BRAVE_BASE_URL: `${server.base}/brave`,
    BRAVE_API_URL: `${server.base}/brave-api`,
    STARTPAGE_BASE_URL: `${server.base}/startpage`,
    DDG_BASE_URL: `${server.base}/ddg`,
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn(server);
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await server.close();
  }
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whb-e2e-'));
const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

test('full run: 3 layers, Google blocked mid-run → falls back, Discord gets leads, nothing is checked twice', { timeout: 240000 }, async () => {
  await withServer({ googleBlockOn: 'Rehman Dental Clinic' }, async (server) => {
    const dataDir = tempDir();
    const logs = [];
    // A long break, so Google stays blocked for the rest of this run (second chances are tested separately).
    const config = { ...CONFIG, searchCooldownMinutes: 30 };
    const result = await run({ config, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m) });
    const logText = logs.join('\n');

    assert.equal(result.error, null, logText);
    // Layer 1: 10 OSM elements → 6 real candidates (chain, has-website, unnamed and duplicate filtered out)
    assert.equal(result.candidates, 6, logText);
    // One query per category (5 categories), each for the whole city
    assert.equal(server.requests.overpass.length, 5);
    assert.ok(server.requests.overpass.every((q) => q.includes('area(id:3607431040)->.searchArea;')));
    assert.ok(server.requests.overpass.some((q) => q.includes('nwr["shop"="tailor"]')));

    assert.equal(result.checked, 6, logText);
    assert.equal(result.hasWebsite, 2, logText); // Ali Bakers (Maps button), Haveli (web search)
    assert.equal(result.closed, 1, logText); // Zam Zam Tailors
    assert.equal(result.unverified, 0, logText);
    assert.deepEqual(result.leads.map((l) => l.name).sort(), ['Butt Karahi House', 'Gone Store', 'Rehman Dental Clinic']);
    assert.deepEqual(result.searchEngines, { google: 'blocked', bing: 'broken', duckduckgo: 'ok' });

    const butt = result.leads.find((l) => l.name === 'Butt Karahi House');
    assert.equal(butt.phone, '0300 1112222');
    assert.equal(butt.whatsapp, 'https://wa.me/923001112222');
    assert.equal(butt.rating, 4.4);
    assert.equal(butt.reviews, 320);
    assert.equal(butt.address, 'Lakshmi Chowk, Lahore');
    assert.deepEqual(butt.socials, ['https://www.facebook.com/buttkarahihouse/']);
    assert.ok(butt.notes.some((n) => /unclaimed/.test(n)));
    assert.ok(butt.notes.some((n) => /temporarily closed/.test(n))); // and a review mentioning "permanently closed" didn't count
    assert.match(butt.checks, /Google Maps ✓ · Google ✓/);
    // Opened straight from the search, so the link is the listing's short permanent form.
    assert.match(butt.mapsUrl, /^https:\/\/maps\.google\.com\/\?cid=\d+$/);
    assert.equal(butt.onMaps, true);

    const rehman = result.leads.find((l) => l.name === 'Rehman Dental Clinic');
    assert.ok(rehman.notes.some((n) => /Facebook page/.test(n)), rehman.notes.join(' | '));
    assert.ok(rehman.notes.some((n) => /smilecare-lahore\.com/.test(n)), rehman.notes.join(' | '));
    assert.equal(rehman.socials.length, 1);
    assert.match(rehman.checks, /DuckDuckGo ✓/);

    const gone = result.leads.find((l) => l.name === 'Gone Store');
    assert.ok(gone.notes.some((n) => /Not on Google Maps/.test(n)));
    assert.equal(gone.mapsUrl, 'https://www.google.com/maps/search/?api=1&query=31.5,74.3');
    assert.equal(gone.onMaps, false);
    assert.equal(gone.whatsapp, null);

    // Discord: first POST got a 429 and was retried; one message with the summary + 3 lead cards
    assert.equal(server.requests.discord.length, 1);
    const msg = server.requests.discord[0];
    for (const e of msg.embeds) assert.match(e.fields.at(-1).value, /^\[Send this lead to WhatsApp\]\(https:\/\/wa\.me\/\?text=/);
    const runLeads = fs.readFileSync(path.join(dataDir, 'run-leads.txt'), 'utf8');
    assert.match(runLeads, /^🎯 3 website leads · Lahore, Pakistan/);
    assert.match(msg.content, /Each card has a "Send this lead to WhatsApp" link/);
    assert.ok(msg.embeds.find((e) => e.title === '🔥 Butt Karahi House'));
    for (const e of msg.embeds) assert.ok(e.fields.some((f) => f.name === '📍 Google Maps'), `${e.title} has no Google Maps link`);

    // Saved state
    const seen = readJson(dataDir, 'seen.json');
    assert.equal(Object.keys(seen.places).length, 6);
    assert.deepEqual(
      { status: seen.places['node/1'].status, website: seen.places['node/1'].website, layer: seen.places['node/1'].layer },
      { status: 'has_website', website: 'alibakers.pk', layer: 2 },
    );
    assert.equal(seen.places['way/3'].layer, 3);
    assert.equal(seen.places['node/4'].status, 'closed');
    const csv = fs.readFileSync(path.join(dataDir, 'leads.csv'), 'utf8').trim().split('\n');
    assert.equal(csv.length, 4);
    assert.equal(readJson(dataDir, 'last-run.json').leads, 3);

    // Second run: everything already checked → no browser work, no duplicate leads
    const mapsCalls = server.requests.maps.length;
    const again = await run({ config: CONFIG, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: () => {} });
    assert.equal(again.error, null);
    assert.equal(again.checked, 0);
    assert.equal(again.leads.length, 0);
    assert.equal(server.requests.maps.length, mapsCalls);
    assert.equal(server.requests.overpass.length, 5); // OpenStreetMap data came from the weekly cache
    assert.equal(server.requests.discord.length, 2);
    assert.match(server.requests.discord[1].content, /No new leads/);
    assert.match(server.requests.discord[1].content, /already been checked/);
    assert.equal(fs.readFileSync(path.join(dataDir, 'leads.csv'), 'utf8').trim().split('\n').length, 4);
  });
});

test('Google Maps unreadable + requireMapsCheck: true → checks nothing and warns', { timeout: 120000 }, async () => {
  await withServer({ mapsCanaryBroken: true }, async (server) => {
    const dataDir = tempDir();
    const result = await run({ config: CONFIG, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: () => {} });
    assert.equal(result.error, null);
    assert.equal(result.checked, 0);
    assert.equal(result.leads.length, 0);
    assert.equal(result.pending, 6);
    assert.equal(server.requests.google.length, 0);
    assert.ok(result.warnings.some((w) => /couldn't read Google Maps/.test(w)));
    assert.equal(Object.keys(readJson(dataDir, 'seen.json').places).length, 0);
    assert.match(server.requests.discord[0].content, /couldn't read Google Maps/);
  });
});

test('Google Maps unreadable + requireMapsCheck: false → OSM + web search only, leads flagged', { timeout: 180000 }, async () => {
  await withServer({ mapsCanaryBroken: true, bingWorks: true }, async (server) => {
    const dataDir = tempDir();
    const result = await run({
      config: { ...CONFIG, requireMapsCheck: false }, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: () => {},
    });
    assert.equal(result.error, null);
    assert.equal(result.checked, 6);
    assert.equal(result.hasWebsite, 2); // Ali Bakers + Haveli, both via web search now
    assert.deepEqual(result.leads.map((l) => l.name).sort(), ['Butt Karahi House', 'Gone Store', 'Rehman Dental Clinic', 'Zam Zam Tailors']);
    for (const lead of result.leads) {
      assert.match(lead.checks, /Google Maps ✗/);
      assert.ok(lead.notes.some((n) => /Google Maps wasn't checked/.test(n)));
    }
    assert.equal(server.requests.maps.length, 2); // only the two self-test attempts
  });
});

test('Google Maps: a results list that never fills in is an error, not "not on Maps"', { timeout: 60000 }, async () => {
  await withServer({}, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const page = await context.newPage();
      const biz = { searchName: 'Empty List Cafe', city: 'Lahore', names: ['Empty List Cafe'], lat: 31.5, lon: 74.3 };
      const r = await checkMaps(page, biz, { mapsBase: `${server.base}/maps`, timeoutMs: 5000 });
      assert.equal(r.status, 'error');
      assert.match(r.reason, /results list/);
    } finally {
      await browser.close();
    }
  });
});

const BIZ = { searchName: 'Rehman Dental Clinic', city: 'Lahore' };

test('Brave website: results read, its own links and ads skipped; Startpage used when Brave blocks', { timeout: 120000 }, async () => {
  await withServer({}, async () => {
    const { browser, context } = await launchBrowser();
    try {
      const searcher = createSearcher({ page: await context.newPage(), order: ['brave'], ep: endpoints() });
      const r = await searcher.search(BIZ);
      assert.equal(r.status, 'ok');
      assert.equal(r.engine, 'brave');
      assert.deepEqual(r.results.map((x) => x.url), [
        'https://www.marham.pk/doctors/lahore/dentist/dr-rehman', 'https://www.facebook.com/rehmandental', 'https://smilecare-lahore.com/',
      ]);
      assert.equal(r.results[2].title, 'Rehman Dental Clinic - Smile Care Lahore');
    } finally {
      await browser.close();
    }
  });
  await withServer({ braveWebBlocked: true }, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const searcher = createSearcher({ page: await context.newPage(), order: ['brave', 'startpage'], ep: endpoints() });
      const r = await searcher.search(BIZ);
      assert.equal(searcher.state.brave.status, 'blocked'); // HTTP 429 counts as a block
      assert.equal(r.engine, 'startpage');
      assert.deepEqual(r.results.map((x) => x.url), [
        'https://www.marham.pk/doctors/lahore/dentist/dr-rehman', 'https://www.facebook.com/rehmandental', 'https://smilecare-lahore.com/',
      ]);
      assert.equal(server.requests.startpage.length, 2); // self-test + the real search
    } finally {
      await browser.close();
    }
  });
});

test('Startpage captcha page counts as blocked', { timeout: 60000 }, async () => {
  await withServer({ startpageBlocked: true }, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const searcher = createSearcher({ page: await context.newPage(), order: ['startpage'], ep: endpoints(), cooldownMs: 100 });
      const r = await searcher.search(BIZ);
      assert.equal(r.status, 'unavailable');
      assert.equal(r.allDead, true);
      assert.equal(searcher.state.startpage.status, 'blocked');
      assert.equal(server.requests.startpage.length, 2); // blocked, then blocked again after its break
    } finally {
      await browser.close();
    }
  });
});

test('Brave Search API: used when BRAVE_API_KEY is set (no browser needed); a bad key switches it off', { timeout: 30000 }, async () => {
  await withServer({}, async (server) => {
    const saved = process.env.BRAVE_API_KEY;
    try {
      process.env.BRAVE_API_KEY = 'good-key';
      const searcher = createSearcher({ page: null, order: ['brave'], ep: endpoints() });
      const r = await searcher.search(BIZ);
      assert.equal(r.status, 'ok');
      assert.equal(searcher.state.brave.status, 'ok');
      assert.equal(r.results.length, 3);
      assert.equal(server.requests.braveApi[0].q, 'Eiffel Tower official website'); // self-test first
      assert.equal(server.requests.brave.length, 0); // the website was never touched

      process.env.BRAVE_API_KEY = 'wrong-key';
      const bad = createSearcher({ page: null, order: ['brave'], ep: endpoints() });
      const r2 = await bad.search(BIZ);
      assert.equal(r2.status, 'unavailable');
      assert.equal(bad.state.brave.status, 'broken');
    } finally {
      if (saved === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = saved;
    }
  });
});

test('Search: a blocked engine gets a second chance after a break; a half-loaded self-test is retried', { timeout: 120000 }, async () => {
  await withServer({ braveBlockFirst: 1 }, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const logs = [];
      const searcher = createSearcher({ page: await context.newPage(), order: ['brave'], ep: endpoints(), log: (m) => logs.push(m), cooldownMs: 300 });
      const r = await searcher.search(BIZ);
      assert.equal(r.status, 'ok', logs.join('\n'));
      assert.equal(r.engine, 'brave');
      assert.ok(logs.some((l) => /waiting/.test(l)) && logs.some((l) => /Trying Brave again/.test(l)), logs.join('\n'));
      assert.equal(server.requests.brave.length, 3); // blocked self-test, then self-test + search after the break
    } finally {
      await browser.close();
    }
  });
  await withServer({ braveWebBlocked: true }, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const searcher = createSearcher({ page: await context.newPage(), order: ['brave'], ep: endpoints(), cooldownMs: 100, maxBlocks: 2 });
      const r = await searcher.search(BIZ);
      assert.equal(r.status, 'unavailable');
      assert.equal(r.allDead, true); // blocked twice = done for this run
      assert.equal(server.requests.brave.length, 2);
    } finally {
      await browser.close();
    }
  });
  await withServer({ bingWorks: true, bingEmptyFirst: true }, async (server) => {
    const { browser, context } = await launchBrowser();
    try {
      const searcher = createSearcher({ page: await context.newPage(), order: ['bing'], ep: endpoints(), retryTestMs: 0 });
      const r = await searcher.search(BIZ);
      assert.equal(r.engine, 'bing');
      assert.equal(server.requests.bing.length, 3); // empty self-test, retried self-test, search
    } finally {
      await browser.close();
    }
  });
});

test('Every search engine blocked + requireWebSearch: true → stops early, no half-checked leads', { timeout: 180000 }, async () => {
  await withServer({ searchDown: true }, async (server) => {
    const result = await run({ config: CONFIG, dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: () => {} });
    assert.equal(result.error, null);
    assert.equal(result.leads.length, 0);
    assert.ok(result.warnings.some((w) => /stopped early/.test(w)), result.warnings.join(' | '));
  });
});

test('Every search engine blocked + requireWebSearch: false → keeps going on OpenStreetMap + Google Maps, leads flagged', { timeout: 180000 }, async () => {
  await withServer({ searchDown: true }, async (server) => {
    const result = await run({
      config: { ...CONFIG, requireWebSearch: false }, dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: () => {},
    });
    assert.equal(result.error, null);
    assert.equal(result.checked, 6);
    assert.equal(result.hasWebsite, 1); // Ali Bakers, by its Google Maps website button
    assert.equal(result.closed, 1);
    assert.deepEqual(result.leads.map((l) => l.name).sort(), ['Butt Karahi House', 'Gone Store', 'Haveli Restaurant', 'Rehman Dental Clinic']);
    for (const lead of result.leads) {
      assert.match(lead.checks, /web search ✗/);
      assert.ok(lead.notes.some((n) => /Web search wasn't available/.test(n)));
    }
    assert.ok(result.warnings.some((w) => /OpenStreetMap \+ Google Maps only/.test(w)));
  });
});
