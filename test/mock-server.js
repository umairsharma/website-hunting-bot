// A fake OpenStreetMap + Google Maps + Google/Bing/DuckDuckGo + Discord, so the whole bot can be tested offline.
// The HTML mimics the real pages' structure (the same attributes the bot reads).

import http from 'node:http';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const NOMINATIM = [{
  osm_type: 'relation', osm_id: 7431040, lat: '31.5656822', lon: '74.3141829',
  category: 'boundary', type: 'administrative', display_name: 'Lahore, Punjab, Pakistan',
}];

export const ELEMENTS = [
  { type: 'node', id: 1, lat: 31.52, lon: 74.35, tags: { name: 'Ali Bakers', shop: 'bakery', phone: '042 35761234', 'addr:street': 'Main Blvd', 'addr:city': 'Lahore' } },
  { type: 'node', id: 2, lat: 31.58, lon: 74.31, tags: { name: 'Butt Karahi House', amenity: 'restaurant', 'contact:phone': '+92 300 1112222', opening_hours: 'Mo-Su 12:00-02:00' } },
  { type: 'way', id: 3, center: { lat: 31.59, lon: 74.31 }, nodes: [1, 2, 3], tags: { name: 'Haveli Restaurant', amenity: 'restaurant' } },
  { type: 'node', id: 4, lat: 31.57, lon: 74.31, tags: { name: 'Zam Zam Tailors', shop: 'tailor' } },
  { type: 'node', id: 5, lat: 31.48, lon: 74.32, tags: { name: 'Rehman Dental Clinic', amenity: 'dentist', 'contact:facebook': 'rehmandental' } },
  { type: 'node', id: 6, lat: 31.5, lon: 74.3, tags: { name: 'Gone Store', shop: 'clothes' } },
  { type: 'node', id: 7, lat: 31.51, lon: 74.33, tags: { name: 'KFC', amenity: 'restaurant', brand: 'KFC', 'brand:wikidata': 'Q524757' } },
  { type: 'node', id: 8, lat: 31.51, lon: 74.34, tags: { name: 'Has Website Cafe', amenity: 'cafe', website: 'https://hwc.pk' } },
  { type: 'node', id: 9, lat: 31.51, lon: 74.35, tags: { shop: 'bakery' } },
  { type: 'way', id: 10, center: { lat: 31.52001, lon: 74.35001 }, tags: { name: 'Ali Bakers', shop: 'bakery' } },
];

const PLACES_EXTRA = {};
const PLACES = {
  'eiffel-tower': { query: 'Eiffel Tower', title: 'Eiffel Tower', website: 'https://www.toureiffel.paris/', address: 'Av. Gustave Eiffel, 75007 Paris, France', rating: '4.7', reviews: '400,123' },
  'ali-bakers': { query: 'Ali Bakers', title: 'Ali Bakers', website: 'http://www.alibakers.pk/', phone: '+924235761234', phoneLabel: '042 35761234', address: '12 Main Blvd, Gulberg, Lahore' },
  'butt-karahi': { query: 'Butt Karahi House', title: 'Butt Karahi House', phone: '+923001112222', phoneLabel: '0300 1112222', address: 'Lakshmi Chowk, Lahore', rating: '4.4', reviews: '320', claimable: true, tempClosed: true, review: 'I thought it was permanently closed, but it is open and great!' },
  'haveli-restaurant': { title: 'Haveli Restaurant', address: 'Fort Road Food Street, Lahore', rating: '4.2', reviews: '1,024' },
  'haveli-sweets': { title: 'Haveli Sweets', website: 'https://havelisweets.pk/', address: 'Mall Road, Lahore' },
  zamzam: { query: 'Zam Zam Tailors', title: 'Zam Zam Tailors', closed: true, address: 'Anarkali, Lahore' },
  rehman: { query: 'Rehman Dental Clinic', title: 'Rehman Dental Clinic', website: 'https://www.facebook.com/rehmandental', phone: '+923214445555', phoneLabel: '0321 4445555', address: 'Model Town, Lahore', rating: '4.9', reviews: '41' },
};

