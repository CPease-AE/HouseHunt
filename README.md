# House Hunt

Compare shortlisted rental properties by commute times, price, and home fit. Data lives in a CSV; Node scripts fetch drive times, score listings, and sync a local HTML viewer.

## Quick start

```bash
cd C:\Users\cameron.pease\Documents\HouseHunt

# 1. Fill commute times for any new / incomplete houses
node fetch_times.js

# 2. Score every house from CSV header weights
node score_houses.js

# 3. Sync CSV into the HTML viewer (fast, no network)
node sync_listings.js

# 4. (Optional) Scrape listing photos when URLs change
node fetch_images.js
```

Then open `index.html` in a browser.

---

## Files


| File                                                    | Role                                             |
| ------------------------------------------------------- | ------------------------------------------------ |
| `Property Listings Overview - Cameron - Short List.csv` | Main data + weights (edit this)                  |
| `index.html`                                            | Interactive ranked GUI                           |
| `listings-data.js`                                      | Generated data for the GUI (do not edit by hand) |
| `images/`                                               | Scraped listing photos                           |
| `fetch_times.js`                                        | Google Maps drive times → CSV                    |
| `score_houses.js`                                       | Weighted composite scores → CSV                  |
| `sync_listings.js`                                      | CSV → `listings-data.js` (preserves photos)      |
| `fetch_images.js`                                       | Listing URL scrape → `images/` + photo fields    |
| `House,Destination.csv` / `House_Commute_Summary.csv`   | Earlier commute worksheets (legacy)              |
| `destinations.txt` / `houses.txt`                       | Address reference lists                          |


---

## Workflow (command order)

Run these from the project folder.

### After adding new houses (or empty commute cells)

```bash
node fetch_times.js
node score_houses.js
node sync_listings.js
# node fetch_images.js   # only if new Listing URLs need photos
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

### After adding or changing Listing URLs (photos)

```bash
node sync_listings.js
node fetch_images.js          # missing photos only
# node fetch_images.js --all  # re-scrape every URL
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


| Column              | Destination                                                          |
| ------------------- | -------------------------------------------------------------------- |
| Girls               | 112 Old Barrington Rd, North Barrington, IL                          |
| School              | 40 E Dundee Rd, Barrington, IL                                       |
| Work                | 2600 South River Rd, Des Plaines, IL                                 |
| MSB                 | 39 E Main St, Carpentersville, IL                                    |
| School/Work Commute | House → School + School → Work (summed; used in Location score only) |
| Total Drive Time    | Girls + School + Work + MSB (**excludes** School/Work Commute)       |
| Location Score      | Weighted commute composite (1–10) from the Location mix              |


### `node score_houses.js`

- Reads `(N%)` weights from CSV column headers
- Writes **Composite Score** (1–10, one decimal)
- Writes **Location Score** (weighted destination composite, 1–10)
- Recalculates **Total Drive Time** as Girls+School+Work+MSB (no School/Work)
- Normalizes basement / type labels in the CSV
- Weights are normalized if they do not sum to 100%

### `node sync_listings.js`

- Builds `listings-data.js` from the CSV for `index.html`
- **No network** — keeps existing `imageUrl` / `imageLocal` by address
- Run after scoring or any CSV field edits

### `node fetch_images.js`

- Scrapes featured images (`og:image` / schema) from **Listing URL**
- Saves photos under `images/` and updates photo fields in `listings-data.js`
- Default: only listings still missing a photo
- `--all`: re-scrape every listing that has a URL
- Requires `listings-data.js` first (`node sync_listings.js`)
- Zillow works best with a mobile Safari user-agent (built in)
- Some sites (e.g. apartments.com) may still block scrapes; use Redfin or another URL if needed

---

## CSV columns & scoring

Weights live in the header, e.g. `Price (35%)`, `Type (5%)`. Edit the percentages, then re-run `score_houses.js`.

### Location mix (feeds the Location pillar)


| Factor              | Default weight | Direction                                  |
| ------------------- | -------------- | ------------------------------------------ |
| School              | 30%            | lower time better                          |
| MSB                 | 30%            | lower time better                          |
| School/Work Commute | 25%            | lower time better                          |
| Girls               | 7.5%           | lower time better                          |
| Total Drive Time    | 7.5%           | lower total better (Girls+School+Work+MSB) |


**Work** is kept as a data column only (not weighted). School/Work already covers the school→work corridor; weighting House→Work separately double-counted that leg.

Location’s share of the final score is taken from **Location Score (35%)**.

### Final mix


| Factor            | Default weight | Direction / notes                  |
| ----------------- | -------------- | ---------------------------------- |
| Location Score    | 40%            | weighted commute composite         |
| Price             | 30%            | log utility (absolute)             |
| Includes Basement | 10%            | see basement scale                 |
| Type              | 5%             | Type × basement matrix             |
| Baths             | 7.5%           | absolute brackets                  |
| Beds              | 4%             | absolute brackets                  |
| Sq Ft             | 3.5%           | absolute scale (missing → median)  |
| Parking           | 0%             | unused unless you raise the weight |


### Absolute scales (not shortlist min–max)

Scores stay stable when you add/remove houses. Anchors (editable in `score_houses.js` / `index.html` as `SCALES`):


| Factor              | Scale                                |
| ------------------- | ------------------------------------ |
| Single commute legs | ≤15 min → 10, ≥45 min → 1            |
| School/Work Commute | ≤35 min → 10, ≥70 min → 1            |
| Total Drive Time    | ≤90 min → 10, ≥170 min → 1           |
| Price               | log curve: ~$1,800 → 10, ~$3,800 → 1 |
| Sq Ft               | 1,000 → 1, 2,200 → 10                |
| Beds                | 1→1, 2→4, 3→7, 4→9, 5+→10            |
| Baths               | 1→1, 1.5→4, 2→6.5, 2.5→8.5, 3+→10    |


### Basement (`Includes Basement`)

Allowed values:


| Value        | Score |
| ------------ | ----- |
| `finished`   | 10    |
| `unfinished` | 7     |
| `unknown`    | 2.5   |
| `none`       | 0     |


### Type

Allowed values: `Single Family` or `Townhome`.

Type score (uses basement status):


|                   | Basement (`finished` / `unfinished`) | No basement (`none`) |
| ----------------- | ------------------------------------ | -------------------- |
| **Single Family** | 10                                   | 5                    |
| **Townhome**      | 7                                    | 0                    |


`unknown` basement → midpoint for that type. Blank Type → average of SF and TH for that basement state.

### Listing URL

Paste the public listing link (Zillow, Redfin, Coldwell, etc.). `sync_listings.js` uses it for the “View listing” link; `fetch_images.js` scrapes the photo.

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
- After filling new **Listing URL** values, run `sync_listings.js` then `fetch_images.js` before judging GUI photos.
- Keep header weight totals near 100% per mix for clarity; the scorer still normalizes if they drift.

