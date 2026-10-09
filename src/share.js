// "Send to WhatsApp": each lead card in Discord gets a link that opens WhatsApp with every detail
// of that lead typed in (the same details the card shows). The user picks the chat.

import { hostOf, prettySite } from './matching.js';
import { socialIcon, socialLabel } from './socials.js';
import { activityFor } from './details.js';

/** A Google search for the business by name and town, for checking it by hand ("do they have a website?"). */
export function googleSearchUrl(lead) {
  // The town from the address ("…, Memphis, TN 38104, United States" → "Memphis, TN"), else the run's city.
  const parts = String(lead.address || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (/^(united states|usa|us|united kingdom|uk|pakistan)$/i.test(parts.at(-1) || '')) parts.pop();
  const town = parts.length >= 2 ? parts.slice(-2).join(' ').replace(/\b\d{4,6}\b/g, '').trim() : lead.city;
  const q = [lead.name, town || lead.city].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  return `https://www.google.com/search?q=${encodeURIComponent(q).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;
}

const DAY_SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

/**
 * Opening hours as one line: the whole week when Google showed it ("Mon 9 AM–7 PM, Tue …"), otherwise
 * the one day it showed ("Thursday 9 AM–7 PM (only today's shown)"), or OpenStreetMap's hours.
 */
export function hoursText(hours, { short = false } = {}) {
  if (!hours) return null;
  const days = hours.days || [];
  if (days.length > 1) {
    const week = days.map(([d, t]) => `${DAY_SHORT[d.toLowerCase()] || d} ${t}`).join(', ');
    return short && week.length > 120 ? `${week.slice(0, 119)}…` : week;
  }
  // Google shows only today's hours to the bot. "Open now"/"Closed" is left out: it was only true when the bot ran.
  if (days.length === 1) return `${days[0][0]} ${days[0][1]} (only today's shown)`;
  return hours.text || null;
}

// The link goes at the top of the card (the embed description, up to 4096 characters). Long links are
// kept under 2000, which Discord and WhatsApp both open reliably.
export const MAX_LINK = 2000;

// wa.me opens WhatsApp with the text typed in. Brackets are escaped so the link survives Discord's [label](url).
const waLink = (text) => `https://wa.me/?text=${encodeURIComponent(text).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

/**
 * One lead with all its details, in WhatsApp formatting (*bold*).
 * `level` drops the least useful details first when a link would be too long (0 = everything).
 */
export function leadText(lead, { n = null, level = 0 } = {}) {
  const hot = (lead.reviews || 0) >= 50 ? '🔥 ' : '';
  const lines = [`${n ? `${n}. ` : ''}${hot}*${lead.name}*${lead.categoryLabel ? ` (${lead.categoryLabel})` : ''}`];
  if (lead.rating != null) lines.push(`⭐ ${lead.rating}${lead.reviews ? ` (${Number(lead.reviews).toLocaleString('en-US')} reviews)` : ''}`);
  if (lead.phone) lines.push(`📞 ${lead.phone}`);

  if (lead.address) lines.push(`🏠 ${level >= 5 && lead.address.length > 70 ? `${lead.address.slice(0, 69)}…` : lead.address}`);
  if (lead.mapsUrl) lines.push(`📍 ${lead.mapsUrl}`);
  lines.push(`🔎 ${googleSearchUrl(lead)}`); // a Google search for them, to check by hand
  if (lead.email) lines.push(`✉️ ${lead.email}`);
  if (lead.category && level < 4) lines.push(`🏷️ ${lead.category}`);
  const hours = hoursText(lead.hours, { short: level >= 2 });
  if (hours) lines.push(`🕒 ${hours}`);
  if (lead.since) lines.push(`📅 Open since ${lead.since}`);
  const socials = (lead.socials || []).slice(0, level >= 4 ? 0 : level >= 3 ? 1 : 4);
  for (const url of socials) {
    const activity = activityFor(url, lead.socialActivity);
    lines.push(`${socialIcon(url)} ${socialLabel(url) || prettySite(hostOf(url))}${activity ? ` (${activity})` : ''}: ${url}`);
  }
  if (lead.listings?.length && level < 3) lines.push(`📋 Also listed on: ${lead.listings.map((l) => (level >= 1 ? l.name : `${l.name} ${l.url}`)).join(level >= 1 ? ', ' : ' · ')}`);
  const notes = level >= 2 ? [] : (lead.notes || []).slice(0, level >= 1 ? 2 : 10);
  for (const note of notes) lines.push(`📝 ${note}`);
  return lines.join('\n');
}

/** wa.me link for one lead, with as many details as fit in a Discord field. */
export function leadShareLink(lead) {
  for (let level = 0; level <= 5; level += 1) {
    const link = waLink(leadText(lead, { level }));
    if (link.length <= MAX_LINK) return link;
  }
  // Very long name or address: name, phone and Maps link only, shortening the name until it fits.
  for (let len = 80; len > 0; len -= 10) {
    const link = waLink(leadText({ name: String(lead.name).slice(0, len), phone: lead.phone, mapsUrl: lead.mapsUrl }));
    if (link.length <= MAX_LINK) return link;
  }
  return waLink(String(lead.name).slice(0, 40));
}

/** The whole run's leads with every detail (saved to data/run-leads.txt). */
export function leadsText(leads, place) {
  const header = `🎯 ${leads.length} website lead${leads.length === 1 ? '' : 's'}${place ? ` · ${place}` : ''}`;
  return [header, ...leads.map((lead, i) => leadText(lead, { n: i + 1 }))].join('\n\n');
}
