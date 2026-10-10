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
  mapsDiscovery: false, // tested on its own below
  findSocials: false, // tested on its own below
  phoneCheck: false, // tested on its own below
  ai: false, // tested on its own below
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
    SITE_FETCH_BASE: server.base,
    GEMINI_BASE_URL: `${server.base}/gemini`,
    GEMINI_API_KEY: 'test-key',
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
    for (const e of msg.embeds) assert.match(e.description, /^📲 \*\*\[Send this lead to WhatsApp\]\(https:\/\/wa\.me\/\?text=/);
    const runLeads = fs.readFileSync(path.join(dataDir, 'run-leads.txt'), 'utf8');
    assert.match(runLeads, /^🎯 3 website leads · Lahore, Pakistan/);
    assert.match(msg.content, /Each card has a "Send this lead to WhatsApp" link/);
    assert.ok(msg.embeds.find((e) => e.title === '🔥 Butt Karahi House'));
    for (const e of msg.embeds) assert.ok(e.fields.some((f) => f.name === '📍 Google Maps'), `${e.title} has no Google Maps link`);

    // Saved state
    const seen = readJson(dataDir, 'seen.json');
    const own = Object.values(seen.places).filter((p) => !p.sameAs);
    assert.equal(own.length, 6);
    // Each business found on Google Maps is also filed under its Maps place, so a Maps search can't bring it back.
    assert.equal(Object.keys(seen.places).filter((k) => k.startsWith('gmaps/')).length, 4);
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

test('Google Maps search: finds plumbers OpenStreetMap lacks, skips ones whose card shows a website, never repeats', { timeout: 240000 }, async () => {
  await withServer({}, async (server) => {
    const dataDir = tempDir();
    const logs = [];
    const config = { ...CONFIG, categories: ['plumber'], mapsDiscovery: true };
    const result = await run({ config, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m) });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    assert.equal(result.candidates, 0); // OpenStreetMap has no plumbers here
    assert.ok(server.requests.maps.includes('plumbers in Lahore, Pakistan'), server.requests.maps.join(' | '));
    assert.equal(result.discovered, 3, logText); // 4 on the list (2 after scrolling); Pipe Masters' card shows its website
    assert.equal(result.checked, 3, logText);
    assert.equal(result.hasWebsite, 1, logText); // Ace Drain Co: website button on its listing
    assert.deepEqual(result.leads.map((l) => l.name).sort(), ['Delta Rooter', 'Mike Pipe Fix']);
    const mike = result.leads.find((l) => l.name === 'Mike Pipe Fix');
    assert.equal(mike.phone, '0321 1234567');
    assert.equal(mike.whatsapp, 'https://wa.me/923211234567');
    assert.equal(mike.rating, 4.8);
    assert.match(mike.mapsUrl, /^https:\/\/maps\.google\.com\/\?cid=\d+$/);
    assert.equal(mike.categoryLabel, 'Plumber');
    assert.match(server.requests.discord.at(-1).content, /found by searching Google Maps/);

    const seen = readJson(dataDir, 'seen.json').places;
    assert.equal(Object.values(seen).find((p) => p.name === 'Pipe Masters').layer, 'maps list');

    // Next run: everything on the list is known, so nothing is checked or sent twice.
    const again = await run({ config, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: () => {} });
    assert.equal(again.checked, 0);
    assert.equal(again.leads.length, 0);
    assert.ok(again.warnings.some((w) => /already been checked/.test(w)), again.warnings.join(' | '));
  });
});

test('Google Maps search: any typed-in business type, with no categories at all', { timeout: 180000 }, async () => {
  await withServer({}, async (server) => {
    const result = await run({
      config: { ...CONFIG, categories: [], mapsSearch: ['plumbers'], mapsDiscovery: true }, dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: () => {},
    });
    assert.equal(result.error, null);
    assert.equal(server.requests.overpass.length, 0); // OpenStreetMap isn't asked
    assert.equal(result.leads.length, 2);
    assert.ok(result.leads.every((l) => l.categoryLabel === 'Plumbers'));
  });
});

test('Google Maps search blocked: says so, and checks what it has', { timeout: 180000 }, async () => {
  await withServer({ mapsSearchBlocked: true }, async (server) => {
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true }, dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: () => {},
    });
    assert.equal(result.error, null);
    assert.equal(result.checked, 0);
    assert.ok(result.warnings.some((w) => /Google Maps blocked the search/.test(w)), result.warnings.join(' | '));
  });
});

test('OpenStreetMap down: still searches Google Maps instead of failing the run', { timeout: 180000 }, async () => {
  await withServer({ overpassDown: true }, async (server) => {
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true }, dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: () => {},
    });
    assert.equal(result.error, null);
    assert.ok(server.requests.overpass.length > 0);
    assert.deepEqual(result.leads.map((l) => l.name).sort(), ['Delta Rooter', 'Mike Pipe Fix']);
    assert.ok(result.warnings.some((w) => /only Google Maps was searched/.test(w)), result.warnings.join(' | '));
  });
});

