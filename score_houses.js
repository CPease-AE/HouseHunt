/**
 * Score each house from 1–10 using weights declared in CSV column headers.
 *
 * Edit weights in the header like "School (30%)" or "Price (35%)", then re-run:
 *   node score_houses.js
 *
 * Location sub-weights: Girls, School, MSB, School/Work Commute, Total Drive Time
 * (Work is kept as data only — correlated with School/Work, so not in the mix.)
 * Location Score (1–10) is the weighted commute composite; its final-mix weight
 * lives on the Location Score column header.
 * Total Drive Time = Girls+School+Work+MSB (excludes School/Work Commute).
 * Final factor weights: Location Score, Price, Parking, Includes Basement, Type, Baths, Beds, Sq Ft
 *
 * Continuous factors use absolute Chicago-suburb scales (not shortlist min–max).
 * Price uses a log utility curve. Commute legs use fixed minute brackets.
 *
 * Basement: finished (10), unfinished (7), unknown (2.5), none (0)
 * Type × basement: SF 10/5, Duplex 8.5/2.5, TH 7/0 (with / without basement)
 */
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(
  __dirname,
  "Property Listings Overview - Cameron - Short List.csv"
);

/** Default weights if a header has no (N%) — sum to 100% per mix */
const DEFAULTS = {
  location: {
    School: 30,
    MSB: 30,
    "School/Work Commute": 25,
    Girls: 7.5,
    "Total Drive Time": 7.5,
  },
  final: {
    "Location Score": 35,
    Price: 35,
    Parking: 5,
    "Includes Basement": 5,
    Type: 5,
    Baths: 7.5,
    Beds: 3.75,
    "Sq Ft": 3.75,
  },
};

/** Absolute score anchors (Chicago NW-suburb rental context) */
const SCALES = {
  legBestMin: 15, // single destination: ≤15 → 10
  legWorstMin: 45, // ≥45 → 1
  schoolWorkBestMin: 35,
  schoolWorkWorstMin: 70,
  tdtBestMin: 90, // Total Drive Time (4 directs)
  tdtWorstMin: 170,
  priceBest: 1800, // log utility: $1800 → 10
  priceWorst: 3800, // $3800 → 1
  sqftLow: 1000, // → 1
  sqftHigh: 2200, // → 10
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

function setWeightedHeader(header, baseName, pct) {
  const idx = findCol(header, baseName);
  if (idx < 0) return;
  const { base } = parseHeader(header[idx]);
  header[idx] = pct == null ? base : `${base} (${formatPct(pct)}%)`;
}

function stripWeight(header, baseName) {
  setWeightedHeader(header, baseName, null);
}

function formatPct(n) {
  return Number.isInteger(n) ? String(n) : String(n);
}

function clampScore(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.max(1, Math.min(10, n));
}

/** Lower-is-better absolute linear scale between best/worst anchors */
function scoreLowerAbsolute(value, best, worst) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= best) return 10;
  if (value >= worst) return 1;
  return 10 - (9 * (value - best)) / (worst - best);
}

/** Higher-is-better absolute linear scale */
function scoreHigherAbsolute(value, low, high) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= low) return 1;
  if (value >= high) return 10;
  return 1 + (9 * (value - low)) / (high - low);
}

/** Log price utility: equal $ deltas hurt more at the high end */
function scorePrice(price) {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const lo = SCALES.priceBest;
  const hi = SCALES.priceWorst;
  const t =
    (Math.log(price) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return clampScore(10 - 9 * t);
}

function scoreBeds(beds) {
  if (beds == null) return null;
  if (beds <= 1) return 1;
  if (beds <= 2) return 4;
  if (beds <= 3) return 7;
  if (beds <= 4) return 9;
  return 10;
}

function scoreBaths(baths) {
  if (baths == null) return null;
  if (baths <= 1) return 1;
  if (baths <= 1.5) return 4;
  if (baths <= 2) return 6.5;
  if (baths <= 2.5) return 8.5;
  return 10;
}

function scoreGarage(cars) {
  // >2 (incl. 2.5) or 2+ car → 10; 1 car → 2.5; none → 0
  if (cars == null || !Number.isFinite(cars) || cars <= 0) return 0;
  if (cars >= 2) return 10;
  if (cars >= 1) return 2.5;
  return 0;
}

function formatMinutes(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const minutes = Math.max(0, Math.round(n));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
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

function round1(n) {
  return Math.round(n * 10) / 10;
}

function garageSize(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s || /^(none|no|n\/a|street|driveway|0)$/.test(s)) return 0;
  if (/no\s*garage|without\s*garage|street\s*park/.test(s)) return 0;
  const m = s.match(/([\d.]+)\s*car/i);
  return m ? parseFloat(m[1]) : null;
}

/** Normalize basement cell → finished | unfinished | unknown | none */
function normalizeBasement(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/^(yes|y|finished|fin)$/.test(s)) return "finished";
  if (/^(unfinished|unfin)$/.test(s)) return "unfinished";
  if (/^(unknown|unk|\?)$/.test(s)) return "unknown";
  if (/^(no|n|none|0)$/.test(s)) return "none";
  return "unknown";
}

