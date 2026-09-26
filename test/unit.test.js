import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeResults, businessProfile, classifyUrl, namesMatch, toWhatsApp, unwrapRedirect,
} from '../src/matching.js';
import { buildOverpassQuery, pickQueue, toCandidates } from '../src/overpass.js';
import { resolveCategories } from '../src/categories.js';
import { buildMessages, leadEmbed } from '../src/discord.js';
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
  assert.equal(toWhatsApp('+44 20 7946 0958', '92'), 'https://wa.me/442079460958');
  assert.equal(toWhatsApp('12345', '92'), null);
  assert.equal(toWhatsApp('', '92'), null);
});

test('Overpass query: whole city', () => {
  const { defs } = resolveCategories(['restaurant', 'shop=bicycle']);
  const q = buildOverpassQuery({ defs, area: { type: 'area', areaId: 3600012345 }, skipChains: true });
  assert.match(q, /^\[out:json\]\[timeout:180\];/);
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
  ];
  const out = toCandidates(elements, { defs, cfg });
  assert.deepEqual(out.map((c) => c.key), ['node/1', 'node/7']);
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
  assert.deepEqual(normalizeConfig({ city: 'X', searchEngines: ['nope'] }).cfg.searchEngines, ['google', 'bing', 'duckduckgo']);
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
});
