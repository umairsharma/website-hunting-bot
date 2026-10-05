# 🎯 Website Hunting Bot

Finds local businesses that **don't have a website** and sends them to your Discord every day. It's free to run on GitHub.

## How it checks

A business only becomes a lead if it has **no website at all three checks**:

1. **OpenStreetMap:** finds businesses in your city with no website listed.
2. **Google Maps:** opens each business's listing and looks for a "Website" button.
3. **Web search:** searches "*business name + city*" to catch websites Maps doesn't show. If Google blocks the bot, it switches to Brave, then Startpage (Google's results without the blocking), then Bing, then DuckDuckGo.

Facebook pages, Instagram, Foodpanda and booking sites (Marham, Oladoc…) **don't count** as a website, so a business that only has one of those is still a lead.

## Setup (works from your phone)

**1. Add your Discord webhook**
Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
- Name: `DISCORD_WEBHOOK_URL`
- Secret: paste your webhook URL → **Add secret**

**2. Pick your city and business types**
Open `config.js` → tap ✏️ → change `city`, `country`, `categories` → **Commit changes**.

**3. Run it**
**Actions** tab → **Website Hunting Bot** → **Run workflow** → **Run workflow**.
After that it runs by itself every day at 9 AM UK time (GitHub sometimes starts scheduled runs a few minutes late).

## Run it yourself, anywhere, any business type

Open the **Actions** tab → **Website Hunting Bot** → **Run workflow** (works in the GitHub phone app too). A small form appears:

| Box | What to put | If you leave it empty |
|---|---|---|
| **City** | e.g. `Manchester` | uses the city in `config.js` |
| **Country** | e.g. `United Kingdom` (always fill this in with a new city) | uses the country in `config.js` |
| **Type of business** | pick one from the list, e.g. `dentist` | uses all the categories in `config.js` |

Then tap the green **Run workflow** button. Results arrive in Discord in about 20–40 minutes, with a 🖐️ line showing what you picked.

These settings are for that one run only. The daily 9 AM run always uses `config.js`, so change that file to change the daily hunt. Businesses already checked in any run are never checked or sent twice.

**4. Optional: a Brave Search API key (recommended)**
Google, Brave and Startpage all sometimes block bots running on GitHub. Brave's official Search API never does. Its free allowance should cover the bot's ~30 searches a day; check the current terms when you sign up, as they may ask for a card.
1. Sign up at **https://api-dashboard.search.brave.com**, choose the free plan, and copy your API key.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `BRAVE_API_KEY`
   - Secret: paste the key → **Add secret**

That's it. The Discord summary will say *Brave (API)* when it's being used. Without a key, the bot tries Brave's normal website instead.

## What you get

- **Discord:** a summary, then one card per lead with category, phone, a WhatsApp link, Google rating, address, social pages and notes. 🔥 means 50+ Google reviews (a busy business with no website, so the best leads).
- **📲 Send to WhatsApp:** after the lead cards, a link that opens WhatsApp with all of that run's leads typed in (name, type, phone, Google Maps link). Pick a chat or "Message yourself" and send. Big runs get one link per 8–10 leads.
- **`data/run-leads.txt`:** the latest run's leads as plain text. Open it on GitHub and tap **Copy raw file** to copy them all.
- **`data/leads.csv`:** every lead ever found. GitHub shows it as a table.
- **`data/last-run.json`:** numbers from the latest run.
- **`data/seen.json`:** every business already checked, so nothing is checked or sent twice.
- **`data/osm-cache.json`:** OpenStreetMap data saved for a week, so the bot keeps working when those servers are busy.

## Categories for `config.js`

`restaurant` · `cafe` · `fast_food` · `bakery` · `salon` · `dentist` · `clinic` · `pharmacy` · `gym` · `car_repair` · `car_dealer` · `motorcycle` · `clothes` · `shoes` · `jewelry` · `electronics` · `furniture` · `hardware` · `grocery` · `butcher` · `optician` · `florist` · `hotel` · `real_estate` · `lawyer` · `accountant` · `travel_agency` · `vet` · `laundry` · `printing` · `photographer` · `pet_shop` · `books` · `driving_school` · `plumber` · `electrician`

You can also use any [OpenStreetMap tag](https://wiki.openstreetmap.org/wiki/Map_features), like `'shop=bicycle'`.

## If something goes wrong

The Discord summary always says what happened. Common messages:

| Message | What to do |
|---|---|
| *Google Maps blocked the bot* / *couldn't read Google Maps* | Nothing. It retries next run. If it happens every day, set `requireMapsCheck: false` in `config.js`. |
| *Web search: Google blocked the bot… used Brave* (or Startpage / Bing) | Nothing, that's the fallback working. Add a Brave API key (below) so Brave never blocks. |
| *Every search engine blocked the bot, so it stopped early* | Engines that block get a second try after a 5-minute break. If it keeps happening, add a Brave API key (above), or set `requireWebSearch: false` in `config.js` to keep going with OpenStreetMap + Google Maps only (those leads say "double-check"). |
| *OpenStreetMap has no businesses…* | Add more categories, set `radiusKm: 0`, or try a bigger city. OpenStreetMap has less data in some countries. |
| *Every business found has already been checked* | You've used up that area. Add categories or change the city. |
| *config.js has a mistake* | You probably deleted a comma or quote mark. Undo your last edit. |

- **Start over:** delete `data/seen.json`, and everything gets re-checked.
- **Change the time:** edit the two `cron` lines and the matching times in the `time-check` job in `.github/workflows/hunt.yml`. They're in UTC (UK = UTC+1 in summer, UTC+0 in winter).
- **Workflow shows a red ❌:** open it and read the "Hunt for leads" step. The error is at the bottom.

## Good to know

- Google doesn't allow automated searches, so the bot goes slowly (about 30 checks a day with random pauses) to stay under the radar. Blocks can still happen. When one does, the bot stops checking and retries next run instead of sending half-checked leads.
- Every run starts by checking a place that definitely has a website (the Eiffel Tower). If the bot can't see that website, Google changed something, and it won't send leads it can't trust.
- A private repo gets 2,000 free GitHub Actions minutes a month. One run takes about 15–20 minutes, so daily runs fit.

## For developers

```bash
npm install
npx playwright install chromium
npm test                          # unit tests + full runs against fake Google/OSM/Discord
node src/index.js --dry-run       # real run, but saves nothing and posts nothing
```
