// "Send to WhatsApp": every lead from a run as plain text, ready to paste or share in one tap.

const MAX_CONTENT = 1950; // Discord's limit is 2000 characters per message
const MAX_DESCRIPTION = 4000; // and 4096 per embed description

/** One lead as a few short lines that read well in WhatsApp. */
export function leadText(lead, n) {
  const name = String(lead.name || '').slice(0, 80);
  const lines = [`${n}. ${name}${lead.categoryLabel ? ` (${lead.categoryLabel})` : ''}`];
  if (lead.phone) lines.push(`📞 ${lead.phone}`);
  if (lead.mapsUrl) lines.push(`📍 ${lead.mapsUrl}`);
  return lines.join('\n');
}

/** The whole run's leads as one block of text (saved to data/run-leads.txt). */
export function leadsText(leads, place) {
  const header = `🎯 ${leads.length} website lead${leads.length === 1 ? '' : 's'}${place ? ` · ${place}` : ''}`;
  return [header, ...leads.map((lead, i) => leadText(lead, i + 1))].join('\n\n');
}

// wa.me opens WhatsApp with the text typed in; the user picks the chat. Brackets are escaped so the
// link survives Discord's [label](url) format.
const waLink = (text) => `https://wa.me/?text=${encodeURIComponent(text).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

/**
 * Discord messages with "📲 Send to WhatsApp" links. As many leads as fit go in each link
 * (usually 8–10), so a big run gets a few links, each labelled with its lead numbers.
 */
export function whatsappMessages(leads, place) {
  if (!leads.length) return [];
  const chunks = [];
  let start = 0;
  while (start < leads.length) {
    let end = start + 1;
    // Grow the chunk while its message still fits.
    while (end < leads.length && build(leads, start, end + 1, place).fits) end += 1;
    chunks.push(build(leads, start, end, place));
    start = end;
  }
  return chunks.map((c, i) => ({
    // A single lead too long for a link (very rare) still gets the copy-ready list.
    content: c.fits ? `${c.label}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}` : '📋 Copy the list below and paste it into WhatsApp',
    embeds: [{ title: '📋 Copy-ready list', description: c.text, color: 0x25d366 }],
  }));
}

function build(leads, start, end, place) {
  const part = leads.slice(start, end);
  const range = leads.length > 1 ? ` ${start + 1}–${end}` : '';
  const header = `🎯 Website leads${range}${place ? ` · ${place}` : ''}`;
  const text = [header, ...part.map((lead, i) => leadText(lead, start + i + 1))].join('\n\n').slice(0, MAX_DESCRIPTION);
  const what = leads.length > 1 ? `leads ${start + 1}–${end}` : 'this lead';
  const label = `📲 **[Send ${what} to WhatsApp](${waLink(text)})** · opens WhatsApp with the list typed in, then pick a chat or "Message yourself"`;
  return { text, label, fits: label.length + 20 <= MAX_CONTENT };
}
