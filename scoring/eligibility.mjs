// SOURCE-AWARE geographic eligibility:
// - LinkedIn = STRICT: "remote" is assumed tied to the location's country, unless explicit openness
//   (worldwide/anywhere/Latin America/Americas/Peru).
// - Remote-first boards (remotive, remoteok, weworkremotely, jobicy, workingnomads, himalayas,
//   arbeitnow, torre) = LAX: eligible by default, unless an explicit hard restriction.
// - US (any source): must EXPLICITLY say it accepts LATAM/Peru, otherwise → not eligible.
// - Onsite/hybrid (any source) → not eligible (the candidate wants fully remote).
// - Peru + foreign company → eligible.
// classify(location, rawText, source) -> { region, eligibleForPeru, evidence }

const lc = (s) => (s || "").toLowerCase();
// STRICT = the location ties the posting to its country unless explicit openness.
// LinkedIn + company career pages (ATS: greenhouse/ashby/lever): a "United States"
// in the location IS a US job. Geo is PER-POSTING (company is not blocked: the same
// employer may have a worldwide role that step 3 will let through).
const STRICT_SOURCES = new Set(["linkedin", "greenhouse", "ashby", "lever"]);

const RX = {
  worldwide: /\b(work from anywhere|from anywhere|anywhere in the world|fully remote.{0,25}(worldwide|global)|worldwide|globally|global remote|any country|en todo el mundo|cualquier (país|lugar))\b/i,
  latamOpen: /\b(latam|latin america|latinoam[eé]rica|am[eé]rica latina|south america|sudam[eé]rica|the americas|américas|anywhere in (latam|latin america))\b/i,
  peru: /\b(per[uú]|lima)\b/i,
  usOnly: /\b(u\.?s\.?\s?only|us-only|united states only|must (be|reside|live).{0,30}(united states|u\.?s\.?a?\b)|authorized to work in the (us|united states)|us work authorization|w-?2|e-?verify|us (citizen|geographic))\b/i,
  euOnly: /\b(eu[-\s]?only|european union only|must (be|reside|live).{0,30}(europe|eu\b|eea)|within the eu\b|eu work (permit|authorization))\b/i,
  ukOnly: /\b(uk[-\s]?only|united kingdom only|must (be|reside|live).{0,30}(uk|united kingdom)|right to work in the uk)\b/i,
  onsite: /\b(on-?site|in-office|in the office|hybrid|h[ií]brido|presencial|\d+\s?(days?|d[ií]as?)\s?(a|per|por)\s?(week|semana)|relocate)\b/i,
  remoteFull: /\b(fully remote|100% remote|remote-first|remoto total|distributed team|trabajo remoto)\b/i,
};

const AMERICAS = ["peru", "perú", "mexico", "méxico", "argentina", "brazil", "brasil", "chile", "colombia",
  "uruguay", "ecuador", "bolivia", "paraguay", "venezuela", "costa rica", "guatemala", "panama", "panamá", "dominican"];
const US_NAMES = ["united states", "usa", "u.s.", "u.s.a"];
const COUNTRIES = [...AMERICAS, ...US_NAMES, "canada", "canadá", "india", "pakistan", "pakistán", "philippines",
  "filipinas", "germany", "alemania", "spain", "españa", "portugal", "france", "francia", "poland", "polonia",
  "ukraine", "ucrania", "romania", "netherlands", "ireland", "irlanda", "united kingdom", "uk", "england",
  "inglaterra", "australia", "singapore", "singapur", "nigeria", "kenya", "egypt", "indonesia", "vietnam",
  "bangladesh", "turkey", "turquía", "cyprus", "chipre", "israel", "jordan", "jordania", "saudi", "arabia",
  "china", "japan", "japón", "korea", "italy", "italia", "sweden", "switzerland", "suiza", "austria", "belgium"];
const CITY_COUNTRY = {
  "san francisco": "united states", "new york": "united states", "los angeles": "united states", "seattle": "united states",
  "austin": "united states", "boston": "united states", "chicago": "united states", "bay area": "united states",
  "silicon valley": "united states", "palo alto": "united states", "mountain view": "united states", "madison": "united states",
  "el segundo": "united states", "london": "united kingdom", "manchester": "united kingdom", "frankfurt": "germany",
  "berlin": "germany", "munich": "germany", "münchen": "germany", "nuremberg": "germany", "núremberg": "germany",
  "cologne": "germany", "köln": "germany", "paris": "france", "aix-en-provence": "france", "madrid": "spain",
  "barcelona": "spain", "lisbon": "portugal", "lisboa": "portugal", "amsterdam": "netherlands", "dublin": "ireland", "tel aviv": "israel",
};
const US_STATE = /,\s?(ca|ny|tx|wa|ma|il|wi|co|fl|ga|nc|va|az|or|pa|nj|mn|oh|mi|dc)\b/;
// Full US state names (e.g. "Remote - California", "New York") — abbreviations alone miss these.
const US_STATE_NAMES = /\b(california|texas|florida|new york|massachusetts|illinois|washington d\.?c\.?|washington state|colorado|virginia|arizona|oregon|pennsylvania|new jersey|minnesota|north carolina|tennessee|utah|maryland|d\.?c\.?)\b/;

