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
import { CATEGORIES, MAPS_SEARCH, resolveCategories } from '../src/categories.js';
import { placeIdOf } from '../src/discover.js';
import { applyRunInputs, callingCodeFor, DEFAULT_NICHE } from '../src/inputs.js';
import { buildMessages, googleSearchUrl, leadEmbed, sendMessages } from '../src/discord.js';
import { shortMapsUrl } from '../src/maps.js';
import { MAX_LINK, hoursText, leadShareLink, leadText, leadsText } from '../src/share.js';
import { findSocials, orderSocials, socialLabel, socialProfile } from '../src/socials.js';
import { confirmByPhone, phonePattern, siteOrigins } from '../src/verify.js';
import { activityFor, listingsFrom, sinceFrom, socialActivityFrom } from '../src/details.js';
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
  assert.equal(classifyUrl('https://reviews.birdeye.com/hortons-a1-plumbing-123').kind, 'directory');
  assert.equal(classifyUrl('https://www.homeyou.com/ms/plumbers-decatur/x').kind, 'directory');
  assert.equal(classifyUrl('https://www.yellowbot.com/hood-plumbing.html').kind, 'directory');
  assert.equal(classifyUrl('https://ajax-plumbing-and-water-leaks.wheree.com/').kind, 'directory');
  assert.equal(classifyUrl('https://www.homescroller.com/x').kind, 'directory');
  assert.equal(classifyUrl('https://alibakers.business.site/').kind, 'dead');
  assert.equal(classifyUrl('https://maps.google.com/?cid=123').kind, 'maps');
  assert.equal(classifyUrl('https://g.page/alibakers').kind, 'maps');
  assert.equal(classifyUrl('https://bishop.edu/').kind, 'institution');
  assert.equal(classifyUrl('https://www.oxford.gov.uk/').kind, 'institution');
  assert.equal(classifyUrl('https://www.punjab.gov.pk/').kind, 'institution');
  assert.equal(classifyUrl('https://jackson.k12.ms.us/').kind, 'institution');
  assert.equal(classifyUrl('https://www.ox.ac.uk/').kind, 'institution');
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
  assert.ok(analyzeResults([{ url: 'https://haveli.com.pk/', title: 'Haveli Restaurant | Lahore' }], biz('Haveli Restaurant')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://www.aylanto.com/', title: 'Cafe Aylanto' }], biz('Cafe Aylanto')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://buttkarahi.pk/', title: 'Home' }], biz('Butt Karahi House')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://ali-bakers.pk/', title: 'Home' }], biz('Ali Bakers')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://alibakers.wixsite.com/shop', title: 'Home' }], biz('Ali Bakers')).hasWebsite);
});

