// Sends the run summary + one card per lead to a Discord channel via webhook.

import { hostOf, prettySite } from './matching.js';
import { sleep } from './util.js';

const MAX_EMBEDS_PER_MESSAGE = 10; // Discord limit
const MAX_CHARS_PER_MESSAGE = 5800; // Discord limit is 6000 across all embeds
const HOT_REVIEWS = 50; // busy places with no website = best leads

const clip = (value, max) => {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const safeUrl = (u) => String(u).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');

/** "📍 Google Maps" field: their listing when the bot found one, otherwise the spot on the map. */
function mapsField(lead) {
  let url = lead.mapsUrl && /^https?:\/\//.test(lead.mapsUrl) ? safeUrl(lead.mapsUrl) : null;
  if (url && url.length > 900) {
    // Too long for a Discord field: search Maps for the name instead.
    url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([lead.name, lead.address || lead.city].filter(Boolean).join(', '))}`;
  }
  if (!url) return null;
  const value = lead.onMaps ? `[Open their Google Maps listing](${url})` : `Not listed on Google Maps · [See the location](${url})`;
  return { name: '📍 Google Maps', value };
}

export function leadEmbed(lead) {
  const hot = (lead.reviews || 0) >= HOT_REVIEWS;
  const fields = [{ name: 'Category', value: clip(lead.categoryLabel || '—', 1024), inline: true }];
  if (lead.phone) {
    const wa = lead.whatsapp ? `\n[Open in WhatsApp](${safeUrl(lead.whatsapp)})` : '';
    fields.push({ name: 'Phone', value: clip(`${lead.phone}${wa}`, 1024), inline: true });
  }
  if (lead.rating != null) {
    const count = lead.reviews ? ` (${lead.reviews.toLocaleString('en-US')} reviews)` : '';
    fields.push({ name: 'Google rating', value: `⭐ ${lead.rating}${count}`, inline: true });
  }
  if (lead.address) fields.push({ name: 'Address', value: clip(lead.address, 1024) });
  const maps = mapsField(lead);
  if (maps) fields.push(maps);
  if (lead.email) fields.push({ name: 'Email', value: clip(lead.email, 1024) });
  if (lead.socials?.length) {
    const links = lead.socials.map((u) => `[${prettySite(hostOf(u))}](${safeUrl(u)})`).join(' · ');
    fields.push({ name: 'Social pages', value: clip(links, 1024) });
  }
  if (lead.notes?.length) fields.push({ name: 'Notes', value: clip(lead.notes.map((n) => `• ${n}`).join('\n'), 1024) });

  const embed = {
    title: clip(`${hot ? '🔥 ' : ''}${lead.name}`, 256),
    color: hot ? 0xf97316 : 0x22c55e,
    fields,
    footer: { text: clip(lead.checks || '', 2048) },
  };
  if (lead.mapsUrl && /^https?:\/\//.test(lead.mapsUrl)) embed.url = lead.mapsUrl;
  return embed;
}

function embedSize(e) {
  return (e.title || '').length
    + (e.footer?.text || '').length
    + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/** Summary text first, then lead cards packed into as few messages as Discord allows. */
export function buildMessages(summaryText, leads) {
  const messages = [];
  let current = { content: clip(summaryText, 2000), embeds: [] };
  let chars = 0;
  for (const lead of leads) {
    const embed = leadEmbed(lead);
    const size = embedSize(embed);
    if (current.embeds.length >= MAX_EMBEDS_PER_MESSAGE || chars + size > MAX_CHARS_PER_MESSAGE) {
      messages.push(current);
      current = { embeds: [] };
      chars = 0;
    }
    current.embeds.push(embed);
    chars += size;
  }
  if (current.content || current.embeds.length) messages.push(current);
  return messages;
}

export async function sendMessages(webhookUrl, messages, log = () => {}) {
  let sent = 0;
  const url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;
  const queue = [...messages];
  let total = messages.length;
  while (queue.length) {
    const message = queue.shift();
    const body = JSON.stringify({ username: 'Website Hunting Bot', allowed_mentions: { parse: [] }, ...message });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30000) });
      } catch (err) {
        log(`   Discord: ${err.message}`);
        await sleep(2000);
        continue;
      }
      if (res.status === 429) {
        const info = await res.json().catch(() => ({}));
        await sleep(Math.ceil((Number(info.retry_after) || 1) * 1000) + 250);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const embeds = message.embeds || [];
        if (res.status === 400 && (embeds.length > 1 || (message.content && embeds.length))) {
          // One bad lead card makes Discord reject the whole message, so send the parts separately.
          log(`   Discord rejected a message (HTTP 400), resending its ${embeds.length} card(s) one by one`);
          const parts = embeds.map((e) => ({ embeds: [e] }));
          if (message.content) parts.unshift({ content: message.content, embeds: [] });
          queue.unshift(...parts);
          total += parts.length - 1;
          break;
        }
        log(`   Discord rejected a message (HTTP ${res.status}): ${text.slice(0, 200)}`);
        if (res.status === 401 || res.status === 404) log('   → The DISCORD_WEBHOOK_URL secret looks wrong or the webhook was deleted.');
        break;
      }
      sent += 1;
      break;
    }
    await sleep(600);
  }
  return { sent, total };
}