test('Social media: finds the Instagram and Facebook of a lead by searching, skips pages of other businesses', { timeout: 180000 }, async () => {
  await withServer({}, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true, findSocials: true },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    const mike = result.leads.find((l) => l.name === 'Mike Pipe Fix');
    assert.deepEqual(mike.socials, ['https://www.instagram.com/mikepipefix/', 'https://www.facebook.com/MikePipeFixLahore/']);
    assert.ok(server.requests.google.some((q) => q === 'Mike Pipe Fix Lahore instagram'), server.requests.google.join(' | '));
    assert.ok(!server.requests.google.some((q) => q.endsWith(' facebook'))); // one social search per lead
    assert.match(logText, /📱 Instagram: @mikepipefix/);
    // The card's extra details
    assert.equal(mike.category, 'Plumber');
    assert.deepEqual(mike.hours.days, [['Monday', '9 AM–6 PM'], ['Tuesday', '9 AM–6 PM'], ['Sunday', 'Closed']]);
    assert.equal(mike.since, '2008 (Yellow Pages)');
    assert.deepEqual(mike.listings.map((l) => l.name), ['Yellow Pages']);
    assert.deepEqual(mike.socialActivity, { 'instagram/mikepipefix': '1,234 followers · 56 posts', 'facebook/mikepipefixlahore': '890 likes · 4 talking about this · 12 check-ins' });
    const delta = result.leads.find((l) => l.name === 'Delta Rooter');
    assert.deepEqual(delta.socials, []); // the only Instagram result is another business
    const card = server.requests.discord.at(-1).embeds.find((e) => e.title.endsWith('Mike Pipe Fix'));
    assert.equal(card.fields.find((f) => f.name === '🕒 Hours').value, 'Monday: 9 AM–6 PM\nTuesday: 9 AM–6 PM\nSunday: Closed');
    const shared = new URL(card.description.match(/\((https:\/\/wa\.me[^)\s]+)\)/)[1]).searchParams.get('text');
    for (const detail of ['*Mike Pipe Fix*', '🏠 Address: 3 Ferozepur Rd, Lahore', '🔎 Google search for them: https://www.google.com/search?q=',
      '📍 Their Google Maps listing: https://maps.google.com/?cid=', '✉️ Email: mikepipefix@gmail.com', '📞 Phone: 0321 1234567',
      '📸 Instagram profile (@mikepipefix): https://www.instagram.com/mikepipefix/']) assert.ok(shared.includes(detail), `${detail}\n---\n${shared}`);
    assert.ok(!shared.includes('🕒'), shared); // the short version only
    assert.equal(mike.email, 'mikepipefix@gmail.com');
    assert.equal(card.fields.find((f) => f.name === 'Email').value, 'mikepipefix@gmail.com');
    assert.match(card.fields.find((f) => f.name === 'Social media').value, /📸 \[Instagram @mikepipefix\]\(https:\/\/www\.instagram\.com\/mikepipefix\/\)/);
  });
});

test('Phone check: a site with a different name counts when their phone number is on it', { timeout: 180000 }, async () => {
  await withServer({ phoneSites: true }, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true, phoneCheck: true },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    // Delta Rooter: drainheroes-lhr.example came up in the name search and shows their number
    assert.match(logText, /Has a website: drainheroes-lhr\.example \(found by web search, their phone number is on it\)/);
    // Mike Pipe Fix: found by searching the number; OLX is a directory and the plumbers hub shows another number
    assert.ok(server.requests.google.includes('"0321 1234567"'), server.requests.google.join(' | '));
    assert.match(logText, /Has a website: mpf-services\.example/);
    assert.ok(!server.requests.sites.some((u) => u.includes('olx')));
    assert.deepEqual(result.leads.map((l) => l.name), []);
  });
});

test('Google Maps booking link: a Square/Wix site there counts as their website; a booking app is a note', { timeout: 180000 }, async () => {
  const bookingLinks = { 'delta-rooter': 'http://deltarooter.square.site/', 'mike-pipe-fix': 'https://www.fresha.com/a/mike-pipe-fix-lahore' };
  await withServer({ bookingLinks }, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    assert.match(logText, /Has a website: deltarooter\.square\.site \(found by Google Maps, their booking\/menu link on Google Maps\)/);
    const mike = result.leads.find((l) => l.name === 'Mike Pipe Fix');
    assert.ok(mike.notes.some((n) => /Takes bookings\/orders through Fresha/.test(n)), mike.notes.join(' | '));
    assert.deepEqual(result.leads.map((l) => l.name), ['Mike Pipe Fix']);
  });
});

