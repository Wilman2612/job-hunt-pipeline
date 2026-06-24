// Elegibilidad geográfica SOURCE-AWARE (feedback de the candidate, jun 2026):
// - LinkedIn = ESTRICTO: "remoto" se asume atado al país de la ubicación, salvo apertura explícita
//   (worldwide/anywhere/Latin America/Americas/Perú).
// - Boards remote-first (remotive, remoteok, weworkremotely, jobicy, workingnomads, himalayas,
//   arbeitnow, torre) = LAXO: elegible por defecto, salvo restricción dura explícita.
// - US (cualquier fuente): debe decir EXPLÍCITO que acepta LATAM/Perú, si no → no elegible.
// - Onsite/híbrido (cualquier fuente) → no elegible (the candidate quiere remoto pleno).
// - Perú + empresa extranjera → elegible.
// classify(location, rawText, source) -> { region, eligibleForPeru, evidence }

const lc = (s) => (s || "").toLowerCase();
// ESTRICTO = la ubicación ata la oferta a su país salvo apertura explícita.
// LinkedIn + páginas de carrera de empresa (ATS: greenhouse/ashby/lever): un "United States"
// en el location ES un trabajo US. Geo POR-ANUNCIO (no se bloquea la empresa: un mismo
// empleador puede tener un rol worldwide que el paso 3 sí deja pasar).
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

const mk = (region, eligibleForPeru, evidence) => ({ region, eligibleForPeru, evidence });
const findIn = (hay, list) => list.find((c) => hay.includes(c));

function detectCountry(loc) {
  let c = findIn(loc, COUNTRIES) || Object.keys(CITY_COUNTRY).find((x) => loc.includes(x));
  if (c && CITY_COUNTRY[c]) c = CITY_COUNTRY[c];
  if (!c && US_STATE.test(loc)) c = "united states";
  return c || null;
}

export function classify(location = "", rawText = "", source = "linkedin") {
  const loc = lc(location);
  const hay = lc(`${location}\n${rawText}`);
  const strict = STRICT_SOURCES.has(source);

  // 0) "X Only" en el campo de región (boards: Remotive/WWR/Jobicy suelen decir "USA Only", "Europe Only").
  const onlyM = loc.match(/\b(usa?|u\.s\.a?|north america|europe|emea|eu|uk|united kingdom|canada|india|apac|australia)\s*[-\s]?only\b/i);
  if (onlyM && !/latin|americas|latam|peru/i.test(hay)) return mk("restricted", false, `región restringida: "${onlyM[0]}"`);

  // 1) Restricciones duras explícitas (cualquier fuente).
  if (RX.usOnly.test(hay)) return mk("us_only", false, "restricción US explícita");
  if (RX.euOnly.test(hay)) return mk("eu_only", false, "restricción EU explícita");
  if (RX.ukOnly.test(hay)) return mk("uk_only", false, "restricción UK explícita");

  // 2) Onsite/híbrido sin remoto pleno (cualquier fuente) → no sirve.
  if (RX.onsite.test(hay) && !RX.remoteFull.test(hay)) return mk("restricted", false, "onsite/híbrido — no remoto pleno");

  // 3) Apertura explícita a la región de the candidate (cualquier fuente).
  if (RX.peru.test(loc) || RX.peru.test(hay)) return mk("latam_ok", true, "menciona Perú/Lima (verificar empresa no-peruana)");
  if (RX.latamOpen.test(hay)) return mk("latam_ok", true, "apertura LATAM/Américas explícita");
  if (RX.worldwide.test(hay)) return mk("worldwide", true, "remoto worldwide/anywhere explícito");

  const country = detectCountry(loc) || (strict ? detectCountry(lc(rawText).slice(0, 300)) : null);

  // 4) LinkedIn ESTRICTO (incluye la regla US): la ubicación ata la oferta a su país,
  //    salvo apertura explícita (ya verificada arriba).
  if (strict) {
    if (country && US_NAMES.includes(country)) return mk("us_only", false, "LinkedIn: ubicación US sin apertura LATAM explícita");
    if (country && !["peru", "perú"].includes(country)) return mk(`country:${country}`, false, `LinkedIn: ubicación ${country}, sin apertura explícita`);
    return mk("unknown", true, "LinkedIn remoto sin país ni apertura — verificar");
  }

  // 5) Boards remote-first LAXOS: cada fuente trae su propio campo de ubicación/región.
  //    Sin restricción dura explícita (paso 1) ni onsite → elegible por defecto.
  return mk(country ? `remote:${country}` : "remote", true, `board remote-first (${source}) — sin restricción dura`);
}

export function badge(region) {
  if (!region) return "❓";
  if (region.startsWith("country:")) return `⛔ ${region.split(":")[1]}`;
  if (region.startsWith("remote:")) return `✅ Remoto (${region.split(":")[1]})`;
  return ({ worldwide: "✅ Worldwide", latam_ok: "✅ LATAM", americas: "✅ Américas", remote: "✅ Remoto",
    unknown: "❓ Incierto", us_only: "⛔ US-only", eu_only: "⛔ EU-only", uk_only: "⛔ UK-only", restricted: "⛔ Onsite/Restringido",
    "no-aplica": "🚫 No aplicable" })[region] || "❓";
}