// Plumbers found only by searching Google Maps (OpenStreetMap has none). The results list shows two
// places, then two more after scrolling, like the real site. Their links carry place IDs and positions.
const placeLink = (slug, id) => `/maps/place/${slug}/data=!4m7!3m6!1s0x39190000:0x${id}!8m2!3d31.5${id}!4d74.3${id}`;
const MAPS_PLUMBERS = [
  { slug: 'pipe-masters', title: 'Pipe Masters', id: 'a1', cardWebsite: 'https://pipemasters.example/' },
  { slug: 'ace-drain-co', title: 'Ace Drain Co', id: 'a2' },
  { slug: 'mike-pipe-fix', title: 'Mike Pipe Fix', id: 'a3' },
  { slug: 'delta-rooter', title: 'Delta Rooter', id: 'a4' },
];
Object.assign(PLACES_EXTRA, {
  'pipe-masters': { title: 'Pipe Masters', website: 'https://pipemasters.example/', address: '1 Canal Rd, Lahore' },
  'ace-drain-co': { title: 'Ace Drain Co', website: 'https://acedrainco.example/', phone: '+923001234500', phoneLabel: '0300 1234500', address: '2 Mall Rd, Lahore', rating: '4.6', reviews: '88' },
  'mike-pipe-fix': { title: 'Mike Pipe Fix', phone: '+923211234567', phoneLabel: '0321 1234567', address: '3 Ferozepur Rd, Lahore', rating: '4.8', reviews: '64',
    category: 'Plumber', hours: [['Sunday', 'Closed'], ['Monday', '9 AM–6 PM Hours might differ'], ['Tuesday', '9 AM–6 PM']] },
  'delta-rooter': { title: 'Delta Rooter', phone: '+924235550000', phoneLabel: '042 35550000', address: '4 Jail Rd, Lahore' },
});

function discoveryPage(q) {
  const card = (p) => `<div class="Nv2PK"><a class="hfpxzc" aria-label="${esc(p.title)}" href="${placeLink(p.slug, p.id)}"></a>`
    + `<div class="qBF1Pd">${esc(p.title)}</div>${p.cardWebsite ? `<a class="lcr4fd" data-value="Website" href="${esc(p.cardWebsite)}">Website</a>` : ''}`
    + '<a href="https://www.google.com/maps/dir//x">Directions</a></div>';
  const first = MAPS_PLUMBERS.slice(0, 2).map(card).join('');
  const more = MAPS_PLUMBERS.slice(2).map(card).join('');
  const feed = `<div role="feed" aria-label="Results for ${esc(q)}" style="height:300px;overflow:auto"><div style="height:1200px">${first}</div></div>`;
  return page(
    `<div role="main" aria-label="Results for ${esc(q)}"><h1>Results</h1><div id="slot"></div></div>`,
    `setTimeout(() => {
      document.getElementById('slot').outerHTML = ${JSON.stringify(feed)};
      const f = document.querySelector('div[role="feed"]');
      let loaded = false;
      f.addEventListener('scroll', () => {
        if (loaded) return;
        loaded = true;
        setTimeout(() => f.insertAdjacentHTML('beforeend', ${JSON.stringify(more)} + "<p>You've reached the end of the list.</p>"), 300);
      });
    }, 400);`,
  );
}

