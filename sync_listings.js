/**
 * Sync CSV → listings-data.js for the HTML GUI (no network).
 * Always keeps previously fetched imageUrl / imageLocal (matched by
 * address, listing URL, or existing file under images/).
 *
 * Usage: node sync_listings.js
 *
 * To scrape listing photos: node fetch_images.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CSV_PATH = path.join(
  ROOT,
  "Property Listings Overview - Cameron - Short List.csv"
);
const OUT_JS = path.join(ROOT, "listings-data.js");
const IMG_DIR = path.join(ROOT, "images");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseHeader(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*%\)\s*$/i);
  if (m) return { base: m[1].trim(), weightPct: parseFloat(m[2]) };
  return { base: s, weightPct: null };
}

function findCol(header, baseName) {
  const target = baseName.toLowerCase();
  for (let i = 0; i < header.length; i++) {
    if (parseHeader(header[i]).base.toLowerCase() === target) return i;
  }
  return -1;
}

function parseMinutes(text) {
  if (!text) return null;
  const s = String(text);
  const fromLink = s.match(/","([^"]+)"\)/);
  const label = fromLink ? fromLink[1] : s;
  const hr = label.match(/(\d+)\s*hr(?:s)?(?:\s*(\d+)\s*min)?/i);
  if (hr) return parseInt(hr[1], 10) * 60 + parseInt(hr[2] || "0", 10);
  const min = label.match(/(\d+)\s*min/i);
  return min ? parseInt(min[1], 10) : null;
}

function parsePrice(text) {
  if (!text) return null;
  const n = String(text).replace(/[^0-9.]/g, "");
  return n ? parseFloat(n) : null;
}

function parseNumber(text) {
  if (text === null || text === undefined || String(text).trim() === "")
    return null;
  const n = parseFloat(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeBasement(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/^(yes|y|finished|fin)$/.test(s)) return "finished";
  if (/^(unfinished|unfin)$/.test(s)) return "unfinished";
  if (/^(unknown|unk|\?)$/.test(s)) return "unknown";
  if (/^(no|n|none|0)$/.test(s)) return "none";
  return "unknown";
}

function normalizeType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/single[\s-]?family|sfh|^sf$|house|detached/.test(s)) return "single-family";
  if (/duplex|two[\s-]?flat|2[\s-]?flat|multi[\s-]?family/.test(s)) return "duplex";
  if (/town\s*-?\s*home|townhouse|^th$|row\s*home/.test(s)) return "townhome";
  return "unknown";
}

function slugify(address) {
  return String(address)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** Collapse address noise so "Dr." / "Drive" / extra commas still match */