test('Recheck: earlier leads go through the latest checks; ones with a website are dropped, the rest re-sent', { timeout: 240000 }, async () => {
  await withServer({}, async (server) => {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'recheck.json'), JSON.stringify([
      { key: 'node/2', name: 'Butt Karahi House', category: 'Restaurant', city: 'Lahore', country: 'Pakistan', phone: '+92 300 1112222', address: null, email: null, mapsUrl: null, osmUrl: null },
      { key: 'node/1', name: 'Ali Bakers', category: 'Bakery', city: 'Lahore', country: 'Pakistan', phone: null, address: null, email: null, mapsUrl: null, osmUrl: null },
      { key: 'node/5', name: 'Rehman Dental Clinic', category: 'Dentist', city: 'Lahore', country: 'Pakistan', phone: null, address: null, email: null, mapsUrl: null, osmUrl: null },
    ]));
    fs.writeFileSync(path.join(dataDir, 'seen.json'), JSON.stringify({ version: 1, places: {
      'node/1': { status: 'lead', name: 'Ali Bakers', checked: '2026-09-01' },
      'node/2': { status: 'lead', name: 'Butt Karahi House', checked: '2026-09-01' },
      'node/5': { status: 'lead', name: 'Rehman Dental Clinic', checked: '2026-09-01' },
    } }));
    const logs = [];
    const config = { ...CONFIG, city: 'Nashville', country: 'United States', phoneCountryCode: '1', recheck: true, maxChecksPerRun: 2 };
    const result = await run({ config, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m) });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    assert.equal(server.requests.overpass.length, 0); // no new businesses are looked for
    assert.equal(result.checked, 2, logText); // a batch of 2
    assert.deepEqual(result.leads.map((l) => l.name), ['Butt Karahi House']);
    assert.equal(result.leads[0].whatsapp, 'https://wa.me/923001112222'); // its own country, not the config's
    assert.equal(result.leads[0].city, 'Lahore');
    assert.equal(result.hasWebsite, 1); // Ali Bakers: website on Google Maps, dropped
    const seen = readJson(dataDir, 'seen.json').places;
    assert.equal(seen['node/1'].status, 'has_website');
    // One left, for the next run
    assert.deepEqual(readJson(dataDir, 'recheck.json').map((i) => i.name), ['Rehman Dental Clinic']);
    assert.equal(result.recheckLeft, 1);
    assert.match(server.requests.discord.at(-1).content, /Rechecked 2 earlier leads\*\* with the latest checks: 1 still have no website \(below\), 1 have one \(dropped\)/);
    assert.match(server.requests.discord.at(-1).content, /1 earlier leads still to recheck/);
    const csv = fs.readFileSync(path.join(dataDir, 'leads.csv'), 'utf8');
    assert.ok(csv.includes('Butt Karahi House') && !csv.includes('Ali Bakers'));

    // The last one: the list is finished and its file removed.
    const done = await run({ config, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: () => {} });
    assert.equal(done.recheckLeft, 0);
    assert.ok(!fs.existsSync(path.join(dataDir, 'recheck.json')));
  });
});

test('Address and email check: a site found by their street address, with their name on it, is theirs', { timeout: 180000 }, async () => {
  await withServer({ addressSites: true }, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true, phoneCheck: true },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    // Mike Pipe Fix: email found (gmail, so no site from it), then "email" OR "street" searched
    assert.ok(server.requests.google.some((q) => q.includes('"mikepipefix@gmail.com" OR "3 Ferozepur Rd"')), server.requests.google.join(' | '));
    assert.match(logText, /Has a website: lahorepipeworks\.example \(found by web search, their address and name are on it\)/);
    assert.ok(!result.leads.some((l) => l.name === 'Mike Pipe Fix'));
    assert.ok(result.leads.some((l) => l.name === 'Delta Rooter')); // its address search finds nothing of theirs
  });
});

test('Email from a directory listing page: the business\'s own, not the directory\'s or a neighbour\'s', { timeout: 180000 }, async () => {
  await withServer({ listingEmail: true }, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    const delta = result.leads.find((l) => l.name === 'Delta Rooter');
    assert.equal(delta.email, 'deltarooter.lhr@gmail.com', logText);
    assert.match(logText, /Their Yellow Pages listing: email/);
    assert.ok(server.requests.sites.includes('https://www.yellowpages.com.pk/delta-rooter'));
    assert.ok(!server.requests.google.some((q) => q === 'Delta Rooter Lahore email')); // found without another search
  });
});

