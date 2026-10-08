// A lead's social media pages and IDs (@handles), especially Instagram: a business with no website
// usually has one of these, and it's the easiest way to reach them.

import { businessProfile, compact, normalizeText, siteMatchesBusiness, titleMentionsName } from './matching.js';

const STOP_WORDS = new Set(['the', 'and', 'pvt', 'ltd', 'llc', 'inc', 'co', 'company']);
const tokensOf = (s) => normalizeText(s).split(' ').filter(Boolean);

const NETWORKS = [
  { id: 'instagram', label: 'Instagram', host: /(^|\.)(instagram\.com|instagr\.am)$/, at: true,
    skip: /^(p|reel|reels|tv|explore|stories|accounts|about|developer|legal|direct|web|popular|tags|locations)$/ },
  { id: 'facebook', label: 'Facebook', host: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/, at: false,
    skip: /^(groups|events|watch|photo|photos|photo\.php|story\.php|sharer|sharer\.php|share|reel|marketplace|login|hashtag|search|help|policies|permalink\.php|plugins|dialog|home\.php|gaming|business|privacy)$/ },
  { id: 'tiktok', label: 'TikTok', host: /(^|\.)tiktok\.com$/, at: true, handle: /^@([\w.]{2,30})$/ },
  { id: 'x', label: 'X (Twitter)', host: /(^|\.)(twitter\.com|x\.com)$/, at: true,
    skip: /^(home|search|explore|intent|share|hashtag|i|settings|login|status)$/ },
  { id: 'youtube', label: 'YouTube', host: /(^|\.)youtube\.com$/, at: true, handle: /^@([\w.-]{2,40})$/ },
  { id: 'linkedin', label: 'LinkedIn', host: /(^|\.)linkedin\.com$/, at: false, prefix: /^(company|showcase)$/ },
];

/**
 * The profile a social link belongs to: { network, label, id, display, url }, or null for a post,
 * a search page or anything that isn't one account's page. display is what to show ("@roysplumbing").
 * A link to a single post can still name its account in the result title ("Roy's (@roysplumbing) …").
 */
export function socialProfile(raw, title = '') {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|business|[a-z]{2}(-[a-z]{2})?)\./, '');
  const net = NETWORKS.find((n) => n.host.test(host));
  if (!net) return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  let id = null;
  if (net.id === 'facebook') {
    if (parts[0] === 'profile.php') id = u.searchParams.get('id');
    else if (['people', 'pages'].includes(parts[0])) id = parts[2] || parts[1] || null; // pages/Name/123 → 123
    else if (parts[0] === 'p' && parts[1]) id = parts[1];
    else if (parts[0] && !net.skip.test(parts[0])) id = parts[0];
  } else if (net.handle) {
    const m = (parts[0] || '').match(net.handle);
    id = m ? m[1] : null;
  } else if (net.prefix) {
    id = net.prefix.test(parts[0] || '') && parts[1] ? parts[1] : null;
  } else if (parts[0] && !net.skip.test(parts[0])) {
    id = parts[0];
  }
  if (!id && ['instagram', 'tiktok'].includes(net.id)) {
    // A post or reel: the account is often in the title.
    const m = String(title).match(/\(@([\w.]{2,30})\)|^@([\w.]{2,30})\b|\B@([\w.]{2,30}) on /);
    id = m ? m[1] || m[2] || m[3] : null;
  }
  if (!id || !/^[\w.-]{2,80}$/.test(id)) return null;
  const url = {
    instagram: `https://www.instagram.com/${id}/`,
    tiktok: `https://www.tiktok.com/@${id}`,
    x: `https://x.com/${id}`,
    youtube: `https://www.youtube.com/@${id}`,
  }[net.id] || u.href;
  return { network: net.id, label: net.label, id, display: net.at ? `@${id}` : id, url };
}

/**
 * The business's own social profiles among search results: the page title names the business, or
 * the handle is clearly its name (@roysplumbingms for "Roy's Plumbing"). One per network, in order.
 */
export function findSocials(results, biz) {
  const profile = biz.profile || businessProfile(biz.names || [biz.name], biz.city);
  const out = new Map();
  for (const r of results) {
    const p = socialProfile(r.url, r.title);
    if (!p || out.has(p.network)) continue;
    // A Facebook page's name is in its title; a numeric ID says nothing on its own.
    // Handles are short, so the start of the name is enough (@roysplumbingms for "Roy's Plumbing, Heating & Cooling").
    const handle = compact(p.id);
    const start = compact(tokensOf(biz.name).filter((w) => !STOP_WORDS.has(w)).slice(0, 2).join(' '));
    const ownHandle = !/^\d+$/.test(p.id)
      && ((start.length >= 8 && handle.includes(start)) || siteMatchesBusiness(handle, profile, r.title));
    if (ownHandle || titleMentionsName(r.title || '', profile)) out.set(p.network, p);
  }
  return [...out.values()];
}

/** "Instagram @roysplumbing" for a social link (falls back to the site's name). */
export function socialLabel(url) {
  const p = socialProfile(url);
  return p ? `${p.label} ${p.display}` : null;
}

/** Social links, one per account, the business's Instagram first. */
export function orderSocials(urls) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    const p = socialProfile(url);
    const key = p ? `${p.network}/${p.id.toLowerCase()}` : url.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: p ? p.url : url, rank: p ? NETWORKS.findIndex((n) => n.id === p.network) : NETWORKS.length });
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.url);
}

/** 📸 for Instagram, 🔗 for the rest. */
export const socialIcon = (url) => (socialProfile(url)?.network === 'instagram' ? '📸' : '🔗');
