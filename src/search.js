// Layer 3 — web search for "<business name> <city>" to catch websites that Google Maps doesn't link.
// Google blocks bots often, so Brave, Startpage, Bing and DuckDuckGo are automatic fallbacks.
// Brave uses its official Search API when a BRAVE_API_KEY is set (never blocked), otherwise its website.

import { gotoPage, isBlocked } from './browser.js';
import { hostOf, unwrapRedirect } from './matching.js';
import { sleep } from './util.js';

// A search that must return the official site. If it doesn't, that engine is blocked or broken this run.
export const SEARCH_CANARY = { query: 'Eiffel Tower official website', expectHost: 'toureiffel.paris' };

const ENGINES = {
  google: {
    label: 'Google',
    url: (ep, q) => `${ep.google}/search?q=${encodeURIComponent(q)}&hl=en`,
    ready: '#search, #rso, #botstuff, #topstuff',
    extract: () => Array.from(document.querySelectorAll('#search a, #rso a'))
      .filter((a) => a.querySelector('h3'))
      .map((a) => ({ url: a.href, title: a.querySelector('h3').textContent.trim() })),
  },
  brave: {
    label: 'Brave',
    url: (ep, q) => `${ep.brave}/search?q=${encodeURIComponent(q)}&source=web`,
    ready: '#results, main',
    // Brave renames its CSS classes often, so take every outside link in the results area.
    extract: () => {
      const root = document.querySelector('#results') || document.querySelector('main') || document.body;
      return Array.from(root.querySelectorAll('a[href^="http"]'))
        .filter((a) => !/(^|\.)brave\.com$/i.test(a.hostname) && !a.closest('[data-type="ad"], .ad, [class*="sponsored"]'))
        .map((a) => ({ url: a.href, title: ((a.querySelector('.title, [class*="title"]') || a).textContent || '').trim() }))
        .filter((r) => r.title);
    },
  },
  startpage: {
    label: 'Startpage',
    url: (ep, q) => `${ep.startpage}/sp/search?query=${encodeURIComponent(q)}&cat=web&language=english`,
    ready: '.w-gl, .result, #main',
    extract: () => {
      const root = document.querySelector('.w-gl') || document.querySelector('#main') || document.body;
      return Array.from(root.querySelectorAll('a[href^="http"]'))
        .filter((a) => !/(^|\.)startpage\.com$/i.test(a.hostname) && !a.closest('[class*="ad-"], [class*="sponsored"]'))
        .map((a) => ({ url: a.href, title: ((a.querySelector('h2, h3, .wgl-title, [class*="title"]') || a).textContent || '').trim() }))
        .filter((r) => r.title);
    },
  },
  bing: {
    label: 'Bing',
    url: (ep, q) => `${ep.bing}/search?q=${encodeURIComponent(q)}&setlang=en`,
    ready: '#b_results, #b_content',
    extract: () => Array.from(document.querySelectorAll('#b_results li.b_algo h2 a'))
      .map((a) => ({ url: a.href, title: a.textContent.trim() })),
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (ep, q) => `${ep.duckduckgo}/html/?q=${encodeURIComponent(q)}`,
    ready: '.results, .result, .no-results, #links',
    extract: () => Array.from(document.querySelectorAll('.result:not(.result--ad) a.result__a'))
      .map((a) => ({ url: a.href, title: a.textContent.trim() })),
  },
};

export const ENGINE_NAMES = Object.keys(ENGINES);

export const engineLabel = (name) => (name === 'brave' && process.env.BRAVE_API_KEY ? 'Brave (API)' : ENGINES[name]?.label || name);

/** Brave Search API: JSON over HTTPS, no browser, made for bots. */
async function runBraveApi(query, ep, key) {
  try {
    const params = new URLSearchParams({ q: query, count: '10' });
    const res = await fetch(`${ep.braveApi}/res/v1/web/search?${params}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) return { blocked: true }; // over the plan's limit
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      return { error: `the BRAVE_API_KEY was refused (HTTP ${res.status})`, fatal: true };
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    const results = (json.web?.results || [])
      .filter((r) => /^https?:\/\//i.test(r.url || ''))
      .map((r) => ({ url: r.url, title: String(r.title || '').replace(/<[^>]+>/g, '').trim() }));
    return { results };
  } catch (err) {
    return { error: String(err.message || err).split('\n')[0] };
  }
}

async function runEngine(page, name, query, ep) {
  if (name === 'brave' && process.env.BRAVE_API_KEY) return runBraveApi(query, ep, process.env.BRAVE_API_KEY);
  const engine = ENGINES[name];
  try {
    const response = await gotoPage(page, engine.url(ep, query));
    if (response?.status() === 429 || (await isBlocked(page))) return { blocked: true };
    await page.waitForSelector(engine.ready, { state: 'attached', timeout: 15000 }).catch(() => {});
    if (await isBlocked(page)) return { blocked: true };
    const raw = await page.evaluate(engine.extract);
    const seen = new Set();
    const results = [];
    for (const r of raw) {
      const url = unwrapRedirect(r.url);
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({ url, title: r.title });
    }
    return { results };
  } catch (err) {
    return { error: String(err.message || err).split('\n')[0] };
  }
}

/**
 * Returns { search(biz), state }.
 * search → { status: 'ok', engine, results } | { status: 'unavailable', allDead }
 * Each engine is self-tested the first time it's needed; blocked/broken engines are skipped for the rest of the run.
 */
export function createSearcher({ page, order, ep, delay = () => 0, log = () => {} }) {
  const state = {};
  for (const name of order) if (ENGINES[name]) state[name] = { status: 'untested', errors: 0 };

  async function selfTest(name) {
    const r = await runEngine(page, name, SEARCH_CANARY.query, ep);
    if (r.blocked) return 'blocked';
    if (r.error || !r.results.some((x) => hostOf(x.url).endsWith(SEARCH_CANARY.expectHost))) return 'broken';
    return 'ok';
  }

  async function search(biz) {
    const query = [biz.searchName, biz.city].filter(Boolean).join(' ');
    let emptyFrom = null;
    for (const name of Object.keys(state)) {
      const st = state[name];
      if (st.status === 'blocked' || st.status === 'broken') continue;
      if (st.status === 'untested') {
        st.status = await selfTest(name);
        log(`   🔧 ${engineLabel(name)} self-test: ${st.status}`);
        if (st.status !== 'ok') continue;
        await sleep(delay());
      }
      const r = await runEngine(page, name, query, ep);
      if (r.blocked) {
        st.status = 'blocked';
        log(`   ⛔ ${engineLabel(name)} blocked the bot — switching engine`);
        continue;
      }
      if (r.error) {
        st.errors += 1;
        if (st.errors >= 3 || r.fatal) st.status = 'broken';
        log(`   ${engineLabel(name)} error: ${r.error}`);
        continue;
      }
      st.errors = 0; // only errors in a row mean the engine is broken
      // Zero results is rare for a real business, so double-check with the next engine.
      if (!r.results.length && !emptyFrom) {
        emptyFrom = name;
        continue;
      }
      return { status: 'ok', engine: name, results: r.results };
    }
    if (emptyFrom) return { status: 'ok', engine: emptyFrom, results: [] };
    const allDead = Object.values(state).every((s) => s.status === 'blocked' || s.status === 'broken');
    return { status: 'unavailable', allDead };
  }

  return { search, state };
}
