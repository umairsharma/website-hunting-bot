import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeResults, businessProfile, classifyUrl, namesMatch, toWhatsApp, unwrapRedirect,
} from '../src/matching.js';
import { buildOverpassQuery, fetchCandidates, pickQueue, toCandidates } from '../src/overpass.js';
import { CATEGORIES, resolveCategories } from '../src/categories.js';
import { applyRunInputs, callingCodeFor, DEFAULT_NICHE } from '../src/inputs.js';
import { buildMessages, leadEmbed, sendMessages } from '../src/discord.js';
import { shortMapsUrl } from '../src/maps.js';
import { leadsText, whatsappMessages } from '../src/share.js';
import { normalizeConfig } from '../src/run.js';
import { appendLead, loadState, saveState } from '../src/storage.js';

const biz = (name, alt = []) => {
  const names = [name, ...alt];
  return { name, searchName: name, names, city: 'Lahore', profile: businessProfile(names, 'Lahore') };
};

test('namesMatch: same business, different wording', () => {
  assert.ok(namesMatch('Butt Karahi House', ['Butt Karahi']));
  assert.ok(namesMatch('Café Aylanto', ['Cafe Aylanto']));
  assert.ok(namesMatch('Dr. Rehman Dental Clinic', ['Rehman Dental Clinic']));
  assert.ok(namesMatch('Haveli Restaurant', ['Haveli']));
  assert.ok(namesMatch('Salt’n Pepper', ["Salt'n Pepper"]));
  assert.ok(namesMatch('The Monal', ['Monal Restaurant']));
});

test('namesMatch: different businesses', () => {
  assert.ok(!namesMatch('Haveli Sweets', ['Haveli Restaurant']));
  assert.ok(!namesMatch('Al Rehman Sweets', ['Al Rehman Bakers']));
  assert.ok(!namesMatch('Cafe Aylanto', ['Cafe']));
  assert.ok(!namesMatch('Pizza Hut', ['Pizza Point']));
  assert.ok(!namesMatch('Salon Zara', ['Salon']));
  assert.ok(!namesMatch('Ali Bakery Restaurant', ['Bakery Restaurant']));
  assert.ok(namesMatch('Salon', ['Salon']));
});

test('classifyUrl sorts links into own sites vs everything else', () => {
  assert.equal(classifyUrl('https://www.facebook.com/alibakers').kind, 'social');
  assert.equal(classifyUrl('https://m.facebook.com/alibakers').kind, 'social');
  assert.equal(classifyUrl('https://www.instagram.com/alibakers/').kind, 'social');
  assert.equal(classifyUrl('https://wa.me/923001234567').kind, 'social');
  assert.equal(classifyUrl('https://linktr.ee/alibakers').kind, 'social');
  assert.equal(classifyUrl('https://www.foodpanda.pk/restaurant/x/ali-bakers').kind, 'delivery');
  assert.equal(classifyUrl('https://www.marham.pk/doctors/lahore/dentist/x').kind, 'booking');
  assert.equal(classifyUrl('https://www.tripadvisor.com.pk/Restaurant_Review').kind, 'directory');
  assert.equal(classifyUrl('https://yellowpages.com.pk/x').kind, 'directory');
  assert.equal(classifyUrl('https://alibakers.business.site/').kind, 'dead');
  assert.equal(classifyUrl('https://maps.google.com/?cid=123').kind, 'maps');
  assert.equal(classifyUrl('https://g.page/alibakers').kind, 'maps');
  assert.equal(classifyUrl('mailto:x@y.com'), null);

  const own = classifyUrl('https://www.alibakers.com.pk/menu');
  assert.equal(own.kind, 'website');
  assert.equal(own.siteKey, 'alibakers');
  assert.equal(classifyUrl('https://ali-bakers.pk/').siteKey, 'alibakers');
  assert.ok(classifyUrl('https://ahmedsalon.wixsite.com/home').siteKey.includes('ahmedsalon'));
  const gsite = classifyUrl('https://sites.google.com/view/zamzamtailors');
  assert.equal(gsite.kind, 'website');
  assert.ok(gsite.siteKey.includes('zamzamtailors'));
  assert.equal(classifyUrl('https://www.google.com/url?q=https://www.alibakers.pk/&sa=U').host, 'alibakers.pk');
});