const RESULTS = [
  // Social media searches (more specific, so listed before the plain names)
  { match: 'Mike Pipe Fix Lahore instagram', results: [
    { url: 'https://www.instagram.com/p/C9xYz/', title: 'Mike Pipe Fix (@mikepipefix) • Instagram photos and videos',
      snippet: '1,234 Followers, 10 Following, 56 Posts - See Instagram photos and videos from Mike Pipe Fix' },
    { url: 'https://www.instagram.com/pipefixers_uk/', title: 'Pipe Fixers UK (@pipefixers_uk) • Instagram' },
    { url: 'https://www.facebook.com/MikePipeFixLahore/', title: 'Mike Pipe Fix - Lahore | Facebook',
      snippet: 'Mike Pipe Fix, Lahore. 890 likes · 4 talking about this · 12 were here.' },
  ] },

  { match: 'Mike Pipe Fix Lahore', results: [
    { url: 'https://www.yellowpages.com.pk/mike-pipe-fix', title: 'Mike Pipe Fix - Plumbers in Lahore', snippet: 'Mike Pipe Fix, established in 2008, offers plumbing repairs. Email: MikePipeFix@gmail.com' },
  ] },
  { match: 'Delta Rooter Lahore instagram', results: [
    { url: 'https://www.instagram.com/deltafaucet/', title: 'Delta Faucet (@deltafaucet) • Instagram' },
  ] },
  { match: 'Eiffel Tower', results: [
    { url: 'https://www.toureiffel.paris/en', title: 'Official website Eiffel Tower' },
    { url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', title: 'Eiffel Tower - Wikipedia' },
  ] },
  { match: 'Ali Bakers', results: [{ url: 'https://www.alibakers.pk/', title: 'Ali Bakers | Lahore' }] },
  { match: 'Butt Karahi House', results: [
    { url: 'https://www.facebook.com/buttkarahihouse/', title: 'Butt Karahi House - Home | Facebook' },
    { url: 'https://www.foodpanda.pk/restaurant/abcd/butt-karahi-house', title: 'Butt Karahi House delivery | foodpanda' },
    { url: 'https://restaurantguru.com/Butt-Karahi-House-Lahore', title: 'Butt Karahi House, Lahore - Menu and reviews' },
    { url: 'https://www.dawn.com/news/123456/lahores-best-karahi', title: "Lahore's best karahi spots" },
  ] },
  { match: 'Haveli Restaurant', results: [
    { url: 'https://havelirestaurant.pk/', title: 'Haveli Restaurant | Fort Road Food Street' },
    { url: 'https://www.tripadvisor.com/Restaurant_Review-Haveli', title: 'Haveli Restaurant, Lahore - Tripadvisor' },
  ] },
  { match: 'Rehman Dental Clinic', results: [
    { url: 'https://www.marham.pk/doctors/lahore/dentist/dr-rehman', title: 'Dr. Rehman - Dentist in Lahore | Marham' },
    { url: 'https://www.facebook.com/rehmandental', title: 'Rehman Dental Clinic | Facebook' },
    { url: 'https://smilecare-lahore.com/', title: 'Rehman Dental Clinic - Smile Care Lahore' },
  ] },
];
// Sites whose domain doesn't match the business's name; only their phone number shows they're theirs.
const PHONE_RESULTS = [
  { match: 'Delta Rooter Lahore', results: [{ url: 'https://drainheroes-lhr.example/services/rooter', title: 'Drain services | Lahore' }] },
  { match: '"0321 1234567"', results: [
    { url: 'https://www.olx.com.pk/item/plumber-1234', title: 'Plumber 0321 1234567 | OLX' },
    { url: 'https://pk-plumbing-hub.example/listing/42', title: 'Plumbers in Lahore' },
    { url: 'https://mpf-services.example/about', title: 'About us' },
  ] },
];
export const SITES = {
  'https://drainheroes-lhr.example/': '<h1>Drain Heroes</h1><p>Call us: 042-3555 0000</p>',
  'https://pk-plumbing-hub.example/': '<h1>Find a plumber</h1><p>Our hotline: 0300 0000000</p>',
  'https://mpf-services.example/': '<h1>MPF Services</h1><p>Plumbing and repairs</p>',
  'https://mpf-services.example/contact': '<p>WhatsApp <a href="tel:+923211234567">+92 321 1234567</a></p>',
};
// A site named nothing like the business, found by its street address, with the address and name on it.
const ADDRESS_RESULTS = [
  { match: '"3 Ferozepur Rd"', results: [
    { url: 'https://www.zameen.com/Property/x', title: 'Shops on Ferozepur Road' },
    { url: 'https://lahorepipeworks.example/about', title: 'About us' },
  ] },
];
SITES['https://lahorepipeworks.example/'] = '<h1>Lahore Pipe Works</h1><p>Mike Pipe Fix &amp; sons, 3 Ferozepur Rd., Lahore</p>';
// A directory listing page that shows the business's email (and other businesses' and its own).
const LISTING_RESULTS = [
  { match: 'Delta Rooter Lahore', results: [{ url: 'https://www.yellowpages.com.pk/delta-rooter', title: 'Delta Rooter - Plumbers in Lahore' }] },
];
SITES['https://www.yellowpages.com.pk/delta-rooter'] = `<h1>Delta Rooter</h1><a class="email-business" href="mailto:DeltaRooter.Lhr@gmail.com?subject=Hi">Email Business</a>
  <p>Contact us: help@yellowpages.com.pk</p><div class="similar">Ace Drain: <a href="mailto:ace@acedrainco.example">email</a></div>`;
const resultsFor = (q, scenario = {}) => {
  const lists = [...(scenario.results || []), ...(scenario.phoneSites ? PHONE_RESULTS : []), ...(scenario.addressSites ? ADDRESS_RESULTS : []), ...(scenario.listingEmail ? LISTING_RESULTS : []), ...RESULTS];
  return (lists.find((r) => q.includes(r.match)) || { results: [] }).results;
};

const page = (body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>mock</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

// Real Google Maps draws its side panel with JavaScript after the page loads — mimic that.
const renderLater = (html, ms = 400) =>
  page('<div id="app"></div>', `setTimeout(() => { document.getElementById('app').innerHTML = ${JSON.stringify(html)}; }, ${ms});`);

function placeHtml(p) {
  const host = p.website ? new URL(p.website).hostname.replace(/^www\./, '') : '';
  return `<div role="main" aria-label="${esc(p.title)}">
    <h1 class="DUwDvf">${esc(p.title)}</h1>
    ${p.rating ? `<div class="F7nice"><span aria-hidden="true">${p.rating}</span><span role="img" aria-label="${p.rating} stars "></span><span role="img" aria-label="${p.reviews} reviews">(${p.reviews})</span></div>` : ''}
    ${p.closed ? '<div><span>Permanently closed</span></div>' : ''}
    ${p.tempClosed ? '<div><span>Temporarily closed</span></div>' : ''}
    ${p.address ? `<button data-item-id="address" aria-label="Address: ${esc(p.address)}"><div>${esc(p.address)}</div></button>` : ''}
    ${p.website ? `<a data-item-id="authority" href="${esc(p.website)}" aria-label="Website: ${esc(host)}"><div>${esc(host)}</div></a>` : ''}
    ${p.phone ? `<button data-item-id="phone:tel:${esc(p.phone)}" aria-label="Phone: ${esc(p.phoneLabel)}"><div>${esc(p.phoneLabel)}</div></button>` : ''}
    ${p.category ? `<button jsaction="pane.wfvdle1.category">${esc(p.category)}</button>` : ''}
    ${p.hours ? `<div jsaction="pane.openhours.wfvdle23.dropdown" onclick="document.getElementById('week').hidden=false"><span role="img" aria-label="Show open hours for the week"></span>Open · Closes 6 PM</div>
      <table id="week" hidden>${p.hours.map(([d, t]) => `<tr><td>${d}</td><td>${t.replace(' ', '\u202f')}</td></tr>`).join('')}</table>` : ''}
    ${p.bookingLink ? `<a data-item-id="action:3" data-tooltip="Open booking link" aria-label="${esc(new URL(p.bookingLink).hostname)}" href="${esc(p.bookingLink)}">${esc(new URL(p.bookingLink).hostname)}</a>` : ''}
    ${p.claimable ? '<a href="#claim">Claim this business</a>' : ''}
    ${p.review ? `<div class="jftiEf"><span class="wiI7pd">${esc(p.review)}</span></div>` : ''}
  </div>`;
}

function listPage(q, items) {
  const cards = items
    .map(([title, slug]) => `<div class="Nv2PK"><a class="hfpxzc" aria-label="${esc(title)}" href="/maps/place/${slug}?authuser=0"></a><div>${esc(title)}</div></div>`)
    .join('');
  const feed = `<div role="feed" aria-label="Results for ${esc(q)}">${cards}</div>`;
  // The "Results" header shows up before the list itself, like on the real site.
  return page(
    `<div role="main" aria-label="Results for ${esc(q)}"><h1>Results</h1><div id="slot"></div></div>`,
    `setTimeout(() => { document.getElementById('slot').outerHTML = ${JSON.stringify(feed)}; }, 600);`,
  );
}

function mapsSearch(q, scenario) {
  if (/^plumbers in /i.test(q)) {
    if (scenario.mapsSearchBlocked) return page('<p>Our systems have detected unusual traffic from your computer network.</p>');
    return discoveryPage(q);
  }
  if (q.startsWith('Eiffel Tower') && scenario.mapsCanaryBroken) return renderLater(placeHtml({ title: 'Eiffel Tower', address: 'Paris' }));
  if (q.includes('Empty List')) return listPage(q, []);
  if (q.includes('Haveli Restaurant')) return listPage(q, [['Haveli Sweets', 'haveli-sweets'], ['Haveli Restaurant', 'haveli-restaurant']]);
  const slug = Object.keys(PLACES).find((k) => PLACES[k].query && q.includes(PLACES[k].query));
  if (slug) {
    // Like real Maps: the listing opens, then the address bar switches to the listing's /place/ link.
    const id = (Object.keys(PLACES).indexOf(slug) + 10).toString(16);
    return page('<div id="app"></div>', `setTimeout(() => {
      document.getElementById('app').innerHTML = ${JSON.stringify(placeHtml(PLACES[slug]))};
    }, 400);
    setTimeout(() => history.replaceState(null, '', '/maps/place/${slug}/data=!4m6!3m5!1s0x48700000:0x${id}!8m2'), 2500);`);
  }
  return renderLater(`<div role="main" aria-label="Google Maps"><div>Google Maps can't find <b>${esc(q)}</b></div></div>`);
}

const googleHtml = (results) => page(`<div id="search"><div id="rso">${results.map((r) =>
  `<div class="g"><div class="yuRUbf"><div><span><a href="${esc(r.url)}"><h3 class="LC20lb">${esc(r.title)}</h3><cite>${esc(r.url)}</cite></a></span></div></div><div class="VwiC3b">${esc(r.snippet || 'Snippet')}</div></div>`).join('')}</div></div>`);

const bingHtml = (results) => page(`<div id="b_content"><ol id="b_results">${results.map((r) =>
  `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from(r.url).toString('base64url')}&amp;ntb=1">${esc(r.title)}</a></h2></li>`).join('')}</ol></div>`);

function ddgHtml(results) {
  if (!results.length) return page('<div class="results"><div class="no-results">No results.</div></div>');
  const ad = '<div class="result results_links result--ad"><h2 class="result__title"><a class="result__a" href="https://ads.example.com/">Sponsored</a></h2></div>';
  return page(`<div class="results">${ad}${results.map((r) =>
    `<div class="result results_links results_links_deep web-result"><div class="links_main result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&amp;rut=abc">${esc(r.title)}</a></h2></div></div>`).join('')}</div>`);
}

// Brave and Startpage: plausible markup with ads and the engine's own links mixed in, like the real pages.
const braveHtml = (results) => page(`<main><div id="results">${results.map((r) =>
  `<div class="snippet" data-type="web"><a href="${esc(r.url)}"><div class="title">${esc(r.title)}</div></a><a href="https://search.brave.com/goggles">More</a></div>`).join('')
}<div data-type="ad"><a href="https://ads.example.com/"><div class="title">Sponsored</div></a></div></div></main>`);

const startpageHtml = (results) => page(`<div id="main"><section class="w-gl">${results.map((r) =>
  `<div class="result"><a class="result-link" href="${esc(r.url)}"><h2 class="wgl-title">${esc(r.title)}</h2></a><a href="https://www.startpage.com/av/proxy?u=x">Anonymous View</a></div>`).join('')
}</section></div>`);

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

/**
 * scenario: { googleBlockOn?: string, bingWorks?: boolean, mapsCanaryBroken?: boolean, braveWebBlocked?: boolean,
 *   startpageBlocked?: boolean, searchDown?: boolean (every engine blocks), braveBlockFirst?: number (first N Brave requests get 429),
 *   bingEmptyFirst?: boolean (Bing's first page has no results), mapsSearchBlocked?: boolean }
 */
export async function startMockServer(scenario = {}) {
  const requests = { overpass: [], maps: [], google: [], brave: [], braveApi: [], startpage: [], bing: [], ddg: [], discord: [], sites: [], gemini: [] };
  let discordCalls = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    const send = (status, type, text, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(text);
    };
    const html = (text, status = 200) => send(status, 'text/html; charset=utf-8', text);
    const p = url.pathname;

    if (p === '/nominatim/search') return send(200, 'application/json', JSON.stringify(NOMINATIM));
    if (p === '/overpass/interpreter' && req.method === 'POST') {
      requests.overpass.push(new URLSearchParams(body).get('data'));
      if (scenario.overpassDown) return send(504, 'text/plain', 'Gateway Timeout');
      return send(200, 'application/json', JSON.stringify({ elements: [...ELEMENTS, ...(scenario.extraElements || [])] }));
    }
    if (p.startsWith('/maps/search/')) {
      const q = decodeURIComponent(p.slice('/maps/search/'.length).split('/@')[0]);
      requests.maps.push(q);
      const list = Object.entries(scenario.mapsLists || {}).find(([query]) => q.includes(query));
      return html(list ? listPage(q, list[1]) : mapsSearch(q, scenario));
    }
    if (p.startsWith('/maps/place/')) {
      const slug = p.slice('/maps/place/'.length).split('/')[0];
      let place = PLACES[slug] || PLACES_EXTRA[slug] || scenario.places?.[slug];
      // scenario.bookingLinks: { slug: url } — a "booking link" on the listing instead of a Website button
      if (place && scenario.bookingLinks?.[slug]) place = { ...place, bookingLink: scenario.bookingLinks[slug] };
      return html(place ? renderLater(placeHtml(place)) : page('Not found'), place ? 200 : 404);
    }
    if (p === '/google/search') {
      const q = url.searchParams.get('q');
      requests.google.push(q);
      if (scenario.searchDown || (scenario.googleBlockOn && q.includes(scenario.googleBlockOn))) {
        return send(302, 'text/plain', '', { Location: '/google/sorry/index?continue=search' });
      }
      return html(googleHtml(resultsFor(q, scenario)));
    }
    if (p.startsWith('/google/sorry')) {
      return html(page('<p>Our systems have detected unusual traffic from your computer network.</p>'), 429);
    }
    if (p === '/brave/search') {
      const q = url.searchParams.get('q');
      requests.brave.push(q);
      if (scenario.braveWebBlocked || scenario.searchDown || requests.brave.length <= (scenario.braveBlockFirst || 0)) {
        return html(page('<p>Too many requests</p>'), 429);
      }
      return html(braveHtml(resultsFor(q, scenario)));
    }
    if (p === '/brave-api/res/v1/web/search') {
      const q = url.searchParams.get('q');
      requests.braveApi.push({ q, key: req.headers['x-subscription-token'] });
      if (req.headers['x-subscription-token'] !== 'good-key') return send(401, 'application/json', '{"type":"ErrorResponse"}');
      const results = resultsFor(q, scenario).map((r) => ({ url: r.url, title: r.title.replace('Eiffel', '<strong>Eiffel</strong>') }));
      return send(200, 'application/json', JSON.stringify({ web: { results } }));
    }
    if (p === '/startpage/sp/search') {
      const q = url.searchParams.get('query');
      requests.startpage.push(q);
      if (scenario.startpageBlocked || scenario.searchDown) return send(302, 'text/plain', '', { Location: '/startpage/sp/captcha-block?x=1' });
      return html(startpageHtml(resultsFor(q, scenario)));
    }
    if (p.startsWith('/startpage/sp/captcha-block')) return html(page('<p>Please confirm you are not a robot.</p>'));
    if (p === '/bing/search') {
      const q = url.searchParams.get('q');
      requests.bing.push(q);
      if (scenario.searchDown) return html(page('<div id="b_captcha">Verify you are human</div>'));
      if (scenario.bingEmptyFirst && requests.bing.length === 1) return html(bingHtml([]));
      return html(bingHtml(scenario.bingWorks ? resultsFor(q, scenario) : []));
    }
    if (p === '/ddg/html/') {
      const q = url.searchParams.get('q');
      requests.ddg.push(q);
      if (scenario.searchDown) return html(page('<p>Unfortunately, bots use DuckDuckGo too.</p>'));
      return html(ddgHtml(resultsFor(q, scenario)));
    }
    if (p === '/site') {
      const target = url.searchParams.get('url');
      requests.sites.push(target);
      const site = scenario.sites?.[target] ?? SITES[target];
      return site ? html(page(site)) : send(404, 'text/plain', 'not found');
    }
    // Gemini: scenario.gemini is a list of { match: [words the question contains], reply: {…} }; the first
    // that fits answers. scenario.geminiStatus: { status, text } answers every question with an error.
    const ai = p.match(/^\/gemini\/v1beta\/models\/([^/:]+):generateContent$/);
    if (ai && req.method === 'POST') {
      const json = JSON.parse(body);
      const prompt = json.contents[0].parts.map((x) => x.text).join('');
      const search = Boolean(json.tools?.some((t) => t.google_search));
      requests.gemini.push({ model: ai[1], prompt, search, key: req.headers['x-goog-api-key'] });
      if (scenario.geminiStatus) return send(scenario.geminiStatus.status, 'application/json', scenario.geminiStatus.text || '{}');
      const rule = (scenario.gemini || []).find((r) => r.match.every((w) => prompt.includes(w)));
      const reply = rule ? rule.reply : search
        ? { hasWebsite: false, url: null, confidence: 'high', reason: 'nothing of theirs on Google' }
        : { match: null, belongs: false, confidence: 'low', reason: 'not sure' };
      const text = `Here you go:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``;
      return send(200, 'application/json', JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    if (p === '/discord/webhook' && req.method === 'POST') {
      discordCalls += 1;
      if (discordCalls === 1) return send(429, 'application/json', JSON.stringify({ retry_after: 0.05 }));
      requests.discord.push(JSON.parse(body));
      return send(200, 'application/json', '{}');
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
