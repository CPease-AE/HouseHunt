/**
 * Scrape listing page og:image / schema.org image → images/ + listings-data.js
 *
 * Usage:
 *   node fetch_images.js          # only listings missing a local/remote image
 *   node fetch_images.js --all    # re-scrape every listing with a URL
 *
 * Run sync_listings.js first (or after) so listing fields are current.
 * This command does not re-read the CSV for scores/prices — it updates
 * image fields on the existing listings-data.js payload.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const ROOT = __dirname;
const CSV_PATH = path.join(
  ROOT,
  "Property Listings Overview - Cameron - Short List.csv"
);
const OUT_JS = path.join(ROOT, "listings-data.js");
const IMG_DIR = path.join(ROOT, "images");
const FORCE_ALL = process.argv.includes("--all");

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
    console.warn("Warning: could not parse existing listings-data.js:", e.message);
    return [];
  }
}

function writeListings(listings) {
  const payload =
    "window.LISTINGS_DATA = " + JSON.stringify(listings, null, 2) + ";\n";
  fs.writeFileSync(OUT_JS, payload, "utf8");
}

function fetchText(url, redirects = 0, userAgent = null) {
  const ua =
    userAgent ||
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Referer: "https://www.google.com/",
        },
        timeout: 25000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return fetchText(next, redirects + 1, ua).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: url,
          })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

const PAGE_USER_AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

async function fetchListingHtml(listingUrl) {
  let url = listingUrl;
  try {
    const u = new URL(listingUrl);
    u.search = "";
    u.hash = "";
    url = u.toString();
  } catch {
    /* keep original */
  }

  let last = null;
  for (const ua of PAGE_USER_AGENTS) {
    const res = await fetchText(url, 0, ua);
    last = res;
    if (
      res.status === 200 &&
      /og:image|twitter:image|thumbnailUrl/i.test(res.body)
    ) {
      return res;
    }
    if (res.status === 200 && res.body.length > 50000) {
      return res;
    }
    console.log(`    UA retry after HTTP ${res.status} (${ua.slice(0, 28)}…)`);
  }
  return last;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractFeaturedImage(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /"image"\s*:\s*"(https?:[^"]+)"/i,
    /"image"\s*:\s*\[\s*"(https?:[^"]+)"/i,
    /"thumbnailUrl"\s*:\s*"(https?:[^"]+)"/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1]) {
      let img = decodeHtml(m[1].trim());
      if (img.startsWith("//")) img = "https:" + img;
      if (img.startsWith("/")) {
        try {
          img = new URL(img, pageUrl).toString();
        } catch {
          /* ignore */
        }
      }
      if (/^https?:\/\//i.test(img)) return img;
    }
  }
  return null;
}

function slugify(address) {
  return String(address)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function downloadImage(url, destPath, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          Referer: referer || "https://www.zillow.com/",
        },
        timeout: 30000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return downloadImage(next, destPath, referer).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          fs.writeFileSync(destPath, Buffer.concat(chunks));
          resolve(destPath);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function extFromUrl(url) {
  const m = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  if (m) return "." + m[1].toLowerCase().replace("jpeg", "jpg");
  return ".jpg";
}

function hasImage(item) {
  if (item.imageLocal) {
    const localPath = path.join(ROOT, item.imageLocal);
    if (fs.existsSync(localPath)) return true;
  }
  return Boolean(item.imageUrl);
}

async function scrapeListingImage(listingUrl, address) {
  if (!listingUrl || !/^https?:\/\//i.test(listingUrl)) return null;
  console.log("  scraping", listingUrl);
  try {
    const { status, body, finalUrl } = await fetchListingHtml(listingUrl);
    if (status !== 200) {
      console.log("    page HTTP", status);
      return null;
    }
    const imageUrl = extractFeaturedImage(body, finalUrl || listingUrl);
    if (!imageUrl) {
      console.log("    no og/schema image found");
      return null;
    }
    console.log(
      "    image",
      imageUrl.slice(0, 90) + (imageUrl.length > 90 ? "…" : "")
    );

    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
    const ext = extFromUrl(imageUrl);
    const localName = slugify(address) + ext;
    const localPath = path.join(IMG_DIR, localName);
    try {
      await downloadImage(imageUrl, localPath, listingUrl);
      console.log("    saved", localName);
      return { imageUrl, imageLocal: "images/" + localName };
    } catch (e) {
      console.log("    download failed, using remote URL:", e.message);
      return { imageUrl, imageLocal: null };
    }
  } catch (e) {
    console.log("    scrape failed:", e.message);
    return null;
  }
}

/** Build address → listingUrl map from CSV (source of truth for URLs) */
function listingUrlsFromCsv() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = rows[0];
  const addressIdx = findCol(header, "Address");
  const urlIdx = findCol(header, "Listing URL");
  const map = new Map();
  for (const row of rows.slice(1)) {
    if (!row.some((c) => String(c || "").trim())) continue;
    const address = row[addressIdx] || "";
    const listingUrl = String(row[urlIdx] || "").trim();
    if (address) map.set(address, listingUrl);
  }
  return map;
}

async function main() {
  let listings = loadExistingListings();
  if (!listings.length) {
    console.error(
      "No listings-data.js yet. Run: node sync_listings.js\nThen: node fetch_images.js"
    );
    process.exit(1);
  }

  const urlByAddress = listingUrlsFromCsv();
  let scraped = 0;
  let skipped = 0;

  for (const item of listings) {
    const listingUrl =
      (urlByAddress.get(item.address) || item.listingUrl || "").trim();
    item.listingUrl = listingUrl;

    if (!listingUrl) {
      console.log("skip (no URL):", String(item.address || "").split(",")[0]);
      skipped++;
      continue;
    }

    if (!FORCE_ALL && hasImage(item)) {
      console.log(
        "keep:",
        String(item.address || "").split(",")[0],
        "→",
        item.imageLocal || item.imageUrl
      );
      skipped++;
      continue;
    }

    const img = await scrapeListingImage(listingUrl, item.address);
    if (img) {
      item.imageUrl = img.imageUrl;
      item.imageLocal = img.imageLocal;
      scraped++;
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  writeListings(listings);
  console.log(
    `\nUpdated ${OUT_JS} (${scraped} scraped, ${skipped} skipped, ${listings.length} total)`
  );
  console.log(
    FORCE_ALL
      ? "Tip: default mode only fills missing images (omit --all)."
      : "Tip: re-scrape everything with: node fetch_images.js --all"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