test('unwrapRedirect decodes Google, Bing and DuckDuckGo result links', () => {
  assert.equal(unwrapRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.alibakers.pk%2F&rut=abc'), 'https://www.alibakers.pk/');
  const b64 = Buffer.from('https://www.alibakers.pk/').toString('base64url');
  assert.equal(unwrapRedirect(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`), 'https://www.alibakers.pk/');
  assert.equal(unwrapRedirect('https://www.google.com/url?q=https://x.pk/&sa=U'), 'https://x.pk/');
  assert.equal(unwrapRedirect('https://plain.pk/'), 'https://plain.pk/');
});

test('analyzeResults: a domain named after the business = has a website', () => {
  assert.ok(analyzeResults([{ url: 'https://havelirestaurant.pk/', title: 'Food Street' }], biz('Haveli Restaurant')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://haveli.com.pk/', title: 'Home' }], biz('Haveli Restaurant')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://www.aylanto.com/', title: 'Aylanto' }], biz('Cafe Aylanto')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://buttkarahi.pk/', title: 'Home' }], biz('Butt Karahi House')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://ali-bakers.pk/', title: 'Home' }], biz('Ali Bakers')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://alibakers.wixsite.com/shop', title: 'Home' }], biz('Ali Bakers')).hasWebsite);
});

test('analyzeResults: socials, delivery apps, directories and news are not websites', () => {
  const r = analyzeResults([
    { url: 'https://www.facebook.com/buttkarahihouse/', title: 'Butt Karahi House - Home | Facebook' },
    { url: 'https://www.facebook.com/someoneelse/', title: 'Best karahi in town' },
    { url: 'https://www.foodpanda.pk/restaurant/abcd/butt-karahi-house', title: 'Butt Karahi House | foodpanda' },
    { url: 'https://restaurantguru.com/Butt-Karahi-House-Lahore', title: 'Butt Karahi House, Lahore' },
    { url: 'https://www.dawn.com/news/123456/lahores-best-karahi', title: 'Butt Karahi House wins award' },
    { url: 'https://lahore.gov.pk/', title: 'Lahore' },
    { url: 'https://karahi.com/', title: 'Karahi recipes' },
  ], biz('Butt Karahi House'));
  assert.equal(r.hasWebsite, false);
  assert.deepEqual(r.socials, ['https://www.facebook.com/buttkarahihouse/']);
  assert.deepEqual(r.possible, []);
});

test('analyzeResults: a homepage titled with the name but an unrelated domain is flagged, not excluded', () => {
  const r = analyzeResults(
    [{ url: 'https://smilecare-lahore.com/', title: 'Rehman Dental Clinic - Smile Care Lahore' }],
    biz('Rehman Dental Clinic'),
  );
  assert.equal(r.hasWebsite, false);
  assert.deepEqual(r.possible, ['smilecare-lahore.com']);
});

test('toWhatsApp builds links only for plausible mobile numbers', () => {
  assert.equal(toWhatsApp('0300-1234567', '92'), 'https://wa.me/923001234567');
  assert.equal(toWhatsApp('+92 300 1234567', '92'), 'https://wa.me/923001234567');
  assert.equal(toWhatsApp('+923001234567;042 111', '92'), 'https://wa.me/923001234567');
  assert.equal(toWhatsApp('042 35761234', '92'), null); // Lahore landline
  assert.equal(toWhatsApp('+44 20 7946 0958', '92'), null); // London landline
  assert.equal(toWhatsApp('+44 7700 900123', '92'), 'https://wa.me/447700900123');
  assert.equal(toWhatsApp('011 2345 6789', '91'), null); // Delhi landline
  assert.equal(toWhatsApp('098765 43210', '91'), 'https://wa.me/919876543210');
  assert.equal(toWhatsApp('+1 212 555 0100', '92'), 'https://wa.me/12125550100'); // can't tell, so allowed
  assert.equal(toWhatsApp('12345', '92'), null);
  assert.equal(toWhatsApp('', '92'), null);
  assert.equal(toWhatsApp('07947 595940', ''), null); // local number and no country code known
  assert.equal(toWhatsApp('+44 7947 595940', ''), 'https://wa.me/447947595940');
});

test('Overpass query: whole city', () => {
  const { defs } = resolveCategories(['restaurant', 'shop=bicycle']);
  const q = buildOverpassQuery({ defs, area: { type: 'area', areaId: 3600012345 }, skipChains: true });
  assert.match(q, /^\[out:json\]\[timeout:120\];/);
  assert.match(q, /area\(id:3600012345\)->\.searchArea;/);
  assert.ok(q.includes('nwr["amenity"="restaurant"]["name"][!"website"][!"contact:website"][!"url"][!"brand:wikidata"](area.searchArea);'));
  assert.ok(q.includes('nwr["shop"="bicycle"]'));
  assert.match(q, /out center;$/);
});

test('Overpass query: radius around a point, chains allowed', () => {
  const { defs } = resolveCategories(['cafe']);
  const q = buildOverpassQuery({ defs, area: { type: 'around', lat: 31.52, lon: 74.35, radiusM: 5000 }, skipChains: false });
  assert.ok(q.includes('nwr["amenity"="cafe"]["name"][!"website"][!"contact:website"][!"url"](around:5000,31.52,74.35);'));
  assert.doesNotMatch(q, /brand:wikidata|searchArea/);
});

test('Overpass query: city-name fallback', () => {
  const { defs } = resolveCategories(['cafe']);
  const q = buildOverpassQuery({ defs, area: { type: 'name', name: 'Lahore' }, skipChains: true });
  assert.ok(q.includes('(area["name"="Lahore"];area["name:en"="Lahore"];)->.searchArea;'));
});

test('Overpass query: city-name fallback stays inside the country', () => {
  const { defs } = resolveCategories(['cafe']);
  const q = buildOverpassQuery({ defs, area: { type: 'name', name: 'Hyderabad', country: 'Pakistan' }, skipChains: true });
  assert.ok(q.includes('(area["admin_level"="2"]["name"="Pakistan"];area["admin_level"="2"]["name:en"="Pakistan"];)->.country;'));
  assert.ok(q.includes('(rel["name"="Hyderabad"](area.country);rel["name:en"="Hyderabad"](area.country););'));
  assert.ok(q.includes('map_to_area->.searchArea;'));
  assert.ok(q.indexOf('map_to_area') < q.indexOf('nwr['));
});

test('categories: unknown names are reported, raw tags accepted', () => {
  const { defs, unknown } = resolveCategories(['restaurant', 'spaceships', 'shop=bicycle', 'Dentist']);
  assert.deepEqual(defs.map((d) => d.id), ['restaurant', 'shop=bicycle', 'dentist']);
  assert.deepEqual(unknown, ['spaceships']);
});

test('toCandidates: filters chains, websites, unnamed and duplicates', () => {
  const { defs } = resolveCategories(['restaurant', 'bakery']);
  const cfg = { city: 'Lahore', skipChains: true };
  const elements = [
    { type: 'node', id: 1, lat: 31.52, lon: 74.35, tags: { name: 'Ali Bakers', shop: 'bakery', phone: '042 35761234;0300 1', 'addr:street': 'Main Blvd', 'addr:city': 'Lahore' } },
    { type: 'way', id: 2, center: { lat: 31.52001, lon: 74.35001 }, tags: { name: 'Ali Bakers', shop: 'bakery' } },
    { type: 'node', id: 3, lat: 31.5, lon: 74.3, tags: { name: 'KFC', amenity: 'restaurant', 'brand:wikidata': 'Q524757' } },
    { type: 'node', id: 4, lat: 31.5, lon: 74.3, tags: { name: 'Has Site', amenity: 'restaurant', 'contact:website': 'https://x.pk' } },
    { type: 'node', id: 5, lat: 31.5, lon: 74.3, tags: { shop: 'bakery' } },
    { type: 'node', id: 6, lat: 31.5, lon: 74.3, tags: { name: 'Book Stall', shop: 'books' } },
    { type: 'node', id: 7, lat: 31.5, lon: 74.3, tags: { name: 'لاہور کڑاہی', 'name:en': 'Lahore Karahi', amenity: 'restaurant', 'contact:facebook': 'lahorekarahi' } },
    { type: 'node', id: 8, lat: 31.6, lon: 74.4, tags: { name: 'Bad Link Cafe', amenity: 'restaurant', 'contact:facebook': 'https://', 'contact:instagram': '@badlink' } },
    // The same shop mapped twice, 5 m apart across a rounding boundary (31.5675|31.5674): one lead, not two.
    { type: 'node', id: 9, lat: 31.567535, lon: 74.324944, tags: { name: 'shahbaz tikka house', amenity: 'restaurant' } },
    { type: 'node', id: 10, lat: 31.567486, lon: 74.324956, tags: { name: 'Shahbaz Tikka House', amenity: 'restaurant' } },
    // Same name, another branch 2 km away: kept.
    { type: 'node', id: 11, lat: 31.585, lon: 74.324956, tags: { name: 'Shahbaz Tikka House', amenity: 'restaurant' } },
  ];
  const out = toCandidates(elements, { defs, cfg });
  assert.deepEqual(out.map((c) => c.key), ['node/1', 'node/7', 'node/8', 'node/9', 'node/11']);
  assert.deepEqual(out[2].socials, ['https://www.instagram.com/badlink']); // the broken Facebook link is dropped
  assert.equal(out[0].phone, '042 35761234');
  assert.equal(out[0].address, 'Main Blvd, Lahore');
  assert.equal(out[0].categoryLabel, 'Bakery / sweets');
  assert.equal(out[1].searchName, 'Lahore Karahi');
  assert.deepEqual(out[1].socials, ['https://www.facebook.com/lahorekarahi']);
});

test('pickQueue: new businesses first, categories mixed, retries last, finished ones skipped', () => {
  const mk = (key, category, phone = null) => ({ key, category, phone, address: null, openingHours: null, socials: [], searchName: key });
  const candidates = [
    mk('node/1', 'restaurant', '1'), mk('node/2', 'restaurant', '1'), mk('node/3', 'restaurant'),
    mk('node/4', 'cafe'), mk('node/5', 'cafe'), mk('node/6', 'restaurant'), mk('node/7', 'restaurant'),
  ];
  const state = {
    places: {
      'node/6': { status: 'unverified', attempts: 1 },
      'node/7': { status: 'has_website' },
      'node/5': { status: 'unverified', attempts: 3 },
    },
  };
  const { queue, pending } = pickQueue(candidates, state, 10, 3);
  assert.deepEqual(queue.map((c) => c.key), ['node/1', 'node/4', 'node/2', 'node/3', 'node/6']);
  assert.equal(pending, 5);
  assert.equal(pickQueue(candidates, state, 2, 3).queue.length, 2);
});

test('Discord messages stay within Discord limits', () => {
  const leads = Array.from({ length: 25 }, (_, i) => ({
    name: `Business ${i} ${'x'.repeat(300)}`,
    categoryLabel: 'Restaurant',
    phone: '0300 1234567',
    whatsapp: 'https://wa.me/923001234567',
    rating: 4.5,
    reviews: 120,
    address: 'A'.repeat(1500),
    socials: ['https://facebook.com/x_(y)'],
    notes: ['n'.repeat(1500)],
    checks: 'Checked: OpenStreetMap ✓ · Google Maps ✓ · Google ✓',
    mapsUrl: 'https://www.google.com/maps/place/x',
  }));
  const messages = buildMessages('summary', leads);
  assert.equal(messages.reduce((n, m) => n + m.embeds.length, 0), 25);
  assert.equal(messages[0].content, 'summary');
  for (const m of messages) {
    assert.ok(m.embeds.length <= 10);
    const chars = m.embeds.reduce((n, e) => n + e.title.length + e.footer.text.length
      + e.fields.reduce((k, f) => k + f.name.length + f.value.length, 0), 0);
    assert.ok(chars <= 6000, `message has ${chars} characters`);
    for (const e of m.embeds) {
      assert.ok(e.title.length <= 256);
      for (const f of e.fields) assert.ok(f.value.length <= 1024);
    }
  }
  const card = leadEmbed(leads[0]);
  assert.ok(card.title.startsWith('🔥'));
  assert.ok(card.fields.find((f) => f.name === 'Social pages').value.includes('%28y%29'));
  assert.deepEqual(buildMessages('only text', []), [{ content: 'only text', embeds: [] }]);
});

test('config: city required, bad values cleaned up', () => {
  assert.throws(() => normalizeConfig({ city: '' }), /city/);
  const { cfg, notes } = normalizeConfig({ city: ' Lahore ', searchEngines: ['Google', 'yahoo'], delaySeconds: 3, maxChecksPerRun: '10' });
  assert.equal(cfg.city, 'Lahore');
  assert.deepEqual(cfg.searchEngines, ['google']);
  assert.deepEqual(cfg.delaySeconds, [3, 3]);
  assert.equal(cfg.maxChecksPerRun, 10);
  assert.match(notes[0], /yahoo/);
  assert.deepEqual(normalizeConfig({ city: 'X', searchEngines: ['nope'] }).cfg.searchEngines, ['google', 'brave', 'startpage', 'bing', 'duckduckgo']);
  assert.deepEqual(normalizeConfig({ city: 'X', searchEngines: ['Brave', 'startpage'] }).cfg.searchEngines, ['brave', 'startpage']);
});

test('storage: state round-trips, CSV is escaped and formula-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whb-unit-'));
  assert.deepEqual(loadState(dir), { version: 1, places: {} });
  const state = { version: 1, places: { 'node/1': { status: 'lead', name: 'A "quoted", name' }, 'way/2': { status: 'closed' } } };
  saveState(dir, state);
  assert.deepEqual(loadState(dir), state);

  appendLead(dir, { foundOn: '2026-09-26', name: '=HYPERLINK("x")', categoryLabel: 'Café', phone: '+92 300 1234567', address: 'Shop 4, "Main" Road', notes: ['a', 'b'], socials: [] });
  const lines = fs.readFileSync(path.join(dir, 'leads.csv'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^found_on,name,category,phone/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(lines[1].includes(',+92 300 1234567,'));
  assert.ok(lines[1].includes('"Shop 4, ""Main"" Road"'));

  appendLead(dir, { foundOn: '2026-09-27', name: 'B', phone: '=cmd|x', address: '\tx' });
  const row = fs.readFileSync(path.join(dir, 'leads.csv'), 'utf8').trim().split('\n')[2];
  assert.ok(row.includes(",'=cmd|x,"), row);
  assert.ok(row.includes(",'\tx,"), row);
});

test('Discord: a rejected message is resent card by card', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data);
      bodies.push(body);
      const bad = (body.embeds || []).some((e) => e.title === 'Bad');
      res.writeHead(bad ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(bad ? '{"embeds":["invalid"]}' : '{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const card = (name) => ({ name, categoryLabel: 'Cafe', checks: 'x', mapsUrl: 'https://maps.example/x' });
    const messages = buildMessages('summary', [card('Good 1'), card('Bad'), card('Good 2')]);
    const result = await sendMessages(`http://127.0.0.1:${server.address().port}/hook`, messages);
    assert.deepEqual(result, { sent: 3, total: 4 }); // summary + 2 good cards; only the bad card is lost
    assert.equal(bodies.length, 5);
    assert.deepEqual(bodies.slice(1).map((b) => b.content || b.embeds[0].title), ['summary', 'Good 1', 'Bad', 'Good 2']);
  } finally {
    server.close();
  }
});

test('OpenStreetMap: one query per category, cached for a week, old copy used when servers are down', async () => {
  let down = false;
  const queries = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      queries.push(new URLSearchParams(data).get('data'));
      if (down) {
        res.writeHead(504);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ elements: [
        { type: 'node', id: 1, lat: 31.5, lon: 74.3, tags: { name: 'Ali Bakers', shop: 'bakery' } },
        { type: 'node', id: 2, lat: 31.6, lon: 74.4, tags: { name: 'Cafe Aylanto', amenity: 'cafe' } },
      ] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whb-osm-'));
  const { defs } = resolveCategories(['bakery', 'cafe']);
  const cfg = { city: 'Lahore', country: 'Pakistan', radiusKm: 0, center: null, skipChains: true };
  const ep = { overpass: [`http://127.0.0.1:${server.address().port}/a`, `http://127.0.0.1:${server.address().port}/b`] };
  const area = { type: 'area', areaId: 3600000001 };
  const opts = { cfg, area, defs, ep, dataDir: dir, save: true, retryDelayMs: 0 };
  try {
    const first = await fetchCandidates(opts);
    assert.equal(queries.length, 2); // one per category
    assert.ok(queries[0].includes('shop"="bakery') && !queries[0].includes('amenity"="cafe'));
    assert.deepEqual(first.candidates.map((c) => c.key), ['node/1', 'node/2']);
    assert.deepEqual(first.notes, []);

    const cached = await fetchCandidates(opts);
    assert.equal(queries.length, 2); // fresh cache → no new downloads
    assert.equal(cached.candidates.length, 2);

    // Make the cache 10 days old and take the servers down: the old copy is used, with a note.
    const file = path.join(dir, 'osm-cache.json');
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"fetched": "[^"]+"/g, `"fetched": "${old}"`));
    down = true;
    const stale = await fetchCandidates(opts);
    assert.equal(stale.candidates.length, 2);
    assert.match(stale.notes[0], /older saved data was used for: Bakery \/ sweets, Café/);

    // No cache and servers down → the run fails with a clear error.
    await assert.rejects(fetchCandidates({ ...opts, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'whb-osm-')) }), /Could not reach any OpenStreetMap/);
  } finally {
    server.close();
  }
});