function normalizeAddressKey(address) {
  return String(address || "")
    .toLowerCase()
    .replace(/[#.,]/g, " ")
    .replace(
      /\b(street|st|drive|dr|road|rd|lane|ln|avenue|ave|terrace|ter|trail|trl|circle|cir|court|ct|boulevard|blvd|parkway|pkwy)\b/g,
      ""
    )
    .replace(/\b(il|illinois)\b/g, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function loadExistingListings() {
  if (!fs.existsSync(OUT_JS)) return [];
  const text = fs.readFileSync(OUT_JS, "utf8");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const list = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn(
      "Warning: could not parse existing listings-data.js:",
      e.message
    );
    return [];
  }
}

/**
 * Build lookup indexes so photos survive address wording changes.
 * Keys: exact address, normalized address, listing URL, image slug.
 */
function buildImageIndex(existing) {
  const byAddress = new Map();
  const byNormAddress = new Map();
  const byUrl = new Map();
  const bySlug = new Map();

  function remember(key, map, photos) {
    if (!key || map.has(key)) return;
    if (!photos.imageUrl && !photos.imageLocal) return;
    map.set(key, photos);
  }

  for (const item of existing) {
    if (!item) continue;
    const photos = {
      imageUrl: item.imageUrl || null,
      imageLocal: item.imageLocal || null,
    };
    if (!photos.imageUrl && !photos.imageLocal) continue;

    remember(item.address, byAddress, photos);
    remember(normalizeAddressKey(item.address), byNormAddress, photos);
    remember(normalizeUrlKey(item.listingUrl), byUrl, photos);
    remember(slugify(item.address), bySlug, photos);
    if (photos.imageLocal) {
      const base = path.basename(
        photos.imageLocal,
        path.extname(photos.imageLocal)
      );
      remember(base, bySlug, photos);
    }
  }

  return { byAddress, byNormAddress, byUrl, bySlug };
}

/** If a matching file already lives in images/, reuse it */
function findLocalImageFile(address) {
  if (!fs.existsSync(IMG_DIR)) return null;
  const slug = slugify(address);
  if (!slug) return null;
  const files = fs.readdirSync(IMG_DIR);
  const hit = files.find((f) => {
    const base = f.replace(/\.[^.]+$/, "");
    return base === slug || base.startsWith(slug) || slug.startsWith(base);
  });
  return hit ? "images/" + hit : null;
}

function resolvePhotos(address, listingUrl, index) {
  const candidates = [
    index.byAddress.get(address),
    index.byNormAddress.get(normalizeAddressKey(address)),
    index.byUrl.get(normalizeUrlKey(listingUrl)),
    index.bySlug.get(slugify(address)),
  ].filter(Boolean);

  let imageUrl = null;
  let imageLocal = null;
  for (const c of candidates) {
    if (!imageUrl && c.imageUrl) imageUrl = c.imageUrl;
    if (!imageLocal && c.imageLocal) imageLocal = c.imageLocal;
  }

  if (imageLocal) {
    const abs = path.join(ROOT, imageLocal);
    if (!fs.existsSync(abs)) {
      imageLocal = null;
    }
  }

  if (!imageLocal) {
    const discovered = findLocalImageFile(address);
    if (discovered) imageLocal = discovered;
  }

  return { imageUrl, imageLocal };
}

/** Map CSV header (N%) weights → GUI slider keys */
const FINAL_HEADER_KEYS = {
  "Location Score": "location",
  Price: "price",
  Parking: "parking",
  "Includes Basement": "basement",
  Type: "type",
  Baths: "baths",
  Beds: "beds",
  "Sq Ft": "sqft",
};

const LOC_HEADER_KEYS = {
  School: "school",
  MSB: "msb",
  "School/Work Commute": "schoolWork",
  Girls: "girls",
  "Total Drive Time": "totalDrive",
};

function weightFromHeader(header, baseName) {
  const idx = findCol(header, baseName);
  if (idx < 0) return null;
  const { weightPct } = parseHeader(header[idx]);
  return weightPct;
}

function extractWeights(header) {
  const final = {};
  for (const [csvName, key] of Object.entries(FINAL_HEADER_KEYS)) {
    const w = weightFromHeader(header, csvName);
    if (w != null) final[key] = w;
  }
  const location = {};
  for (const [csvName, key] of Object.entries(LOC_HEADER_KEYS)) {
    const w = weightFromHeader(header, csvName);
    if (w != null) location[key] = w;
  }
  return { final, location };
}

function writePayload(listings, weights) {
  const parts = [
    "window.LISTINGS_DATA = " + JSON.stringify(listings, null, 2) + ";",
    "window.WEIGHTS_DATA = " + JSON.stringify(weights, null, 2) + ";",
  ];
  fs.writeFileSync(OUT_JS, parts.join("\n\n") + "\n", "utf8");
}

function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = rows[0];
  const col = (name) => findCol(header, name);
  const existing = loadExistingListings();
  const index = buildImageIndex(existing);

  const listings = [];
  let preserved = 0;
  let missing = 0;

  for (const row of rows.slice(1)) {
    if (!row.some((c) => String(c || "").trim())) continue;
    while (row.length < header.length) row.push("");

    const address = row[col("Address")] || "";
    const listingUrl = (row[col("Listing URL")] || "").trim();
    const photos = resolvePhotos(address, listingUrl, index);

    if (photos.imageUrl || photos.imageLocal) preserved++;
    else missing++;

    listings.push({
      address,
      listingUrl,
      imageUrl: photos.imageUrl,
      imageLocal: photos.imageLocal,
      price: parsePrice(row[col("Price")]),
      beds: parseNumber(row[col("Beds")]),
      baths: parseNumber(row[col("Baths")]),
      sqft: parseNumber(row[col("Sq Ft")]),
      girls: parseMinutes(row[col("Girls")]),
      school: parseMinutes(row[col("School")]),
      work: parseMinutes(row[col("Work")]),
      msb: parseMinutes(row[col("MSB")]),
      schoolWork: parseMinutes(row[col("School/Work Commute")]),
      totalDrive: (() => {
        const stored = parseMinutes(row[col("Total Drive Time")]);
        if (stored != null) return stored;
        const g = parseMinutes(row[col("Girls")]) || 0;
        const s = parseMinutes(row[col("School")]) || 0;
        const w = parseMinutes(row[col("Work")]) || 0;
        const m = parseMinutes(row[col("MSB")]) || 0;
        return g + s + w + m;
      })(),
      locationScore: parseNumber(row[col("Location Score")]),
      parking: row[col("Parking")] || "",
      basement: normalizeBasement(row[col("Includes Basement")]),
      type: normalizeType(row[col("Type")]),
      contact: row[col("Contact")] || "",
      notes: row[col("Notes")] || "",
      compositeScore: parseNumber(row[col("Composite Score")]),
    });
  }

  const weights = extractWeights(header);
  writePayload(listings, weights);

  console.log("Wrote", OUT_JS, "(" + listings.length + " listings)");
  console.log(
    "Photos preserved:",
    preserved + "/" + listings.length +
      (missing ? ` (${missing} need node fetch_images.js)` : "")
  );
  console.log(
    "Weights from CSV — final:",
    Object.entries(weights.final)
      .map(([k, v]) => k + "=" + v + "%")
      .join(", ")
  );
  console.log(
    "Weights from CSV — location:",
    Object.entries(weights.location)
      .map(([k, v]) => k + "=" + v + "%")
      .join(", ")
  );
}

main();
