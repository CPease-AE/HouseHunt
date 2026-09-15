/**
 * Score each house from 1–10 using weights declared in CSV column headers.
 *
 * Edit weights in the header like "School (30%)" or "Price (35%)", then re-run:
 *   node score_houses.js
 *
 * Location sub-weights live on: Girls, School, Work, MSB, School/Work Commute
 * Location's share of the final score lives on: Total Drive Time
 * Final factor weights live on: Price, Parking, Includes Basement, Baths, Sq Ft
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(
  __dirname,
  "Property Listings Overview - Cameron - Short List.csv"
);

/** Default weights if a header has no (N%) — matches original plan */
const DEFAULTS = {
  location: {
    School: 30,
    MSB: 30,
    "School/Work Commute": 25,
    Girls: 7.5,
    Work: 7.5,
  },
  final: {
    "Total Drive Time": 35, // Location pillar
    Price: 35,
    Parking: 0,
    "Includes Basement": 15,
    Baths: 7.5,
    "Sq Ft": 7.5,
  },
};

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

/** "School (30%)" → { base: "School", weightPct: 30 } */
function parseHeader(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*%\)\s*$/i);
  if (m) return { base: m[1].trim(), weightPct: parseFloat(m[2]) };
  return { base: s, weightPct: null };
}

function findCol(header, baseName) {
  const target = baseName.toLowerCase();
  for (let i = 0; i < header.length; i++) {
    const { base } = parseHeader(header[i]);
    if (base.toLowerCase() === target) return i;
  }
  // Also accept legacy "Time" / "Composite Score" for score output
  return -1;
}

function weightFor(header, baseName, defaultsMap) {
  const idx = findCol(header, baseName);
  if (idx < 0) {
    if (baseName in defaultsMap) return defaultsMap[baseName] / 100;
    return 0;
  }
  const { weightPct } = parseHeader(header[idx]);
  if (weightPct != null) return weightPct / 100;
  if (baseName in defaultsMap) return defaultsMap[baseName] / 100;
  return 0;
}

function ensureWeightedHeader(header, baseName, defaultPct) {
  const idx = findCol(header, baseName);
  if (idx < 0) return;
  const { base, weightPct } = parseHeader(header[idx]);
  if (weightPct == null) {
    header[idx] = `${base} (${formatPct(defaultPct)}%)`;
  }
}

