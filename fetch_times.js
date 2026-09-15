/**
 * Fetch Google Maps drive times for houses in Property Listings Overview.
 *
 * Reads each Address, fills Girls / School / Work / MSB / School/Work Commute /
 * Total Drive Time, then writes back to the CSV.
 *
 * Usage:
 *   node fetch_times.js          # only rows missing commute times
 *   node fetch_times.js --all    # refresh every house
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const CSV_PATH = path.join(
  __dirname,
  "Property Listings Overview - Cameron - Short List.csv"
);

const DESTINATIONS = {
  Girls: "112 Old Barrington Rd, North Barrington, IL 60010",
  School: "40 E Dundee Rd, Barrington, IL 60010",
  Work: "2600 South River Rd, Des Plaines, IL",
  MSB: "39 E Main St, Carpentersville, IL 60110",
};

const COMMUTE_COLS = [
  "Girls",
  "School",
  "Work",
  "MSB",
  "School/Work Commute",
  "Total Drive Time",
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "*/*",
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return fetchText(next).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function encodeAddr(s) {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function previewUrl(origin, dest) {
  const pb =
    `!1m2!1s${encodeAddr(origin)}!6e0` +
    `!1m2!1s${encodeAddr(dest)}!6e0`;
  return (
    "https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=us&pb=" +
    pb
  );
}

function extractDrive(body) {
  const traffic = body.match(
    /\[\[(\d+),"([^"]+)"\],null,\d+,\[(\d+),"([^"]+)"\],\[(\d+),(\d+),"([^"]+)"\]/
  );
  if (traffic) {
    return {
      label: traffic[2],
      seconds: parseInt(traffic[1], 10),
    };
  }
  const summary = body.match(
    /\[[\d.]+,"[\d.]+ miles?",1?\],\[(\d+),"([^"]+)"\]/i
  );
  if (summary) {
    return {
      label: summary[2],
      seconds: parseInt(summary[1], 10),
    };
  }
  return null;
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

function formatMinutes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const minutes = Math.max(1, Math.round(n));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function cleanAddress(addr) {
  return String(addr || "")
    .replace(/[\u00a0\u200b\ufffd]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a Maps-friendly origin from a listing address. */
function originForMaps(address) {
  let a = cleanAddress(address);
  // Drop unit markers like "# 742" / "# 0"
  a = a.replace(/#\s*\S+/g, " ").replace(/\s+/g, " ").trim();
  if (!/,\s*IL\b/i.test(a) && !/\bIllinois\b/i.test(a)) {
    // keep as-is; many already include city
  }
  return a;
}

async function fetchDrive(origin, dest, cache) {
  const key = `${origin}||${dest}`;
  if (cache.has(key)) return cache.get(key);

  console.log(`  ${origin} -> ${dest}`);
  let result = null;
  try {
    const { status, body } = await fetchText(previewUrl(origin, dest));
    if (status !== 200) {
      console.log(`    HTTP ${status}`);
    } else {
      const parsed = extractDrive(body);
      if (parsed) {
        result = {
          label: parsed.label,
          minutes: Math.round(parsed.seconds / 60),
        };
        console.log(`    -> ${result.label}`);
      } else {
        console.log("    -> could not parse duration");
      }
    }
  } catch (e) {
    console.log(`    err: ${e.message}`);
  }

  cache.set(key, result);
  await sleep(350);
  return result;
}

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

function toCsv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell ?? "");
            if (/[",\n\r]/.test(s) || s.startsWith("="))
              return `"${s.replace(/"/g, '""')}"`;
            return s;
          })
          .join(",")
      )
      .join("\r\n") + "\r\n"
  );
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

function needsCommute(row, idxs) {
  return COMMUTE_COLS.some((name) => {
    const i = idxs[name];
    if (i < 0) return true;
    return !String(row[i] || "").trim();
  });
}

async function main() {
  const refreshAll = process.argv.includes("--all");
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  if (!rows.length) throw new Error("empty csv");

  const header = rows[0];
  const addressIdx = findCol(header, "Address");
  if (addressIdx < 0) throw new Error("Address column not found");

  const idxs = {};
  for (const name of COMMUTE_COLS) {
    idxs[name] = findCol(header, name);
    if (idxs[name] < 0) throw new Error(`Missing column: ${name}`);
  }

  const cache = new Map();
  let updated = 0;
  let skipped = 0;

  // Shared School -> Work leg
  let schoolToWork = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    while (row.length < header.length) row.push("");
    if (!row.some((c) => String(c || "").trim())) continue;

    const address = cleanAddress(row[addressIdx]);
    if (!address) continue;

    if (!refreshAll && !needsCommute(row, idxs)) {
      skipped++;
      continue;
    }

    console.log(`\nHouse: ${address}`);
    const origin = originForMaps(address);

    const girls = await fetchDrive(origin, DESTINATIONS.Girls, cache);
    const school = await fetchDrive(origin, DESTINATIONS.School, cache);
    const work = await fetchDrive(origin, DESTINATIONS.Work, cache);
    const msb = await fetchDrive(origin, DESTINATIONS.MSB, cache);

    if (!schoolToWork) {
      schoolToWork = await fetchDrive(
        DESTINATIONS.School,
        DESTINATIONS.Work,
        cache
      );
    }

    const girlsMin = girls?.minutes ?? parseMinutes(girls?.label);
    const schoolMin = school?.minutes ?? parseMinutes(school?.label);
    const workMin = work?.minutes ?? parseMinutes(work?.label);
    const msbMin = msb?.minutes ?? parseMinutes(msb?.label);
    const leg2Min =
      schoolToWork?.minutes ?? parseMinutes(schoolToWork?.label) ?? 0;

    const schoolWorkMin =
      (schoolMin != null ? schoolMin : 0) + (leg2Min || 0);
    const totalMin =
      (girlsMin || 0) +
      (schoolMin || 0) +
      (workMin || 0) +
      (msbMin || 0) +
      schoolWorkMin;

    row[idxs.Girls] = girls?.label || formatMinutes(girlsMin) || "";
    row[idxs.School] = school?.label || formatMinutes(schoolMin) || "";
    row[idxs.Work] = work?.label || formatMinutes(workMin) || "";
    row[idxs.MSB] = msb?.label || formatMinutes(msbMin) || "";
    row[idxs["School/Work Commute"]] = formatMinutes(schoolWorkMin);
    row[idxs["Total Drive Time"]] = formatMinutes(totalMin);

    // Clean address cell encoding glitches while we're here
    row[addressIdx] = address;

    console.log(
      `  School/Work ${formatMinutes(schoolWorkMin)} | Total ${formatMinutes(totalMin)}`
    );
    updated++;
  }

  fs.writeFileSync(CSV_PATH, toCsv(rows), "utf8");
  console.log(`\nUpdated ${CSV_PATH}`);
  console.log(`Houses updated: ${updated} | skipped (already filled): ${skipped}`);
  console.log("Next: node score_houses.js && node sync_listings.js");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
