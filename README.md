# House Hunt

Compare shortlisted rental properties by commute times, price, and home fit. Data lives in a CSV; Node scripts fetch drive times, score listings, and sync a local HTML viewer.

## Quick start

```bash
cd C:\Users\cameron.pease\Documents\HouseHunt

# 1. Fill commute times for any new / incomplete houses
node fetch_times.js

# 2. Score every house from CSV header weights
node score_houses.js

# 3. Sync CSV + listing photos into the HTML viewer
node sync_listings.js
```

Then open `index.html` in a browser.

---

## Files

| File | Role |
|------|------|
| `Property Listings Overview - Cameron - Short List.csv` | Main data + weights (edit this) |
| `index.html` | Interactive ranked GUI |
| `listings-data.js` | Generated data for the GUI (do not edit by hand) |
| `images/` | Scraped listing photos |
| `fetch_times.js` | Google Maps drive times → CSV |
| `score_houses.js` | Weighted composite scores → CSV |
| `sync_listings.js` | CSV + photo scrape → `listings-data.js` |
| `House,Destination.csv` / `House_Commute_Summary.csv` | Earlier commute worksheets (legacy) |
| `destinations.txt` / `houses.txt` | Address reference lists |

---

## Workflow (command order)

Run these from the project folder.

### After adding new houses (or empty commute cells)

```bash
node fetch_times.js
node score_houses.js
node sync_listings.js
```

Refresh `index.html`.

### After editing weights, basement, type, price, beds, etc. (commutes already filled)

```bash
node score_houses.js
node sync_listings.js
```

### Refresh all commute times

```bash
node fetch_times.js --all
node score_houses.js
node sync_listings.js
```

### GUI-only weight experiments

Open `index.html` → **Edit weights**. Sliders rescore live and show a **Total** (aim for 100% per mix). These changes do **not** write back to the CSV until you change the header weights and re-run `score_houses.js`.

---

## Script reference

### `node fetch_times.js`

- Reads addresses from **Property Listings Overview**
- Fills: Girls, School, Work, MSB, School/Work Commute, Total Drive Time
- Default: only rows missing commute values
- `--all`: refresh every house

Destinations:

| Column | Destination |
|--------|-------------|
| Girls | 112 Old Barrington Rd, North Barrington, IL |
| School | 40 E Dundee Rd, Barrington, IL |
| Work | 2600 South River Rd, Des Plaines, IL |
| MSB | 39 E Main St, Carpentersville, IL |
| School/Work Commute | House → School + School → Work (summed; used in Location score only) |
| Total Drive Time | Girls + School + Work + MSB (**excludes** School/Work Commute) |
| Location Score | Weighted commute composite (1–10) from the Location mix |

### `node score_houses.js`

- Reads `(N%)` weights from CSV column headers
- Writes **Composite Score** (1–10, one decimal)
- Writes **Location Score** (weighted destination composite, 1–10)
- Recalculates **Total Drive Time** as Girls+School+Work+MSB (no School/Work)
- Normalizes basement / type labels in the CSV
- Weights are normalized if they do not sum to 100%

### `node sync_listings.js`

- Builds `listings-data.js` from the CSV for `index.html`
- Scrapes featured images (`og:image` / schema) from **Listing URL**
- Saves photos under `images/`
- Zillow works best with a mobile Safari user-agent (built in)
- Some sites (e.g. apartments.com) may still block scrapes; use Redfin or another URL if needed

---

## CSV columns & scoring

Weights live in the header, e.g. `Price (30%)`, `Type (10%)`. Edit the percentages, then re-run `score_houses.js`.

### Location mix (feeds the Location pillar)

| Factor | Default weight | Direction |
|--------|----------------|-----------|
| School | 30% | lower time better |
| MSB | 30% | lower time better |
| School/Work Commute | 25% | lower time better |
| Girls | 7.5% | lower time better |
| Work | 7.5% | lower time better |

Location’s share of the final score is taken from **Location Score (30%)**.

### Final mix

| Factor | Default weight | Direction / notes |
|--------|----------------|-------------------|
| Location Score | 30% | weighted commute composite (not Total Drive Time) |
| Price | 30% | lower better |
| Includes Basement | 15% | see basement scale |
| Type | 10% | Type × basement matrix |
| Baths | 7.5% | higher better |
| Beds | 3.75% | higher better |
| Sq Ft | 3.75% | higher better (missing → median) |
| Parking | 0% | unused unless you raise the weight |

Scores for continuous factors are min–max scaled within the short list to 1–10.

### Basement (`Includes Basement`)

Allowed values:

| Value | Score |
|-------|------:|
| `finished` | 10 |
| `unfinished` | 7 |
| `unknown` | 2.5 |
| `none` | 0 |

### Type

Allowed values: `Single Family` or `Townhome`.

Type score (uses basement status):

| | Basement (`finished` / `unfinished`) | No basement (`none`) |
|--|--:|--:|
| **Single Family** | 10 | 5 |
| **Townhome** | 7 | 0 |

`unknown` basement → midpoint for that type. Blank Type → average of SF and TH for that basement state.

### Listing URL

Paste the public listing link (Zillow, Redfin, Coldwell, etc.). `sync_listings.js` uses it for the “View listing” link and photo scrape.

---

## HTML GUI (`index.html`)

- Ranked cards with score, photo, price, commute chips
- Full address under the short title
- Click a card for factor breakdown + listing link
- **Edit weights** — Final mix + Location mix with live totals (on target / under / over 100%)
- Sort by composite score, price, location, or total drive time

Data source: `listings-data.js` (from sync). If that file is missing, the page falls back to embedded sample data.

---

## Tips

- Close the CSV in Excel before running scripts if you get `EBUSY` / file locked errors.
- After filling new **Listing URL** values, always run `sync_listings.js` before judging the GUI photos.
- Keep header weight totals near 100% per mix for clarity; the scorer still normalizes if they drift.
