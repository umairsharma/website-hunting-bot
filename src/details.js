// Extra details for a lead card, read from the search results the bot already has: where else the
// business is listed, how long it's been around, and how active its social pages are.

import { businessProfile, classifyUrl, compact, prettySite } from './matching.js';
import { socialProfile } from './socials.js';

// Names for the directories people know, so the card says "Yelp", not "yelp.com".
const DIRECTORY_NAMES = {
  yelp: 'Yelp', bbb: 'BBB', yellowpages: 'Yellow Pages', nextdoor: 'Nextdoor', angi: 'Angi', angieslist: 'Angi',
  thumbtack: 'Thumbtack', homeadvisor: 'HomeAdvisor', houzz: 'Houzz', porch: 'Porch', buildzoom: 'BuildZoom',
  tripadvisor: 'Tripadvisor', foursquare: 'Foursquare', mapquest: 'MapQuest', manta: 'Manta', chamberofcommerce: 'Chamber of Commerce',
  superpages: 'Superpages', birdeye: 'Birdeye', groupon: 'Groupon', booksy: 'Booksy', vagaro: 'Vagaro', fresha: 'Fresha',
  styleseat: 'StyleSeat', schedulicity: 'Schedulicity', opentable: 'OpenTable', doordash: 'DoorDash', ubereats: 'Uber Eats',
  grubhub: 'Grubhub', foodpanda: 'foodpanda', checkatrade: 'Checkatrade', yell: 'Yell', zocdoc: 'Zocdoc', healthgrades: 'Healthgrades',
};

const label = (host) => {
  const brand = host.replace(/^(www|m)\./, '').split('.')[0];
  return DIRECTORY_NAMES[brand] || prettySite(host);
};

/**
 * The search result is about this business: its full name is in the title or the text under it, or all
 * of its distinctive words when there are several. One word isn't enough ("Torres" is also a town).
 */
function aboutBusiness(r, profile) {
  const text = compact(`${r.title || ''} ${r.snippet || ''}`);
  if (profile.keys.some((k) => k.length >= 6 && text.includes(k))) return true;
  return profile.tokenSets.some((tokens) => tokens.length > 1 && tokens.every((x) => text.includes(x)));
}

// A directory's search or category page lists many businesses, not this one.
const isListPage = (url) => /[?&](find_desc|q|query|search|keyword)=|\/(search|s|find|category|categories)(\/|\?|$)/i.test(url);

/** Directories, booking and delivery sites that list this business: [{ name: 'Yelp', url }], at most 6. */
export function listingsFrom(results, biz) {
  const profile = biz.profile || businessProfile(biz.names || [biz.name], biz.city);
  const out = new Map();
  for (const r of results) {
    const site = classifyUrl(r.url);
    if (!site || !['directory', 'booking', 'delivery'].includes(site.kind)) continue;
    if (['bing', 'duckduckgo', 'yahoo', 'yandex', 'wikipedia', 'wikidata', 'reddit', 'quora'].some((b) => site.host.includes(b))) continue;
    if (isListPage(site.url) || !aboutBusiness(r, profile)) continue;
    const name = label(site.host);
    if (!out.has(name)) out.set(name, { name, url: site.url });
    if (out.size >= 6) break;
  }
  return [...out.values()];
}

/**
 * The year the business started, from what directories say about it: "Business Started: 6/1/1990" (BBB),
 * "Years in Business: 35", "since 1985", "established in 2004", "family owned since 1971".
 * Returns { year, source } (the earliest year found and the site that said it), or null.
 */
export function sinceFrom(results, biz, now = new Date()) {
  const profile = biz.profile || businessProfile(biz.names || [biz.name], biz.city);
  const thisYear = now.getFullYear();
  const found = [];
  for (const r of results) {
    if (!aboutBusiness(r, profile)) continue;
    const text = `${r.title || ''} ${r.snippet || ''}`;
    const source = label(classifyUrl(r.url)?.host || '');
    for (const m of text.matchAll(/\b(?:business started|in business since|serving[\w\s,]{0,40}? since|since|established(?: in)?|est\.?|founded(?: in)?|opened(?: in)?)\s*:?\s*(?:\d{1,2}\/\d{1,2}\/)?((?:19|20)\d{2})\b/gi)) {
      // "Yelping since 2015", "Member since", "Accredited since" are about someone else, or the directory.
      if (/(yelping|member|accredited|customer|user|joined|reviewer)\W*\w*\W*$/i.test(text.slice(Math.max(0, m.index - 25), m.index))) continue;
      found.push({ year: Number(m[1]), source });
    }
    for (const m of text.matchAll(/\b(?:years? in business|in business for)\s*:?\s*(\d{1,3})\b/gi)) {
      found.push({ year: thisYear - Number(m[1]), source });
    }
  }
  const ok = found.filter((f) => f.year >= 1850 && f.year <= thisYear).sort((a, b) => a.year - b.year);
  return ok[0] || null;
}

const NUM = String.raw`(\d[\d.,]*\s?[KkMm]?)`;

/** "1.2K followers · 340 posts" from the text under a social page's search result, or null. */
export function socialActivity(result) {
  const p = socialProfile(result.url, result.title);
  if (!p) return null;
  const text = `${result.title || ''} ${result.snippet || ''}`;
  const grab = (word) => (text.match(new RegExp(`${NUM}\\s+${word}`, 'i')) || [])[1]?.replace(/\s/g, '');
  const parts = [];
  if (p.network === 'instagram' || p.network === 'tiktok' || p.network === 'x') {
    const followers = grab('followers');
    const posts = grab('posts');
    const likes = p.network === 'tiktok' ? grab('likes') : null;
    if (followers) parts.push(`${followers} followers`);
    if (posts) parts.push(`${posts} posts`);
    if (likes) parts.push(`${likes} likes`);
  } else if (p.network === 'facebook') {
    const likes = grab('likes');
    const followers = grab('followers');
    const talking = grab('talking about this');
    const visits = grab('were here');
    if (likes) parts.push(`${likes} likes`);
    if (followers && !likes) parts.push(`${followers} followers`);
    if (talking) parts.push(`${talking} talking about this`);
    if (visits) parts.push(`${visits} check-ins`);
  } else if (p.network === 'youtube') {
    const subs = grab('subscribers');
    if (subs) parts.push(`${subs} subscribers`);
  }
  return parts.length ? { network: p.network, id: p.id.toLowerCase(), text: parts.join(' · ') } : null;
}

/** Activity for each social account among the results: { 'instagram/roysplumbing': '1.2K followers · 340 posts' }. */
export function socialActivityFrom(results) {
  const out = {};
  for (const r of results) {
    const a = socialActivity(r);
    if (a && !out[`${a.network}/${a.id}`]) out[`${a.network}/${a.id}`] = a.text;
  }
  return out;
}

/** The activity line for one of a lead's social links, if known. */
export function activityFor(url, activity = {}) {
  const p = socialProfile(url);
  return p ? activity[`${p.network}/${p.id.toLowerCase()}`] || null : null;
}
