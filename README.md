# 🎯 Website Hunting Bot

Finds local businesses that **don't have a website** and sends them to your Discord every day. It's free to run on GitHub.

## How it checks

A business only becomes a lead if it has **no website at all three checks**:

1. **OpenStreetMap:** finds businesses in your city with no website listed. If it doesn't have enough (common for plumbers, roofers and other trades in the US), the bot also **searches Google Maps** for them, e.g. "plumbers in Jackson, Mississippi".
2. **Google Maps:** opens each business's listing and looks for a "Website" button. When Maps shows other names (the business listed under a longer name or the owner's name), the AI says which one, if any, is the same business.
3. **Web search:** searches "*business name + city*" to catch websites Maps doesn't show. With a Gemini key, Gemini runs these searches on Google itself (only sites Google actually returned count). Without one, or once the day's free quota runs out, the bot searches Google's own page, and if Google blocks it, it switches to Brave, then Startpage (Google's results without the blocking), then Bing, then DuckDuckGo.
4. **Their details, from where they're listed:** the bot opens their directory listings (Yelp, Yellow Pages, BBB…) and collects every phone number, email and street address they're listed with. Each different one gets its own search for a website. A site counts as theirs if it shows one of their numbers or emails, or their address and name.
5. **AI (Gemini):** reads the sites that came up and mentions their name, and says whether each is theirs. Then it searches Google itself for their website, by name, phone and address; a site it finds is opened and checked before it counts. Only a business that passes all of this comes to you as a lead.

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
After that it runs by itself every day at 4 PM Pakistan time (GitHub sometimes starts scheduled runs a few minutes late).

## Run it yourself, anywhere, any business type

Open the **Actions** tab → **Website Hunting Bot** → **Run workflow** (works in the GitHub phone app too). A small form appears:

| Box | What to put | If you leave it empty |
|---|---|---|
| **City** | e.g. `Manchester` | uses the city in `config.js` |
| **Country** | e.g. `United Kingdom` (always fill this in with a new city) | uses the country in `config.js` |
| **Type of business** | pick one from the list, e.g. `dentist` | uses all the categories in `config.js` |
| **Or type ANY business type** | anything, e.g. `pool cleaners` or `wedding photographers` (found by searching Google Maps) | not used |

Then tap the green **Run workflow** button. Results arrive in Discord in about 20–40 minutes, with a 🖐️ line showing what you picked.

These settings are for that one run only. The daily 4 PM run always uses `config.js`, so change that file to change the daily hunt. Businesses already checked in any run are never checked or sent twice.

**4. Optional: a Brave Search API key (recommended)**
Google, Brave and Startpage all sometimes block bots running on GitHub. Brave's official Search API never does. Its free allowance should cover the bot's ~30 searches a day; check the current terms when you sign up, as they may ask for a card.
1. Sign up at **https://api-dashboard.search.brave.com**, choose the free plan, and copy your API key.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `BRAVE_API_KEY`
   - Secret: paste the key → **Add secret**

That's it. The Discord summary will say *Brave (API)* when it's being used. Without a key, the bot tries Brave's normal website instead.

**5. Optional: a Gemini API key (AI checks, free, no card)**
1. Go to **https://aistudio.google.com/apikey**, sign in with a Google account and tap **Create API key**.
2. Add it as a repository secret named `GEMINI_API_KEY` (same steps as above).

The free tier allows about 10 AI questions a minute and a few hundred a day; the bot asks at most 100 per run and spaces them out. If the day's limit runs out, the run carries on without the AI and the Discord summary says so. Each lead card's "Checked" line shows *AI ✓* when the AI looked at it. Turn off with `ai: false` in `config.js`.

## What you get

- **Discord:** a summary, then one card per lead with category, phone, a WhatsApp link, Google rating, address, social media and notes. 🔥 means 50+ Google reviews (a busy business with no website, so the best leads).
- **Last check before a lead:** the bot also looks for a website through the lead's email and street address: an email on its own domain (info@joesplumbing.com) has that site opened, and one search for the email and address finds sites by them. A site counts as theirs only if it shows their phone number, their email, or their address together with their name.
- **Websites with a different name:** a site found by search only counts if its address matches the business's name, or if it shows the business's phone number. The bot also searches the phone number itself, so it finds sites named differently from the business (cpimemphis.com for "Culpepper Plumbing"). Turn off with `phoneCheck: false`.
- **Social media IDs:** for every lead the bot also searches "name + town + instagram" (Facebook pages come up there or in the name search) and lists the accounts it's sure are theirs, e.g. 📸 Instagram @roysplumbing, Instagram first. Turn it off with `findSocials: false` in `config.js`.
- **Extra details on each card:** Google's category, opening hours (Google shows the bot only today's, sometimes the whole week), the year they started when a directory says so ("📅 Open since 1990 (BBB)"), social media activity ("📸 Instagram @x — 2,345 followers · 120 posts") and the other sites that list them ("📋 Also listed on: Yelp · BBB").
- **📲 Send this lead to WhatsApp:** at the top of every lead card. It opens WhatsApp with a short version typed in, each line saying where it leads: name, address, a Google search for them, their Google Maps listing, email, phone and social media pages. Pick a chat or "Message yourself" and send.
- **✉️ Email:** found in the search results about the business (directory listings, their Facebook or Instagram page), then on their listing pages on directories (Yellow Pages, Manta, Chamber of Commerce…, opened directly, no extra search); if none show it, one more search for "name + town + email". A directory's own address (like @yelp.com) never counts. Turn off with `findEmail: false`.
- **`data/run-leads.txt`:** the latest run's leads with every detail, as text. The Discord summary links to it; tap **Copy raw file** to copy them all at once.
- **`data/leads.csv`:** every lead ever found. GitHub shows it as a table.
- **`data/last-run.json`:** numbers from the latest run.
- **`data/seen.json`:** every business already checked, so nothing is checked or sent twice.
- **`data/osm-cache.json`:** OpenStreetMap data saved for a week, so the bot keeps working when those servers are busy.

## Categories for `config.js`

`restaurant` · `cafe` · `fast_food` · `bakery` · `salon` · `dentist` · `clinic` · `pharmacy` · `gym` · `car_repair` · `car_dealer` · `motorcycle` · `clothes` · `shoes` · `jewelry` · `electronics` · `furniture` · `hardware` · `grocery` · `butcher` · `optician` · `florist` · `hotel` · `real_estate` · `lawyer` · `accountant` · `travel_agency` · `vet` · `laundry` · `printing` · `photographer` · `pet_shop` · `books` · `driving_school` · `plumber` · `electrician` · `hvac` · `roofer` · `painter` · `locksmith` · `carpenter` · `cleaning` · `landscaping`

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
- **Change the time:** edit the `cron` line in `.github/workflows/hunt.yml`. It's in UTC (Pakistan = UTC+5, so 4 PM is `0 11 * * *`).
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
