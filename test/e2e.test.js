// Full runs of the bot (real headless Chromium) against the fake services in mock-server.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer } from './mock-server.js';
import { run } from '../src/run.js';

const CONFIG = {
  city: 'Lahore',
  country: 'Pakistan',
  categories: ['restaurant', 'cafe', 'bakery', 'dentist', 'clothes'],
  maxChecksPerRun: 30,
  phoneCountryCode: '92',
  searchEngines: ['google', 'bing', 'duckduckgo'],
  delaySeconds: [0, 0],
};

async function withServer(scenario, fn) {
  const server = await startMockServer(scenario);
  const env = {
    NOMINATIM_URL: `${server.base}/nominatim`,
    OVERPASS_URLS: `${server.base}/overpass/interpreter`,
    MAPS_BASE_URL: `${server.base}/maps`,
    GOOGLE_BASE_URL: `${server.base}/google`,
    BING_BASE_URL: `${server.base}/bing`,
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
    const result = await run({ config: CONFIG, dataDir, webhookUrl: `${server.base}/discord/webhook`, log: (m) => logs.push(m) });
    const logText = logs.join('\n');

    assert.equal(result.error, null, logText);
    // Layer 1: 10 OSM elements → 6 real candidates (chain, has-website, unnamed and duplicate filtered out)
    assert.equal(result.candidates, 6, logText);
    assert.ok(server.requests.overpass[0].includes('area(id:3607431040)->.searchArea;'));
    assert.ok(server.requests.overpass[0].includes('nwr["shop"="tailor"]'));

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
    assert.match(butt.checks, /Google Maps ✓ · Google ✓/);
    assert.ok(butt.mapsUrl.startsWith(`${server.base}/maps/`));

    const rehman = result.leads.find((l) => l.name === 'Rehman Dental Clinic');
    assert.ok(rehman.notes.some((n) => /Facebook page/.test(n)), rehman.notes.join(' | '));
    assert.ok(rehman.notes.some((n) => /smilecare-lahore\.com/.test(n)), rehman.notes.join(' | '));
    assert.equal(rehman.socials.length, 1);
    assert.match(rehman.checks, /DuckDuckGo ✓/);

    const gone = result.leads.find((l) => l.name === 'Gone Store');
    assert.ok(gone.notes.some((n) => /Not on Google Maps/.test(n)));
    assert.equal(gone.mapsUrl, 'https://www.google.com/maps/search/?api=1&query=31.5,74.3');
    assert.equal(gone.whatsapp, null);

    // Discord: first POST got a 429 and was retried; one message with the summary + 3 lead cards
    assert.equal(server.requests.discord.length, 1);
    const msg = server.requests.discord[0];
    assert.equal(msg.embeds.length, 3);
    assert.match(msg.content, /3 new leads/);
    assert.match(msg.content, /Google blocked the bot, Bing didn't work, so it used DuckDuckGo/);
    assert.deepEqual(msg.allowed_mentions, { parse: [] });
    assert.ok(msg.embeds.find((e) => e.title === '🔥 Butt Karahi House'));

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
