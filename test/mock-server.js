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

const PLACES = {
  'eiffel-tower': { query: 'Eiffel Tower', title: 'Eiffel Tower', website: 'https://www.toureiffel.paris/', address: 'Av. Gustave Eiffel, 75007 Paris, France', rating: '4.7', reviews: '400,123' },
  'ali-bakers': { query: 'Ali Bakers', title: 'Ali Bakers', website: 'http://www.alibakers.pk/', phone: '+924235761234', phoneLabel: '042 35761234', address: '12 Main Blvd, Gulberg, Lahore' },
  'butt-karahi': { query: 'Butt Karahi House', title: 'Butt Karahi House', phone: '+923001112222', phoneLabel: '0300 1112222', address: 'Lakshmi Chowk, Lahore', rating: '4.4', reviews: '320', claimable: true, tempClosed: true, review: 'I thought it was permanently closed, but it is open and great!' },
  'haveli-restaurant': { title: 'Haveli Restaurant', address: 'Fort Road Food Street, Lahore', rating: '4.2', reviews: '1,024' },
  'haveli-sweets': { title: 'Haveli Sweets', website: 'https://havelisweets.pk/', address: 'Mall Road, Lahore' },
  zamzam: { query: 'Zam Zam Tailors', title: 'Zam Zam Tailors', closed: true, address: 'Anarkali, Lahore' },
  rehman: { query: 'Rehman Dental Clinic', title: 'Rehman Dental Clinic', website: 'https://www.facebook.com/rehmandental', phone: '+923214445555', phoneLabel: '0321 4445555', address: 'Model Town, Lahore', rating: '4.9', reviews: '41' },
};

const RESULTS = [
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
const resultsFor = (q) => (RESULTS.find((r) => q.includes(r.match)) || { results: [] }).results;

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
  if (q.startsWith('Eiffel Tower') && scenario.mapsCanaryBroken) return renderLater(placeHtml({ title: 'Eiffel Tower', address: 'Paris' }));
  if (q.includes('Empty List')) return listPage(q, []);
  if (q.includes('Haveli Restaurant')) return listPage(q, [['Haveli Sweets', 'haveli-sweets'], ['Haveli Restaurant', 'haveli-restaurant']]);
  const place = Object.values(PLACES).find((p) => p.query && q.includes(p.query));
  if (place) return renderLater(placeHtml(place));
  return renderLater(`<div role="main" aria-label="Google Maps"><div>Google Maps can't find <b>${esc(q)}</b></div></div>`);
}

const googleHtml = (results) => page(`<div id="search"><div id="rso">${results.map((r) =>
  `<div class="g"><div class="yuRUbf"><div><span><a href="${esc(r.url)}"><h3 class="LC20lb">${esc(r.title)}</h3><cite>${esc(r.url)}</cite></a></span></div></div><div class="VwiC3b">Snippet</div></div>`).join('')}</div></div>`);

const bingHtml = (results) => page(`<div id="b_content"><ol id="b_results">${results.map((r) =>
  `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from(r.url).toString('base64url')}&amp;ntb=1">${esc(r.title)}</a></h2></li>`).join('')}</ol></div>`);

function ddgHtml(results) {
  if (!results.length) return page('<div class="results"><div class="no-results">No results.</div></div>');
  const ad = '<div class="result results_links result--ad"><h2 class="result__title"><a class="result__a" href="https://ads.example.com/">Sponsored</a></h2></div>';
  return page(`<div class="results">${ad}${results.map((r) =>
    `<div class="result results_links results_links_deep web-result"><div class="links_main result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&amp;rut=abc">${esc(r.title)}</a></h2></div></div>`).join('')}</div>`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

/**
 * scenario: { googleBlockOn?: string, bingWorks?: boolean, mapsCanaryBroken?: boolean }
 */
export async function startMockServer(scenario = {}) {
  const requests = { overpass: [], maps: [], google: [], bing: [], ddg: [], discord: [] };
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
      return send(200, 'application/json', JSON.stringify({ elements: ELEMENTS }));
    }
    if (p.startsWith('/maps/search/')) {
      const q = decodeURIComponent(p.slice('/maps/search/'.length).split('/@')[0]);
      requests.maps.push(q);
      return html(mapsSearch(q, scenario));
    }
    if (p.startsWith('/maps/place/')) {
      const place = PLACES[p.slice('/maps/place/'.length)];
      return html(place ? renderLater(placeHtml(place)) : page('Not found'), place ? 200 : 404);
    }
    if (p === '/google/search') {
      const q = url.searchParams.get('q');
      requests.google.push(q);
      if (scenario.googleBlockOn && q.includes(scenario.googleBlockOn)) {
        return send(302, 'text/plain', '', { Location: '/google/sorry/index?continue=search' });
      }
      return html(googleHtml(resultsFor(q)));
    }
    if (p.startsWith('/google/sorry')) {
      return html(page('<p>Our systems have detected unusual traffic from your computer network.</p>'), 429);
    }
    if (p === '/bing/search') {
      const q = url.searchParams.get('q');
      requests.bing.push(q);
      return html(bingHtml(scenario.bingWorks ? resultsFor(q) : []));
    }
    if (p === '/ddg/html/') {
      const q = url.searchParams.get('q');
      requests.ddg.push(q);
      return html(ddgHtml(resultsFor(q)));
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