test('Run workflow form: city/country/niche apply to that run only, empty boxes keep config.js', () => {
  const config = { city: 'Birmingham', country: 'United Kingdom', center: { lat: 52.4, lon: -1.9 }, phoneCountryCode: '44', categories: ['restaurant', 'cafe'] };

  const none = applyRunInputs(config, { HUNT_CITY: '', HUNT_COUNTRY: '', HUNT_NICHE: DEFAULT_NICHE });
  assert.deepEqual(none.config, config);
  assert.equal(none.label, null);
  assert.equal(applyRunInputs(config, {}).label, null); // the daily run sets nothing

  const city = applyRunInputs(config, { HUNT_CITY: ' Lahore ', HUNT_COUNTRY: 'Pakistan', HUNT_NICHE: 'dentist' });
  assert.equal(city.config.city, 'Lahore');
  assert.equal(city.config.country, 'Pakistan');
  assert.equal(city.config.center, null); // Birmingham's centre point must not carry over
  assert.equal(city.config.phoneCountryCode, '92');
  assert.deepEqual(city.config.categories, ['dentist']);
  assert.equal(city.label, 'Manual run: Lahore, Pakistan · Dentist');
  assert.equal(config.city, 'Birmingham'); // config.js values untouched

  const nicheOnly = applyRunInputs(config, { HUNT_NICHE: 'gym' });
  assert.equal(nicheOnly.config.city, 'Birmingham');
  assert.deepEqual(nicheOnly.config.categories, ['gym']);
  assert.equal(nicheOnly.label, 'Manual run: Gym');

  const noCountry = applyRunInputs(config, { HUNT_CITY: 'Leeds' });
  assert.equal(noCountry.config.country, '');
  assert.equal(noCountry.config.phoneCountryCode, '');

  assert.equal(callingCodeFor('UK'), '44');
  assert.equal(callingCodeFor('united states'), '1');
  assert.equal(callingCodeFor('Atlantis'), '');
});