test('analyzeResults: a trade word alone ("plumbing") does not make another company site theirs', () => {
  const jackson = biz('Jackson Plumbing Co.');
  jackson.profile = businessProfile(jackson.names, 'Jackson, Mississippi');
  assert.equal(analyzeResults([{ url: 'https://hattiesburgplumbingco.com/', title: 'Hattiesburg Plumbing Co' }], jackson).hasWebsite, false);
  assert.ok(analyzeResults([{ url: 'https://bufordplumbing.net/', title: 'Home' }], biz('BUFORD PLUMBING COMPANY, INC.')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://leakfreakplumbing.us/', title: 'Home' }], biz('Leak Freak Plumbing')).hasWebsite);
  assert.ok(analyzeResults([{ url: 'https://jacksonplumbingco.com/', title: 'Home' }], jackson).hasWebsite); // the full name still counts
});

test('analyzeResults: one common word of the name ("Bishop", "Johnson") does not make a site theirs', () => {
  const ms = (name) => {
    const b = biz(name);
    b.profile = businessProfile(b.names, 'Mississippi');
    return b;
  };
  const has = (url, name, title = 'Home') => analyzeResults([{ url, title }], ms(name)).hasWebsite;
  // Wrong matches from a real run
  assert.equal(has('https://bishopcisd.net/', 'Bishop Plumbing Service LLC', 'Bishop CISD'), false);
  assert.equal(has('https://barberhead.com/', 'Barber & Sons Plumbing Co'), false);
  assert.equal(has('https://johnsonhvacdist.com/', 'Johnson Plumbing', 'Johnson HVAC Distributors'), false);
  assert.equal(has('https://northeasternplumbingco.com/', 'North Ms Plumbing LLC'), false);
  // Real sites still count
  assert.ok(has('https://bishopplumbing.com/', 'Bishop Plumbing Service LLC'));
  assert.ok(has('https://bishopplumbingms.com/', 'Bishop Plumbing Service LLC'));
  assert.ok(has('https://mancusoservices.com/', 'Mancuso Brothers Plumbing'));
  assert.ok(has('https://harbornegarage.co.uk/', 'Harborne Auto Centre'));
  assert.equal(has('https://www.friendlysrestaurants.com/', 'Friendly Plumbers', "Friendly's Restaurants"), false);
  assert.equal(has('https://chapmannews.org/', 'Chapman Plumbing Co', 'Chapman News'), false);
  assert.equal(has('https://douglasus.com/', 'Douglas Plumbing, LLC', 'Douglas Products'), false);
  assert.equal(has('https://www.clarks.com/', 'Clark & Clark', 'Clarks Shoes'), false);
  assert.ok(has('https://barbersons.com/', 'Barber & Sons Plumbing Co'));
  assert.ok(has('https://johnsonplumbing247.com/', 'Johnson Plumbing'));
  // Just one word of the name, or a school / council site: not theirs (from a real run)
  assert.equal(has('https://jackson.com/', 'Jackson Plumbing Co.', 'Jackson | Annuities'), false);
  assert.equal(has('https://www.clarks.com/', 'Clark Plumbing Service, Inc', 'Clarks Shoes'), false);
  assert.equal(has('https://pinebelt.net/', 'Pinebelt Plumbing, LLC', 'Pine Belt Communications'), false);
  assert.equal(has('https://www.oxford.gov.uk/', 'Oxford Plumbing, LLC', 'Oxford City Council'), false);
  assert.equal(has('https://bishop.edu/', 'Bishop Plumbing Service LLC', 'Bishop State'), false);
  assert.ok(has('https://pinebelt.net/', 'Pinebelt Plumbing, LLC', 'Pinebelt Plumbing - Hattiesburg, MS'));
  const bare = analyzeResults([{ url: 'https://haveli.com.pk/', title: 'Home' }], biz('Haveli Restaurant'));
  assert.equal(bare.hasWebsite, false);
  assert.deepEqual(bare.possible, ['haveli.com.pk']); // shown as "Check first"
  // An extra word is fine when the page is titled with the business's name
  assert.ok(has('https://barberbrandon.com/', 'Barber & Sons Plumbing Co', 'Barber & Sons Plumbing | Brandon, MS'));
  assert.equal(has('https://barberbrandon.com/', 'Barber & Sons Plumbing Co', 'Barber shop in Brandon'), false);
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
  assert.ok(card.fields.find((f) => f.name === 'Social media').value.includes('%28y%29'));
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

  const typed = applyRunInputs(config, { HUNT_CUSTOM_NICHE: ' pool cleaners ', HUNT_NICHE: DEFAULT_NICHE });
  assert.deepEqual(typed.config.mapsSearch, ['pool cleaners']);
  assert.deepEqual(typed.config.categories, []); // only what was typed, not the daily list
  assert.equal(typed.label, 'Manual run: "pool cleaners" (Google Maps search)');
  const both = applyRunInputs(config, { HUNT_CUSTOM_NICHE: 'pool cleaners', HUNT_NICHE: 'plumber' });
  assert.deepEqual(both.config.categories, ['plumber']);

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

test('Send to WhatsApp: each card shares the full lead, within Discord limits', () => {
  const lead = {
    name: 'Snowflake (Donuts) & Co', categoryLabel: 'Bakery / sweets', rating: 4.8, reviews: 358,
    phone: '(713) 827-2808', whatsapp: 'https://wa.me/17138272808', email: 'hello@snowflake.example',
    address: '1234 Westheimer Rd, Houston, TX 77006', mapsUrl: 'https://maps.google.com/?cid=1841144998116252209',
    socials: ['https://www.facebook.com/snowflakedonuts', 'https://www.instagram.com/snowflakedonuts/'],
    notes: ['Their Google Maps "website" is just a Facebook page', 'Their Google listing is unclaimed'],
    category: 'Donut shop',
    hours: { status: 'Closed · Opens 6 AM', days: [['Monday', '6 AM–2 PM'], ['Tuesday', '6 AM–2 PM'], ['Sunday', 'Closed']] },
    since: '1998 (BBB)',
    socialActivity: { 'instagram/snowflakedonuts': '12.4K followers · 830 posts', 'facebook/snowflakedonuts': '3.1K likes' },
    listings: [{ name: 'Yelp', url: 'https://www.yelp.com/biz/snowflake-donuts-houston' }, { name: 'BBB', url: 'https://www.bbb.org/x' }],
  };
  const card = leadEmbed(lead);
  assert.equal(card.fields.find((f) => f.name === '🕒 Hours').value, 'Monday: 6 AM–2 PM\nTuesday: 6 AM–2 PM\nSunday: Closed');
  assert.equal(card.fields.find((f) => f.name === '📅 Open since').value, '1998 (BBB)');
  assert.equal(card.fields.find((f) => f.name === '📋 Also listed on').value, '[Yelp](https://www.yelp.com/biz/snowflake-donuts-houston) · [BBB](https://www.bbb.org/x)');
  assert.match(card.fields.find((f) => f.name === 'Social media').value, /📸 \[Instagram @snowflakedonuts\]\(https:\/\/www\.instagram\.com\/snowflakedonuts\/\) — 12\.4K followers · 830 posts/);
  assert.equal(card.fields.find((f) => f.name === 'Category').value, 'Bakery / sweets (Donut shop)');
  // A Google search for them by name and town, for checking by hand
  assert.match(card.description, /\n🔎 \*\*\[Search them on Google\]\(https:\/\/www\.google\.com\/search\?q=Snowflake%20%28Donuts%29%20%26%20Co%20Houston%20TX\)\*\*$/);
  assert.equal(googleSearchUrl({ name: 'Cobb Plumbing Co', city: 'Memphis' }), 'https://www.google.com/search?q=Cobb%20Plumbing%20Co%20Memphis');
  assert.equal(googleSearchUrl({ name: 'Dabbles Hair Company', address: '19 N Cooper St, Memphis, TN 38104, United States', city: 'Memphis' }),
    'https://www.google.com/search?q=Dabbles%20Hair%20Company%20Memphis%20TN');
  // The share link is at the top of the card, where it has room for every detail.
  assert.ok(card.description.length <= 4096, `${card.description.length} characters`);
  const url = card.description.match(/^📲 \*\*\[Send this lead to WhatsApp\]\((https:\/\/wa\.me\/\?text=[^)\s]+)\)\*\*\n/)[1]; // brackets in the name don't break it
  const text = decodeURIComponent(new URL(url).searchParams.get('text'));
  assert.equal(text, [
    '🔥 *Snowflake (Donuts) & Co* (Bakery / sweets)',
    '⭐ 4.8 (358 reviews)',
    '📞 (713) 827-2808',
    '💬 https://wa.me/17138272808',
    '🏠 1234 Westheimer Rd, Houston, TX 77006',
    '📍 https://maps.google.com/?cid=1841144998116252209',
    '✉️ hello@snowflake.example',
    '🏷️ Donut shop',
    '🕒 Mon 6 AM–2 PM, Tue 6 AM–2 PM, Sun Closed',
    '📅 Open since 1998 (BBB)',
    '🔗 Facebook snowflakedonuts (3.1K likes): https://www.facebook.com/snowflakedonuts',
    '📸 Instagram @snowflakedonuts (12.4K followers · 830 posts): https://www.instagram.com/snowflakedonuts/',
    '📋 Also listed on: Yelp https://www.yelp.com/biz/snowflake-donuts-houston · BBB https://www.bbb.org/x',
    '📝 Their Google Maps "website" is just a Facebook page',
    '📝 Their Google listing is unclaimed',
  ].join('\n'));

  // Too much for one link: notes go first, then extra social pages; the essentials always stay.
  const huge = { ...lead, notes: Array(8).fill('n'.repeat(300)), socials: Array(4).fill(`https://www.facebook.com/${'p'.repeat(300)}`) };
  const hugeText = decodeURIComponent(new URL(leadShareLink(huge)).searchParams.get('text'));
  assert.ok(leadShareLink(huge).length <= MAX_LINK);
  for (const must of ['*Snowflake', '(713) 827-2808', 'Westheimer', 'maps.google.com/?cid=']) assert.ok(hugeText.includes(must), must);
  assert.ok(!hugeText.includes('📝'));
  assert.ok(leadShareLink({ name: 'x'.repeat(3000), phone: '1' }).length <= MAX_LINK);

  // run-leads.txt: every lead, numbered, every detail.
  const all = leadsText([lead, { name: 'B', phone: '1' }], 'Houston, United States');
  assert.ok(all.startsWith('🎯 2 website leads · Houston, United States\n\n1. 🔥 *Snowflake (Donuts) & Co*'));
  assert.ok(all.includes('📝 Their Google listing is unclaimed') && all.includes('2. *B*\n📞 1'));
  assert.equal(leadText({ name: 'C' }), '*C*');
});

test('Google Maps search phrases: every category has one; place IDs read from listing links', () => {
  assert.deepEqual(Object.keys(MAPS_SEARCH).sort(), Object.keys(CATEGORIES).sort());
  const { defs } = resolveCategories(['plumber', 'shop=bicycle']);
  assert.equal(defs[0].search, 'plumbers');
  assert.equal(defs[1].search, 'bicycle');
  assert.equal(placeIdOf('https://www.google.com/maps/place/X/data=!4m7!3m6!1s0x4870bc5f0d3bb1c3:0x8a5e3f44a2b1c0d9!8m2'), BigInt('0x8a5e3f44a2b1c0d9').toString());
  assert.equal(placeIdOf('https://www.google.com/maps/place/X'), null);
});

test('socialProfile: reads the account (ID) from social links', () => {
  const id = (url, title) => socialProfile(url, title)?.display ?? null;
  assert.equal(id('https://www.instagram.com/roysplumbing/'), '@roysplumbing');
  assert.equal(id('https://instagram.com/roys.plumbing?igsh=abc'), '@roys.plumbing');
  assert.equal(id('https://www.instagram.com/p/C9xYz/', "Roy's Plumbing (@roysplumbing) • Instagram photos and videos"), '@roysplumbing');
  assert.equal(id('https://www.instagram.com/p/C9xYz/', 'A post'), null);
  assert.equal(id('https://www.instagram.com/explore/tags/plumbing/'), null);
  assert.equal(id('https://www.facebook.com/NorthMsPlumbing/'), 'NorthMsPlumbing');
  assert.equal(id('https://m.facebook.com/McAlpins-Plumbing-Gas-Inc-1707962926088209/about'), 'McAlpins-Plumbing-Gas-Inc-1707962926088209');
  assert.equal(id('https://www.facebook.com/profile.php?id=100089'), '100089');
  assert.equal(id('https://www.facebook.com/groups/123/'), null);
  assert.equal(id('https://www.tiktok.com/@roys.plumbing'), '@roys.plumbing');
  assert.equal(id('https://www.youtube.com/watch?v=EKm6TBB58iA'), null);
  assert.equal(id('https://www.linkedin.com/company/roys-plumbing/'), 'roys-plumbing');
  assert.equal(socialLabel('https://www.instagram.com/roysplumbing/'), 'Instagram @roysplumbing');
});

test('findSocials: keeps only the business own accounts, Instagram first', () => {
  const roy = biz("Roy's Plumbing, Heating & Cooling");
  const found = findSocials([
    { url: 'https://www.instagram.com/roysplumbingms/', title: 'Instagram' }, // handle is their name
    { url: 'https://www.instagram.com/royalflush/', title: 'Royal Flush Plumbing (@royalflush)' },
    { url: 'https://www.facebook.com/116228315383391/', title: 'Joe Plumbing | Facebook' }, // a number says nothing
  ], roy);
  assert.deepEqual(found.map((p) => p.display), ['@roysplumbingms']);
  // One shared word in the title isn't enough; videos aren't accounts (from a real San Antonio run)
  const myers = biz('Myers Repair Services');
  assert.deepEqual(findSocials([{ url: 'https://www.linkedin.com/company/myers-industries', title: 'Myers Industries | LinkedIn' }], myers), []);
  assert.deepEqual(orderSocials(['https://www.youtube.com/watch?v=Wptv2iDdTZM', 'https://www.facebook.com/myersrepair/']),
    ['https://www.facebook.com/myersrepair/']);
  // A handle that's only the city + trade is someone else's (from a real San Antonio run)
  const dueSouth = { name: 'San Antonio Due South Plumbing', names: ['San Antonio Due South Plumbing'], city: 'San Antonio',
    profile: businessProfile(['San Antonio Due South Plumbing'], 'San Antonio') };
  assert.deepEqual(findSocials([
    { url: 'https://www.instagram.com/sanantonioplumbing/', title: 'San Antonio Plumbing (@sanantonioplumbing)' },
    { url: 'https://www.facebook.com/SanAntonioPlumbing/', title: 'San Antonio Plumbing | Facebook' },
  ], dueSouth), []);
  assert.deepEqual(findSocials([{ url: 'https://www.instagram.com/duesouthplumbing/', title: 'Instagram' }], dueSouth)
    .map((p) => p.display), ['@duesouthplumbing']);
  assert.deepEqual(orderSocials([
    'https://www.facebook.com/roys/', 'https://www.instagram.com/roysplumbing', 'https://instagram.com/RoysPlumbing/',
  ]), ['https://www.instagram.com/roysplumbing/', 'https://www.facebook.com/roys/']);
});

test('Phone check: finds the number however a site writes it, and only on real websites', async () => {
  const p = phonePattern('+19016858842');
  for (const text of ['Call (901) 685-8842', '901.685.8842', '<a href="tel:+19016858842">', '+1 901 685 8842']) assert.ok(p.test(text), text);
  assert.equal(p.test('901-685-8843'), false);
  assert.equal(p.test('9016858842123'), false);
  assert.equal(phonePattern('12345'), null);
  assert.ok(phonePattern('0321 1234567').test('0321-1234567'));

  assert.deepEqual(siteOrigins([
    { url: 'https://www.yelp.com/biz/x' }, { url: 'https://www.facebook.com/x' },
    { url: 'https://cpimemphis.com/services/drains' }, { url: 'https://cpimemphis.com/about' }, { url: 'https://other.example/' },
  ]), ['https://cpimemphis.com', 'https://other.example']);

  const pages = { 'https://cpimemphis.com/': '<p>Culpepper Plumbing</p>', 'https://cpimemphis.com/contact': '<p>(901) 685-8842</p>' };
  const fetchFn = async (url) => pages[url] ?? null;
  assert.equal(await confirmByPhone(['https://jackson.com', 'https://cpimemphis.com'], '(901) 685-8842', fetchFn), 'https://cpimemphis.com');
  assert.equal(await confirmByPhone(['https://cpimemphis.com'], '(901) 555-0000', fetchFn), null);
});

test('Lead details: hours, other listings, year started, social activity', () => {
  assert.equal(hoursText({ status: 'Closed', days: [['Thursday', '9 AM–7 PM']] }), "Thursday 9 AM–7 PM (only today's shown)");
  assert.equal(hoursText({ status: null, days: [], text: 'Mo-Sa 09:00-19:00' }), 'Mo-Sa 09:00-19:00');
  assert.equal(hoursText(null), null);

  const cobb = { name: 'Cobb Plumbing Co', names: ['Cobb Plumbing Co'], city: 'Memphis' };
  const results = [
    { url: 'https://www.bbb.org/us/tn/memphis/profile/x', title: 'Cobb Plumbing Company Inc | BBB', snippet: 'BBB Accredited since 1996. Business Started: 1/1/1990' },
    { url: 'https://www.yelp.com/biz/cobb-plumbing-memphis', title: 'Cobb Plumbing Co - Memphis - Yelp', snippet: 'Yelping since 2009' },
    { url: 'https://www.yelp.com/biz/someone-else', title: 'Other Plumber - Memphis - Yelp' },
    { url: 'https://www.facebook.com/CobbPlumbing/', title: 'Cobb Plumbing Co | Memphis', snippet: 'Cobb Plumbing Co, Memphis. 1.2K likes · 12 talking about this · 30 were here.' },
    { url: 'https://www.instagram.com/cobbplumbing/', title: 'Cobb Plumbing (@cobbplumbing)', snippet: '2,345 Followers, 50 Following, 120 Posts - See Instagram photos' },
  ];
  assert.deepEqual(listingsFrom(results, cobb).map((l) => l.name), ['BBB', 'Yelp']);
  assert.deepEqual(sinceFrom(results, cobb), { year: 1990, source: 'BBB' });
  assert.equal(sinceFrom([{ url: 'https://www.yelp.com/biz/x', title: 'Cobb Plumbing Co', snippet: 'Yelping since 2009' }], cobb), null);
  const activity = socialActivityFrom(results);
  assert.equal(activityFor('https://www.facebook.com/cobbplumbing/', activity), '1.2K likes · 12 talking about this · 30 check-ins');
  assert.equal(activityFor('https://www.instagram.com/cobbplumbing/', activity), '2,345 followers · 120 posts');
});