test('AI (Gemini): picks the Maps listing under another name, reads listing pages for other numbers, judges sites', { timeout: 240000 }, async () => {
  const scenario = {
    // Noor Clinic is on Google Maps under the dentist's name; Maps shows a list without "Noor Clinic" in it.
    extraElements: [{ type: 'node', id: 11, lat: 31.53, lon: 74.36, tags: { name: 'Noor Clinic', amenity: 'dentist' } }],
    mapsLists: { 'Noor Clinic': [['Dr. Ahmed Family Dental Care', 'noor-dental'], ['City Pharmacy', 'city-pharmacy']] },
    places: { 'noor-dental': { title: 'Dr. Ahmed Family Dental Care', website: 'https://ahmeddental.example/', address: '5 Canal Bank Rd, Lahore' } },
    // Delta Rooter's Yellow Pages listing has another phone number; a site shows that one.
    results: [
      { match: 'Delta Rooter Lahore', results: [{ url: 'https://www.yellowpages.com.pk/delta-rooter', title: 'Delta Rooter - Plumbers in Lahore' }] },
      { match: '"0300 7654321"', results: [{ url: 'https://lahore-drains.example/', title: 'Home' }] },
    ],
    sites: {
      'https://www.yellowpages.com.pk/delta-rooter': `<h1>Delta Rooter</h1><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@graph': [
          { '@type': 'Plumber', name: 'Delta Rooter', telephone: '0300 7654321', address: { '@type': 'PostalAddress', streetAddress: '9 Old Jail Rd' } },
          { '@type': 'Plumber', name: 'Ace Drain Co', telephone: '0300 1234500' },
        ] })}</script>`,
      'https://lahore-drains.example/': '<h1>Lahore Drains</h1><p>Call 0300-765-4321</p>',
      // Mike Pipe Fix's site: no phone number on it, only the AI can tell it's theirs.
      'https://mikefix-pk.example/': "<h1>Mike's Fixes</h1><p>Mike fixes pipes all over Lahore since 2008.</p>",
    },
    gemini: [
      { match: ['Noor Clinic', 'Dr. Ahmed Family Dental Care'], reply: { match: 0, confidence: 'high', reason: 'Noor Clinic is run by Dr. Ahmed' } },
      { match: ['Search Google', 'Mike Pipe Fix'], reply: { hasWebsite: true, url: 'mikefix-pk.example', confidence: 'medium', reason: 'found their site' } },
      { match: ['Does this website belong', 'mikefix-pk.example'], reply: { belongs: true, confidence: 'high', reason: 'same owner, same town' } },
    ],
  };
  await withServer(scenario, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber', 'dentist'], mapsDiscovery: true, phoneCheck: true, ai: true, aiMinIntervalMs: 0 },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    assert.ok(server.requests.gemini.length > 0 && server.requests.gemini.every((r) => r.key === 'test-key' && r.model === 'gemini-2.5-flash'));
    // Maps: the AI picked the listing, and its website button counts
    assert.match(logText, /AI: it's on Google Maps as "Dr\. Ahmed Family Dental Care"/);
    assert.match(logText, /Has a website: ahmeddental\.example \(found by Google Maps\)/);
    // Listing page: another phone number, searched on its own, finds their site
    assert.match(logText, /Their Yellow Pages listing: phone, address/);
    assert.ok(server.requests.google.includes('"0300 7654321"'), server.requests.google.join(' | '));
    assert.match(logText, /Has a website: lahore-drains\.example \(found by web search, their phone number is on it\)/);
    // The AI's Google search found a site; it read the page and said it's theirs
    assert.ok(server.requests.gemini.some((r) => r.search && r.prompt.includes('Mike Pipe Fix')));
    assert.match(logText, /Has a website: mikefix-pk\.example \(found by web search, the AI found it on Google; the AI read it: same owner, same town\)/);
    assert.ok(!result.leads.some((l) => ['Mike Pipe Fix', 'Delta Rooter', 'Noor Clinic'].includes(l.name)), logText);
    for (const lead of result.leads) assert.match(lead.checks, /AI ✓/);
  });
});

test('AI (Gemini): daily limit reached → the run carries on without it and says so', { timeout: 180000 }, async () => {
  const geminiStatus = { status: 429, text: '{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}' };
  await withServer({ geminiStatus }, async (server) => {
    const logs = [];
    const result = await run({
      config: { ...CONFIG, categories: ['plumber'], mapsDiscovery: true, ai: true, aiMinIntervalMs: 0 },
      dataDir: tempDir(), webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m),
    });
    const logText = logs.join('\n');
    assert.equal(result.error, null, logText);
    assert.equal(server.requests.gemini.length, 1); // asked once, then left alone
    assert.ok(result.warnings.some((w) => /AI \(Gemini\): Gemini's free daily limit was reached/.test(w)), result.warnings.join(' | '));
    assert.ok(result.leads.some((l) => l.name === 'Mike Pipe Fix'));
  });
});