test('Run workflow form: the business-type list matches the categories the bot knows', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/hunt.yml', import.meta.url), 'utf8');
  const block = yml.slice(yml.indexOf('niche:'), yml.indexOf('permissions:'));
  const options = [...block.matchAll(/^\s+- "?([^"\n]+)"?$/gm)].map((m) => m[1].trim());
  assert.equal(options[0], DEFAULT_NICHE);
  assert.ok(block.includes(`default: "${DEFAULT_NICHE}"`));
  assert.deepEqual(options.slice(1), Object.keys(CATEGORIES));
});

test('Google Maps link on every lead card: their listing, or the location when not listed', () => {
  // A real listing URL becomes a short permanent ?cid= link.
  const long = 'https://www.google.com/maps/place/Crusty+Cottage+Bakery/@52.4,-1.9,17z/data=!3m1!4b1!4m6!3m5!1s0x4870bc5f0d3bb1c3:0x8a5e3f44a2b1c0d9!8m2!3d52.4!4d-1.9?hl=en';
  assert.equal(shortMapsUrl(long), `https://maps.google.com/?cid=${BigInt('0x8a5e3f44a2b1c0d9')}`);
  assert.equal(shortMapsUrl('https://example.com/maps/place/x'), 'https://example.com/maps/place/x');

  const base = { name: 'Crusty Cottage Bakery', categoryLabel: 'Bakery', checks: 'x', city: 'Birmingham' };
  const listed = leadEmbed({ ...base, onMaps: true, mapsUrl: 'https://maps.google.com/?cid=123' });
  assert.equal(listed.fields.find((f) => f.name === '📍 Google Maps').value, '[Open their Google Maps listing](https://maps.google.com/?cid=123)');
  assert.equal(listed.url, 'https://maps.google.com/?cid=123'); // the title still links there too

  const unlisted = leadEmbed({ ...base, onMaps: false, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=52.4,-1.9' });
  assert.match(unlisted.fields.find((f) => f.name === '📍 Google Maps').value, /^Not listed on Google Maps · \[See the location\]\(https:\/\/www\.google\.com\/maps\/search\//);

  const huge = leadEmbed({ ...base, onMaps: true, address: '1 High St', mapsUrl: `https://www.google.com/maps/place/x/${'a'.repeat(1200)}` });
  const value = huge.fields.find((f) => f.name === '📍 Google Maps').value;
  assert.ok(value.length < 1024);
  assert.ok(value.includes('query=Crusty%20Cottage%20Bakery%2C%201%20High%20St'));
});

test('Send to WhatsApp: every lead in a wa.me link, messages within Discord limits', () => {
  const leads = Array.from({ length: 23 }, (_, i) => ({
    name: `Business (${i}) & Sons Ltd`,
    categoryLabel: 'Car repair',
    phone: `+1 713 555 01${String(i).padStart(2, '0')}`,
    mapsUrl: `https://maps.google.com/?cid=${12345678901234567890n + BigInt(i)}`,
  }));
  const messages = whatsappMessages(leads, 'Houston, United States');
  assert.ok(messages.length >= 2 && messages.length <= 4, `${messages.length} messages`);
  const sent = [];
  for (const m of messages) {
    assert.ok(m.content.length <= 2000, `content is ${m.content.length} characters`);
    assert.ok(m.embeds[0].description.length <= 4096);
    const url = m.content.match(/\]\((https:\/\/wa\.me\/\?text=[^)\s]+)\)/)[1]; // brackets in names don't break the link
    const text = decodeURIComponent(new URL(url).searchParams.get('text'));
    assert.equal(text, m.embeds[0].description); // the link and the copy-ready list match
    for (const line of text.split('\n').filter((l) => /^\d+\. /.test(l))) sent.push(line);
  }
  assert.equal(sent.length, 23); // every lead exactly once, in order
  assert.deepEqual(sent.map((l) => Number(l.split('.')[0])), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.match(messages[0].content, /Send leads 1–\d+ to WhatsApp/);

  const one = whatsappMessages(leads.slice(0, 1), 'Houston, United States');
  assert.equal(one.length, 1);
  assert.match(one[0].content, /Send this lead to WhatsApp/);
  assert.deepEqual(whatsappMessages([], 'x'), []);

  const text = leadsText(leads.slice(0, 2), 'Houston, United States');
  assert.equal(text, [
    '🎯 2 website leads · Houston, United States',
    '1. Business (0) & Sons Ltd (Car repair)\n📞 +1 713 555 0100\n📍 https://maps.google.com/?cid=12345678901234567890',
    '2. Business (1) & Sons Ltd (Car repair)\n📞 +1 713 555 0101\n📍 https://maps.google.com/?cid=12345678901234567891',
  ].join('\n\n'));
});