function basementScore(kind) {
  switch (kind) {
    case "finished":
      return 10;
    case "unfinished":
      return 7;
    case "unknown":
      return 2.5;
    case "none":
      return 0;
    default:
      return 2.5;
  }
}

/** Normalize type cell → single-family | duplex | townhome | unknown */
function normalizeType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/single[\s-]?family|sfh|^sf$|house|detached/.test(s)) return "single-family";
  if (/duplex|two[\s-]?flat|2[\s-]?flat|multi[\s-]?family/.test(s)) return "duplex";
  if (/town\s*-?\s*home|townhouse|^th$|row\s*home/.test(s)) return "townhome";
  return "unknown";
}

/**
 * Type × basement matrix:
 * SF + basement 10 | Duplex + basement 8.5 | TH + basement 7
 * SF + none 5     | Duplex + none 2.5     | TH + none 0
 * finished/unfinished count as basement; none = no basement; unknown = midpoint
 */
function typeScore(typeRaw, basementRaw) {
  const type = normalizeType(typeRaw);
  const basement = normalizeBasement(basementRaw);
  const hasBasement = basement === "finished" || basement === "unfinished";
  const noBasement = basement === "none";

  const withB = { "single-family": 10, duplex: 8.5, townhome: 7 };
  const without = { "single-family": 5, duplex: 2.5, townhome: 0 };

  function forType(t, hasB) {
    const table = hasB ? withB : without;
    if (t in table) return table[t];
    // unknown type → average of known types
    const vals = Object.values(table);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  if (hasBasement) return forType(type, true);
  if (noBasement) return forType(type, false);
  return (forType(type, true) + forType(type, false)) / 2;
}

function typeLabel(raw) {
  const t = normalizeType(raw);
  if (t === "single-family") return "Single Family";
  if (t === "duplex") return "Duplex";
  if (t === "townhome") return "Townhome";
  return "Type unknown";
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

  // Structural: Work is data-only (correlated with School/Work). Location mix
  // uses Total Drive Time instead. Strip any leftover Work (N%).
  stripWeight(header, "Work");
  ensureWeightedHeader(
    header,
    "Total Drive Time",
    DEFAULTS.location["Total Drive Time"]
  );

  // Score output column: Composite Score or Time
  let scoreIdx = findCol(header, "Composite Score");
  if (scoreIdx < 0) scoreIdx = findCol(header, "Time");
  if (scoreIdx < 0) throw new Error("No Composite Score / Time column");

  const addressIdx = findCol(header, "Address");
  const priceIdx = findCol(header, "Price");
  const bedsIdx = findCol(header, "Beds");
  const bathsIdx = findCol(header, "Baths");
  const sqftIdx = findCol(header, "Sq Ft");
  const girlsIdx = findCol(header, "Girls");
  const schoolIdx = findCol(header, "School");
  const workIdx = findCol(header, "Work");
  const msbIdx = findCol(header, "MSB");
  const schoolWorkIdx = findCol(header, "School/Work Commute");
  let totalDriveIdx = findCol(header, "Total Drive Time");
  let locationScoreIdx = findCol(header, "Location Score");

  // Migrate legacy: Location final-mix % used to live on Total Drive Time.
  // If Location Score is missing and TDT has a large weight, move it.
  // Small TDT weights (≤15%) are location-mix sub-weights — leave them.
  if (totalDriveIdx >= 0 && locationScoreIdx < 0) {
    const { weightPct } = parseHeader(header[totalDriveIdx]);
    if (weightPct != null && weightPct > 15) {
      header[totalDriveIdx] = "Total Drive Time";
      header.splice(
        totalDriveIdx + 1,
        0,
        `Location Score (${formatPct(weightPct)}%)`
      );
      locationScoreIdx = totalDriveIdx + 1;
      for (const r of rows.slice(1)) {
        while (r.length < header.length - 1) r.push("");
        r.splice(locationScoreIdx, 0, "");
      }
    }
  }
  // Re-apply TDT location sub-weight after any legacy strip
  ensureWeightedHeader(
    header,
    "Total Drive Time",
    DEFAULTS.location["Total Drive Time"]
  );
  if (locationScoreIdx < 0) {
    const insertAt = totalDriveIdx >= 0 ? totalDriveIdx + 1 : header.length;
    header.splice(insertAt, 0, "Location Score (35%)");
    locationScoreIdx = insertAt;
    for (const r of rows.slice(1)) {
      while (r.length < header.length - 1) r.push("");
      r.splice(locationScoreIdx, 0, "");
    }
  }

  // Re-resolve ALL indices after possible header/row splices
  totalDriveIdx = findCol(header, "Total Drive Time");
  locationScoreIdx = findCol(header, "Location Score");
  const basementIdx = findCol(header, "Includes Basement");
  const typeIdx = findCol(header, "Type");
  const parkingIdx = findCol(header, "Parking");
  const brokerageIdx = findCol(header, "Brokerage Comp");

  // Undo accidental "unknown" written into Brokerage Comp during a prior bad run
  if (brokerageIdx >= 0) {
    for (const r of rows.slice(1)) {
      if (/^(unknown|finished|unfinished|none)$/i.test(String(r[brokerageIdx] || "").trim())) {
        r[brokerageIdx] = "";
      }
    }
  }
  // Location sub-weights (normalize to sum=1). Work is intentionally excluded.
  const locParts = {
    school: weightFor(header, "School", DEFAULTS.location),
    msb: weightFor(header, "MSB", DEFAULTS.location),
    schoolWork: weightFor(header, "School/Work Commute", DEFAULTS.location),
    girls: weightFor(header, "Girls", DEFAULTS.location),
    totalDrive: weightFor(header, "Total Drive Time", DEFAULTS.location),
  };
  const locSum =
    locParts.school +
    locParts.msb +
    locParts.schoolWork +
    locParts.girls +
    locParts.totalDrive;
  if (locSum <= 0) throw new Error("Location weights sum to 0");
  for (const k of Object.keys(locParts)) locParts[k] /= locSum;

  // Final pillar weights — only Location Score carries the location mix weight
  const finalParts = {
    location: weightFor(header, "Location Score", DEFAULTS.final),
    price: weightFor(header, "Price", DEFAULTS.final),
    parking: weightFor(header, "Parking", DEFAULTS.final),
    basement: weightFor(header, "Includes Basement", DEFAULTS.final),
    type: weightFor(header, "Type", DEFAULTS.final),
    baths: weightFor(header, "Baths", DEFAULTS.final),
    beds: weightFor(header, "Beds", DEFAULTS.final),
    sqft: weightFor(header, "Sq Ft", DEFAULTS.final),
  };
  const finalSum =
    finalParts.location +
    finalParts.price +
    finalParts.parking +
    finalParts.basement +
    finalParts.type +
    finalParts.baths +
    finalParts.beds +
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
      beds: parseNumber(r[bedsIdx]),
      baths: parseNumber(r[bathsIdx]),
      sqft: parseNumber(r[sqftIdx]),
      girls: parseMinutes(r[girlsIdx]),
      school: parseMinutes(r[schoolIdx]),
      work: parseMinutes(r[workIdx]),
      msb: parseMinutes(r[msbIdx]),
      schoolWork: parseMinutes(r[schoolWorkIdx]),
      basement: normalizeBasement(r[basementIdx]),
      type: typeIdx >= 0 ? normalizeType(r[typeIdx]) : "unknown",
      garage: parkingIdx >= 0 ? garageSize(r[parkingIdx]) : null,
    };
  });

  // Normalize basement / type labels in the CSV for clarity
  for (const h of houses) {
    h.row[basementIdx] = h.basement;
    if (typeIdx >= 0 && String(h.row[typeIdx] || "").trim()) {
      h.row[typeIdx] =
        h.type === "single-family"
          ? "Single Family"
          : h.type === "duplex"
            ? "Duplex"
            : h.type === "townhome"
              ? "Townhome"
              : h.row[typeIdx];
    }
  }

  const knownSqft = houses.map((h) => h.sqft).filter((v) => v != null);
  const sqftMedian = knownSqft.length ? median(knownSqft) : 1500;
  for (const h of houses) {
    h.sqftFilled = h.sqft != null ? h.sqft : sqftMedian;
    const g = h.girls || 0;
    const s = h.school || 0;
    const w = h.work || 0;
    const m = h.msb || 0;
    h.totalDrive = g + s + w + m;
  }

  // Absolute scales — stable when shortlist changes (no min–max within list)
  const girlsS = houses.map((h) =>
    scoreLowerAbsolute(h.girls, SCALES.legBestMin, SCALES.legWorstMin)
  );
  const schoolS = houses.map((h) =>
    scoreLowerAbsolute(h.school, SCALES.legBestMin, SCALES.legWorstMin)
  );
  const msbS = houses.map((h) =>
    scoreLowerAbsolute(h.msb, SCALES.legBestMin, SCALES.legWorstMin)
  );
  const schoolWorkS = houses.map((h) =>
    scoreLowerAbsolute(
      h.schoolWork,
      SCALES.schoolWorkBestMin,
      SCALES.schoolWorkWorstMin
    )
  );
  const totalDriveS = houses.map((h) =>
    scoreLowerAbsolute(h.totalDrive, SCALES.tdtBestMin, SCALES.tdtWorstMin)
  );
  const priceS = houses.map((h) => scorePrice(h.price));
  const bedsS = houses.map((h) => scoreBeds(h.beds));
  const bathsS = houses.map((h) => scoreBaths(h.baths));
  const sqftS = houses.map((h) =>
    scoreHigherAbsolute(h.sqftFilled, SCALES.sqftLow, SCALES.sqftHigh)
  );
  const basementS = houses.map((h) => basementScore(h.basement));
  const typeS = houses.map((h) => typeScore(h.type, h.basement));
  const garageS = houses.map((h) => scoreGarage(h.garage));

  for (let i = 0; i < houses.length; i++) {
    const location =
      locParts.school * (schoolS[i] ?? 5) +
      locParts.msb * (msbS[i] ?? 5) +
      locParts.schoolWork * (schoolWorkS[i] ?? 5) +
      locParts.girls * (girlsS[i] ?? 5) +
      locParts.totalDrive * (totalDriveS[i] ?? 5);

    const final =
      finalParts.location * location +
      finalParts.price * (priceS[i] ?? 5) +
      finalParts.parking * garageS[i] +
      finalParts.basement * basementS[i] +
      finalParts.type * typeS[i] +
      finalParts.baths * (bathsS[i] ?? 5) +
      finalParts.beds * (bedsS[i] ?? 5) +
      finalParts.sqft * (sqftS[i] ?? 5);

    houses[i].scores = {
      location: round1(location),
      price: round1(priceS[i]),
      basement: basementS[i],
      type: round1(typeS[i]),
      baths: round1(bathsS[i]),
      beds: round1(bedsS[i]),
      sqft: round1(sqftS[i]),
      garage: round1(garageS[i]),
      final: round1(final),
    };
    houses[i].row[scoreIdx] = String(houses[i].scores.final);
    if (locationScoreIdx >= 0) {
      houses[i].row[locationScoreIdx] = String(houses[i].scores.location);
    }
    // Total Drive Time = Girls+School+Work+MSB (excludes School/Work Commute)
    if (totalDriveIdx >= 0) {
      houses[i].row[totalDriveIdx] = formatMinutes(houses[i].totalDrive);
    }
  }

  fs.writeFileSync(CSV_PATH, toCsv([header, ...dataRows]), "utf8");

  const ranked = [...houses].sort((a, b) => b.scores.final - a.scores.final);
  console.log("\nRanked scores (best first):\n");
  console.log(
    "Score | Location | Price | Basement | Beds | Baths | SqFt | Address"
  );
  console.log("-".repeat(100));
  for (const h of ranked) {
    const s = h.scores;
    const short = String(h.address || "").split(",")[0].trim();
    console.log(
      `${s.final.toFixed(1).padStart(5)} | ${String(s.location).padStart(8)} | ${String(s.price).padStart(5)} | ${String(s.basement).padStart(8)} | ${String(s.beds).padStart(4)} | ${String(s.baths).padStart(5)} | ${String(s.sqft).padStart(4)} | ${short}`
    );
  }
  console.log(`\nUpdated ${CSV_PATH}`);
  console.log(
    "Tip: change percentages in the header row, then re-run node score_houses.js"
  );
}

main();