const mk = (region, eligibleForPeru, evidence) => ({ region, eligibleForPeru, evidence });
const findIn = (hay, list) => list.find((c) => hay.includes(c));

function detectCountry(loc) {
  let c = findIn(loc, COUNTRIES) || Object.keys(CITY_COUNTRY).find((x) => loc.includes(x));
  if (c && CITY_COUNTRY[c]) c = CITY_COUNTRY[c];
  if (!c && (US_STATE.test(loc) || US_STATE_NAMES.test(loc))) c = "united states";
  return c || null;
}

export function classify(location = "", rawText = "", source = "linkedin") {
  const loc = lc(location);
  const hay = lc(`${location}\n${rawText}`);
  const strict = STRICT_SOURCES.has(source);

  // 0) "X Only" in the region field (boards: Remotive/WWR/Jobicy often say "USA Only", "Europe Only").
  const onlyM = loc.match(/\b(usa?|u\.s\.a?|north america|europe|emea|eu|uk|united kingdom|canada|india|apac|australia)\s*[-\s]?only\b/i);
  if (onlyM && !/latin|americas|latam|peru/i.test(hay)) return mk("restricted", false, `restricted region: "${onlyM[0]}"`);

  // 1) Explicit hard restrictions (any source).
  if (RX.usOnly.test(hay)) return mk("us_only", false, "explicit US restriction");
  if (RX.euOnly.test(hay)) return mk("eu_only", false, "explicit EU restriction");
  if (RX.ukOnly.test(hay)) return mk("uk_only", false, "explicit UK restriction");

  // 2) Onsite/hybrid without fully remote (any source) → not useful.
  if (RX.onsite.test(hay) && !RX.remoteFull.test(hay)) return mk("restricted", false, "onsite/hybrid — not fully remote");

  // 3) Explicit openness to the candidate's REGION — Peru/LATAM are specific signals, honored anywhere.
  if (RX.peru.test(loc) || RX.peru.test(hay)) return mk("latam_ok", true, "mentions Peru/Lima (verify non-Peruvian company)");
  if (RX.latamOpen.test(hay)) return mk("latam_ok", true, "explicit LATAM/Americas openness");

  const country = detectCountry(loc) || (strict ? detectCountry(lc(rawText).slice(0, 300)) : null);

  // 4) STRICT sources: a country in the LOCATION field is authoritative and OVERRIDES body "worldwide/global"
  //    boilerplate. A "San Francisco" role whose blurb says "global leader / customers worldwide" is US-only,
  //    NOT worldwide. Checked BEFORE the worldwide signal below — this is the fix for the ~895 mislabeled jobs.
  if (strict) {
    if (country && US_NAMES.includes(country)) return mk("us_only", false, `US location (${location}); body "worldwide" is boilerplate, not openness`);
    if (country && !["peru", "perú"].includes(country)) return mk(`country:${country}`, false, `location ${country}, no explicit LATAM/Peru openness`);
  }

  // 5) Worldwide/anywhere openness — reached only when no specific country pins the posting.
  if (RX.worldwide.test(hay)) return mk("worldwide", true, "explicit worldwide/anywhere remote");

  // 6) STRICT remote with no detectable country and no openness → eligible but verify.
  if (strict) return mk("unknown", true, "remote with no country or openness — verify");

  // 7) LAX remote-first boards: no hard restriction and not onsite → eligible by default.
  return mk(country ? `remote:${country}` : "remote", true, `remote-first board (${source}) — no hard restriction`);
}

export function badge(region) {
  if (!region) return "❓";
  if (region.startsWith("country:")) return `⛔ ${region.split(":")[1]}`;
  if (region.startsWith("remote:")) return `✅ Remoto (${region.split(":")[1]})`;
  return ({ worldwide: "✅ Worldwide", latam_ok: "✅ LATAM", americas: "✅ Americas", remote: "✅ Remote",
    unknown: "❓ Uncertain", us_only: "⛔ US-only", eu_only: "⛔ EU-only", uk_only: "⛔ UK-only", restricted: "⛔ Onsite/Restricted",
    "no-aplica": "🚫 Not applicable" })[region] || "❓";
}
