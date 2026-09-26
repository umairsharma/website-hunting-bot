# 🎯 Website Hunting Bot

Finds local businesses that **don't have a website** and sends them to your Discord every day. It's free to run on GitHub.

## How it checks

A business only becomes a lead if it has **no website at all three checks**:

1. **OpenStreetMap:** finds businesses in your city with no website listed.
2. **Google Maps:** opens each business's listing and looks for a "Website" button.
3. **Web search:** searches "*business name + city*" to catch websites Maps doesn't show. If Google blocks the bot, it switches to Bing, then DuckDuckGo.

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
After that it runs by itself every day at about 9:17 AM Pakistan time.

## What you get

- **Discord:** a summary, then one card per lead with category, phone, a WhatsApp link, Google rating, address, social pages and notes. 🔥 means 50+ Google reviews (a busy business with no website, so the best leads).
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
| *Web search: Google blocked the bot… used Bing* | Nothing, that's the fallback working. |
| *OpenStreetMap has no businesses…* | Add more categories, set `radiusKm: 0`, or try a bigger city. OpenStreetMap has less data in some countries. |
| *Every business found has already been checked* | You've used up that area. Add categories or change the city. |
| *config.js has a mistake* | You probably deleted a comma or quote mark. Undo your last edit. |

- **Start over:** delete `data/seen.json`, and everything gets re-checked.
- **Change the time:** edit the `cron` line in `.github/workflows/hunt.yml`. It's in UTC (Pakistan = UTC+5).
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
