/**
 * Fetch current Google Maps drive times and rewrite CSV so each Maps URL cell
 * is an Excel HYPERLINK with the commute time as the visible link text.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const CSV_PATH = path.join(__dirname, "House,Destination.csv");

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

function parseOriginDest(url) {
  const m = url.match(/\/maps\/dir\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  return {
    origin: decodeURIComponent(m[1].replace(/\+/g, " ")),
    dest: decodeURIComponent(m[2].replace(/\+/g, " ")),
  };
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

/**
 * Prefer current traffic duration from Google's directions payload.
 * Falls back to primary route summary duration text.
 */
function extractDriveLabel(body) {
  const traffic = body.match(
    /\[\[(\d+),"([^"]+)"\],null,\d+,\[(\d+),"([^"]+)"\],\[(\d+),(\d+),"([^"]+)"\]/
  );
  if (traffic) {
    return {
      label: traffic[2],
      seconds: parseInt(traffic[1], 10),
      typical: traffic[4],
      range: traffic[7],
    };
  }

  const summary = body.match(/\[[\d.]+,"[\d.]+ miles?",1?\],\[(\d+),"([^"]+)"\]/i);
  if (summary) {
    return {
      label: summary[2],
      seconds: parseInt(summary[1], 10),
    };
  }

  // Last resort: first reasonable "N min" / "N hr M min"
  const hrMin = body.match(/(\d+)\s*hr(?:s)?\s*(\d+)\s*min/i);
  if (hrMin) return { label: `${hrMin[1]} hr ${hrMin[2]} min` };

  const mins = [...body.matchAll(/\b(\d{1,3})\s*mins?\b/gi)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => n >= 3 && n <= 240);
  if (mins.length) return { label: `${mins[0]} min` };

  return null;
}

async function getDriveLabel(url, cache) {
  if (cache.has(url)) return cache.get(url);

  const pair = parseOriginDest(url);
  if (!pair) {
    cache.set(url, null);
    return null;
  }

  console.log(`Fetching: ${pair.origin} -> ${pair.dest}`);
  let label = null;
  try {
    const { status, body } = await fetchText(previewUrl(pair.origin, pair.dest));
    if (status !== 200) {
      console.log(`  HTTP ${status}`);
    } else {
      const parsed = extractDriveLabel(body);
      if (parsed) {
        label = parsed.label;
        const extra = parsed.range ? ` (typical ${parsed.typical}, range ${parsed.range})` : "";
        console.log(`  -> ${label}${extra}`);
      } else {
        console.log("  -> could not parse duration");
      }
    }
  } catch (e) {
    console.log(`  err: ${e.message}`);
  }

  cache.set(url, label);
  await sleep(350);
  return label;
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
    } else if (c === "\r") {
      // skip
    } else {
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
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(",")
    )
    .join("\r\n");
}

function extractUrl(cell) {
  const s = (cell || "").trim();
  if (!s) return "";
  const m = s.match(/HYPERLINK\("([^"]+)"/i);
  if (m) return m[1];
  if (s.startsWith("http")) return s;
  return "";
}

function makeHyperlink(url, text) {
  return `=HYPERLINK("${url.replace(/"/g, '""')}","${text.replace(/"/g, '""')}")`;
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error("empty csv");

  const header = rows[0];
  const urlCols = header
    .map((name, i) => (/URL|MAPS/i.test(name) ? i : -1))
    .filter((i) => i >= 0);
  console.log("URL columns:", urlCols.map((i) => header[i]).join(", "));

  const cache = new Map();
  const out = [header];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r].slice();
    while (row.length < header.length) row.push("");
    if (!row.some((c) => String(c).trim())) {
      out.push(row.slice(0, header.length));
      continue;
    }
    const newRow = row.slice(0, header.length);
    for (const i of urlCols) {
      const url = extractUrl(newRow[i]);
      if (!url) continue;
      const label = (await getDriveLabel(url, cache)) || "time N/A";
      newRow[i] = makeHyperlink(url, label);
    }
    out.push(newRow);
  }

  fs.writeFileSync(CSV_PATH, toCsv(out) + "\r\n", "utf8");
  console.log(`\nUpdated ${CSV_PATH}`);
  console.log(`Unique routes: ${cache.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