function formatPct(n) {
  return Number.isInteger(n) ? String(n) : String(n);
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

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function scoreLowerBetter(values) {
  const known = values.filter((v) => v != null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return values.map((v) => {
    if (v == null) return null;
    if (max === min) return 10;
    return 10 - (9 * (v - min)) / (max - min);
  });
}

function scoreHigherBetter(values) {
  const known = values.filter((v) => v != null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return values.map((v) => {
    if (v == null) return null;
    if (max === min) return 10;
    return 1 + (9 * (v - min)) / (max - min);
  });
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function garageSize(text) {
  const m = String(text || "").match(/([\d.]+)\s*car/i);
  return m ? parseFloat(m[1]) : null;
}

function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = rows[0];

  // Ensure weighted headings exist (write them back so the CSV is editable)
  for (const [base, pct] of Object.entries(DEFAULTS.location)) {
    ensureWeightedHeader(header, base, pct);
  }
  for (const [base, pct] of Object.entries(DEFAULTS.final)) {
    ensureWeightedHeader(header, base, pct);
  }

  // Score output column: Composite Score or Time
  let scoreIdx = findCol(header, "Composite Score");
  if (scoreIdx < 0) scoreIdx = findCol(header, "Time");
  if (scoreIdx < 0) throw new Error("No Composite Score / Time column");

  const addressIdx = findCol(header, "Address");
  const priceIdx = findCol(header, "Price");
  const bathsIdx = findCol(header, "Baths");
  const sqftIdx = findCol(header, "Sq Ft");
  const girlsIdx = findCol(header, "Girls");
  const schoolIdx = findCol(header, "School");
  const workIdx = findCol(header, "Work");
  const msbIdx = findCol(header, "MSB");
  const schoolWorkIdx = findCol(header, "School/Work Commute");
  const basementIdx = findCol(header, "Includes Basement");
  const parkingIdx = findCol(header, "Parking");

  // Location sub-weights (normalize to sum=1)
  const locParts = {
    school: weightFor(header, "School", DEFAULTS.location),
    msb: weightFor(header, "MSB", DEFAULTS.location),
    schoolWork: weightFor(header, "School/Work Commute", DEFAULTS.location),
    girls: weightFor(header, "Girls", DEFAULTS.location),
    work: weightFor(header, "Work", DEFAULTS.location),
  };
  const locSum =
    locParts.school +
    locParts.msb +
    locParts.schoolWork +
    locParts.girls +
    locParts.work;
  if (locSum <= 0) throw new Error("Location weights sum to 0");
  for (const k of Object.keys(locParts)) locParts[k] /= locSum;

  // Final pillar weights
  const finalParts = {
    location: weightFor(header, "Total Drive Time", DEFAULTS.final),
    price: weightFor(header, "Price", DEFAULTS.final),
    parking: weightFor(header, "Parking", DEFAULTS.final),
    basement: weightFor(header, "Includes Basement", DEFAULTS.final),
    baths: weightFor(header, "Baths", DEFAULTS.final),
    sqft: weightFor(header, "Sq Ft", DEFAULTS.final),
  };
  const finalSum =
    finalParts.location +
    finalParts.price +
    finalParts.parking +
    finalParts.basement +
    finalParts.baths +
    finalParts.sqft;
  if (finalSum <= 0) throw new Error("Final weights sum to 0");
  for (const k of Object.keys(finalParts)) finalParts[k] /= finalSum;

  console.log("Location weights (normalized):", Object.fromEntries(
    Object.entries(locParts).map(([k, v]) => [k, round1(v * 100) + "%"])
  ));
  console.log("Final weights (normalized):", Object.fromEntries(
    Object.entries(finalParts).map(([k, v]) => [k, round1(v * 100) + "%"])
  ));

  const dataRows = rows.slice(1).filter((r) =>
    r.some((c) => String(c || "").trim())
  );

  const houses = dataRows.map((r) => {
    while (r.length < header.length) r.push("");
    return {
      row: r,
      address: r[addressIdx],
      price: parsePrice(r[priceIdx]),
      baths: parseNumber(r[bathsIdx]),
      sqft: parseNumber(r[sqftIdx]),
      girls: parseMinutes(r[girlsIdx]),
      school: parseMinutes(r[schoolIdx]),
      work: parseMinutes(r[workIdx]),
      msb: parseMinutes(r[msbIdx]),
      schoolWork: parseMinutes(r[schoolWorkIdx]),
      basement: /^yes$/i.test(String(r[basementIdx] || "").trim()),
      garage: parkingIdx >= 0 ? garageSize(r[parkingIdx]) : null,
    };
  });

  const knownSqft = houses.map((h) => h.sqft).filter((v) => v != null);
  const sqftMedian = knownSqft.length ? median(knownSqft) : 0;
  for (const h of houses) {
    h.sqftFilled = h.sqft != null ? h.sqft : sqftMedian;
  }

  const girlsS = scoreLowerBetter(houses.map((h) => h.girls));
  const schoolS = scoreLowerBetter(houses.map((h) => h.school));
  const workS = scoreLowerBetter(houses.map((h) => h.work));
  const msbS = scoreLowerBetter(houses.map((h) => h.msb));
  const schoolWorkS = scoreLowerBetter(houses.map((h) => h.schoolWork));
  const priceS = scoreLowerBetter(houses.map((h) => h.price));
  const bathsS = scoreHigherBetter(houses.map((h) => h.baths));
  const sqftS = scoreHigherBetter(houses.map((h) => h.sqftFilled));
  const basementS = houses.map((h) => (h.basement ? 10 : 1));
  // Garage: higher car count better; if all null/equal, score 10
  const garageVals = houses.map((h) => h.garage);
  const garageS =
    garageVals.every((v) => v == null)
      ? houses.map(() => 10)
      : scoreHigherBetter(garageVals.map((v) => (v == null ? 0 : v)));

  for (let i = 0; i < houses.length; i++) {
    const location =
      locParts.school * schoolS[i] +
      locParts.msb * msbS[i] +
      locParts.schoolWork * schoolWorkS[i] +
      locParts.girls * girlsS[i] +
      locParts.work * workS[i];

    const final =
      finalParts.location * location +
      finalParts.price * priceS[i] +
      finalParts.parking * garageS[i] +
      finalParts.basement * basementS[i] +
      finalParts.baths * bathsS[i] +
      finalParts.sqft * sqftS[i];

    houses[i].scores = {
      location: round1(location),
      price: round1(priceS[i]),
      basement: basementS[i],
      baths: round1(bathsS[i]),
      sqft: round1(sqftS[i]),
      garage: round1(garageS[i]),
      final: round1(final),
    };
    houses[i].row[scoreIdx] = String(houses[i].scores.final);
  }

  fs.writeFileSync(CSV_PATH, toCsv([header, ...dataRows]), "utf8");

  const ranked = [...houses].sort((a, b) => b.scores.final - a.scores.final);
  console.log("\nRanked scores (best first):\n");
  console.log(
    "Score | Location | Price | Basement | Baths | SqFt | Address"
  );
  console.log("-".repeat(90));
  for (const h of ranked) {
    const s = h.scores;
    const short = String(h.address || "").split(",")[0].trim();
    console.log(
      `${s.final.toFixed(1).padStart(5)} | ${String(s.location).padStart(8)} | ${String(s.price).padStart(5)} | ${String(s.basement).padStart(8)} | ${String(s.baths).padStart(5)} | ${String(s.sqft).padStart(4)} | ${short}`
    );
  }
  console.log(`\nUpdated ${CSV_PATH}`);
  console.log(
    "Tip: change percentages in the header row, then re-run node score_houses.js"
  );
}

main();
