// "Send to WhatsApp": each lead card in Discord gets a link that opens WhatsApp with every detail
// of that lead typed in (the same details the card shows). The user picks the chat.

import { hostOf, prettySite } from './matching.js';

// A Discord field holds 1024 characters, including the "[Send this lead to WhatsApp](…)" around the link.
const MAX_LINK = 980;

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
  if (lead.whatsapp) lines.push(`💬 ${lead.whatsapp}`);
  if (lead.address) lines.push(`🏠 ${level >= 5 && lead.address.length > 70 ? `${lead.address.slice(0, 69)}…` : lead.address}`);
  if (lead.mapsUrl) lines.push(`📍 ${lead.mapsUrl}`);
  if (lead.email) lines.push(`✉️ ${lead.email}`);
  const socials = (lead.socials || []).slice(0, level >= 4 ? 0 : level >= 3 ? 1 : 4);
  for (const url of socials) lines.push(`🔗 ${prettySite(hostOf(url))}: ${url}`);
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
