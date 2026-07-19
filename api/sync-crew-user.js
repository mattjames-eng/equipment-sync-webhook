// /api/sync-crew-user.js
// Syncs the monday.com User from Crew Database to the assignee column
// on Crew Assignments and Crew Contracts when a crew member is linked.
//
// Routes:
//   ?route=assignments   →  triggers on Crew Assignments "Crew Member" relation
//   ?route=contracts     →  triggers on Crew Contracts "Tech/Engineer" relation
//   ?route=parse-travel  →  AI-parses raw booking confirmation text → structured fields
//                           (called via rewrite: POST /api/travel/parse)

const MONDAY_API_URL = 'https://api.monday.com/v2';

const CREW_DB_BOARD_ID = '18415879010';
const USER_COLUMN_ID   = 'multiple_person_mm4m4jvs'; // "User" column in Crew Database

const ROUTE_CONFIG = {
  assignments: {
    targetBoardId:  '18415879040',
    targetColumnId: 'multiple_person_mm3yfksh', // "Crew Log In"
  },
  contracts: {
    targetBoardId:  '18415879229',
    targetColumnId: 'multiple_person_mm4me99f',  // "Crew User" (new column)
  },
};

async function mondayQuery(apiKey, query) {
  const res = await fetch(MONDAY_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': apiKey,
      'API-Version':   '2024-01',
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const route = req.query.route;

  // ── Special route: AI travel confirmation parser ─────────────────────────
  if (route === 'parse-travel') {
    return handleParseTravel(req, res);
  }

  // ── Standard crew-user sync routes ───────────────────────────────────────
  const cfg = ROUTE_CONFIG[route];

  if (!cfg) {
    return res.status(400).json({ error: `Unknown route: ${route}` });
  }

  const { event } = req.body;
  if (!event || !event.pulseId) {
    return res.status(400).json({ error: 'Missing event payload' });
  }

  const triggeredItemId = event.pulseId;
  const apiKey = process.env.MONDAY_API_KEY;

  // ── 1. Get linked crew member item ID from the relation column value ─────
  const linkedIds = event?.value?.linkedPulseIds ?? [];

  if (linkedIds.length === 0) {
    // Crew member was cleared — clear the user column too
    await clearPeopleColumn(apiKey, cfg.targetBoardId, triggeredItemId, cfg.targetColumnId);
    return res.status(200).json({ success: true, action: 'cleared' });
  }

  const crewMemberItemId = linkedIds[0].linkedPulseId;

  // ── 2. Fetch the User column from Crew Database ──────────────────────────
  const fetchQuery = `
    query {
      items(ids: [${crewMemberItemId}]) {
        column_values(ids: ["${USER_COLUMN_ID}"]) {
          value
        }
      }
    }
  `;

  const fetchResult = await mondayQuery(apiKey, fetchQuery);
  const items = fetchResult?.data?.items ?? [];

  if (items.length === 0) {
    return res.status(404).json({ error: 'Crew member item not found in Crew Database' });
  }

  const rawValue = items[0].column_values[0]?.value;

  if (!rawValue) {
    // No monday user linked yet — skip silently (crew member not onboarded)
    return res.status(200).json({ success: true, action: 'skipped_no_user' });
  }

  const parsed = JSON.parse(rawValue);
  const personsAndTeams = parsed?.personsAndTeams ?? [];

  if (personsAndTeams.length === 0) {
    return res.status(200).json({ success: true, action: 'skipped_empty_user' });
  }

  // ── 3. Write the user to the target board's people column ────────────────
  const columnValue = JSON.stringify({ personsAndTeams });
  const escapedValue = columnValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const updateMutation = `
    mutation {
      change_column_value(
        board_id: ${cfg.targetBoardId},
        item_id: ${triggeredItemId},
        column_id: "${cfg.targetColumnId}",
        value: "${escapedValue}"
      ) {
        id
      }
    }
  `;

  const updateResult = await mondayQuery(apiKey, updateMutation);

  if (updateResult?.errors) {
    console.error('Monday API error:', JSON.stringify(updateResult.errors));
    return res.status(500).json({ error: 'Failed to update column', details: updateResult.errors });
  }

  console.log(`[sync-crew-user] route=${route} item=${triggeredItemId} crew_member=${crewMemberItemId} users=${JSON.stringify(personsAndTeams)}`);
  return res.status(200).json({ success: true, action: 'synced', route, triggeredItemId, crewMemberItemId });
}

async function clearPeopleColumn(apiKey, boardId, itemId, columnId) {
  const mutation = `
    mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "{\\"personsAndTeams\\":[]}"
      ) { id }
    }
  `;
  await mondayQuery(apiKey, mutation);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAVEL CONFIRMATION PARSER — Universal Regex Engine
// POST /api/travel/parse  (rewrite → ?route=parse-travel)
//
// Body:   { "text": "<raw booking confirmation email or text>" }
// Returns:{ "success": true, "fields": { <mondayColumnId>: <value>, ... }, "parsed": { ... } }
//
// Zero external dependencies — pure JS regex, works for ANY airline/hotel/car vendor.
// No API keys, no quotas, no rate limits, no cost. Ever.
// ─────────────────────────────────────────────────────────────────────────────

// ── Date normalizer → YYYY-MM-DD ─────────────────────────────────────────────
function normalizeDate(str) {
  if (!str) return null;
  str = str.trim();

  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  // MM/DD/YYYY or MM-DD-YYYY
  let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;

  // YYYY-MM-DD already
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return str;

  // "July 25, 2026" or "Jul 25 2026" or "25 July 2026" or "25-JUL-26"
  m = str.match(/(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]*(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().substring(0,3)];
    if (mon) {
      const yr = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${yr}-${String(mon).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    }
  }
  m = str.match(/([A-Za-z]{3,9})[\s\.\-]+(\d{1,2})[,\s]+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase().substring(0,3)];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }

  return null;
}

// ── Time normalizer → HH:MM 24hr ─────────────────────────────────────────────
function normalizeTime(str) {
  if (!str) return null;
  str = str.trim();
  const m = str.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM|am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

// ── Grab first match from text using multiple patterns ────────────────────────
function extract(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return (m[1] || m[0]).trim();
  }
  return null;
}

// ── Find all date+time pairs near a keyword ───────────────────────────────────
const DATE_PAT  = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}|\d{1,2}-[A-Z]{3}-\d{2,4})/i;
const TIME_PAT  = /(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?|\d{1,2}\s*(?:AM|PM|am|pm))/i;
const AIRPORT_PAT = /\b([A-Z]{3})\b/;

function extractDateNear(text, keyword) {
  const re = new RegExp(keyword + '[^\\n]{0,60}', 'i');
  const m = text.match(re);
  if (!m) return null;
  const d = m[0].match(DATE_PAT);
  return d ? normalizeDate(d[0]) : null;
}

function extractTimeNear(text, keyword) {
  const re = new RegExp(keyword + '[^\\n]{0,60}', 'i');
  const m = text.match(re);
  if (!m) return null;
  const t = m[0].match(TIME_PAT);
  return t ? normalizeTime(t[0]) : null;
}

// ── Known IATA airport codes (top 150 US + common international) ─────────────
const IATA_AIRPORTS = new Set([
  'ATL','LAX','ORD','DFW','DEN','JFK','SFO','SEA','LAS','MCO','EWR','CLT','PHX','IAH','MIA',
  'BOS','MSP','FLL','DTW','PHL','LGA','BWI','SLC','SAN','DCA','MDW','TPA','PDX','HNL','STL',
  'BNA','AUS','DAL','IAD','OAK','MCI','SMF','RDU','MSY','SJC','SNA','SAT','CLE','PIT','CVG',
  'CMH','IND','MEM','OMA','RIC','BUF','BDL','ALB','PVD','SYR','ROC','ORF','RNO','ABQ','ELP',
  'TUS','OGG','KOA','LIH','ITO','GEG','BOI','BIL','MSO','FSD','COS','GJT','JAC','BZN','FCA',
  'LIT','TUL','OKC','ICT','DSM','MKE','MSN','GRR','LAN','TOL','EVV','SBN','TYS','BHM','HSV',
  'MOB','PNS','VPS','JAX','SAV','CHS','GSP','AVL','CAE','MYR','GSO','RDU','ORF','SHV','BTR',
  'GPT','JAN','AGS','EYW','RSW','SRQ','PIE','PBI','MLB','DAB','GNV','TLH','PFN','VLD','CSG',
  'YYZ','YVR','YUL','YYC','YEG','YOW','YHZ','YWG','LHR','LGW','MAN','EDI','GLA','BHX','BRS',
  'CDG','ORY','NCE','LYS','MRS','TLS','BOD','NTE','SVO','DME','LED','AMS','FRA','MUC','TXL',
  'HAM','DUS','STR','FCO','MXP','VCE','NAP','BCN','MAD','AGP','PMI','LIS','OPO','ATH','IST',
  'DXB','AUH','DOH','KWI','BAH','AMM','BEY','TLV','CAI','CMN','NBO','JNB','CPT','GRU','GIG',
  'EZE','SCL','LIM','BOG','MDE','MEX','CUN','GDL','MTY','PTY','SJO','SJU','BGI','NAS','MBJ',
  'YYZ','ICN','NRT','HND','KIX','CTS','OKA','PEK','PVG','HKG','TPE','SIN','BKK','KUL','CGK',
  'SYD','MEL','BNE','PER','AKL','CHC','PPT','GUM','HNL',
]);

// ── Flight segment extractor ──────────────────────────────────────────────────
function extractFlightSegments(text) {
  const segments = [];

  // Split into lines so we can work line-by-line for better context
  const lines = text.split('\n');

  // Find lines that look like flight number declarations
  // Pattern: standalone "DL 1847" or "Flight DL1847" or "Flight: DL 1847"
  const flightLineRe = /(?:^|flight\s*(?:\d+|#|:)?\s*)([A-Z]{2})\s*(\d{3,4})\b/i;

  // Known non-flight 2-letter combos to skip
  const SKIP = new Set(['AM','PM','US','UK','EU','OR','AT','TO','IN','ON','BY','OF','IS','IT','NO']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\b([A-Z]{2})\s*(\d{3,4})\b/);
    if (!m) continue;
    if (SKIP.has(m[1])) continue;

    const flightNum = m[1] + m[2];
    // Grab context: this line + next 5 lines
    const ctx = lines.slice(i, Math.min(lines.length, i + 6)).join('\n');

    // Extract airports — ONLY from parenthesized codes or known IATA set
    const airports = [];

    // Priority 1: (ORD) style — most reliable
    const parenAirports = [...ctx.matchAll(/\(([A-Z]{3})\)/g)].map(a => a[1]).filter(a => IATA_AIRPORTS.has(a));
    airports.push(...parenAirports);

    // Priority 2: standalone known IATA codes not inside a word
    if (airports.length < 2) {
      const standaloneAirports = [...ctx.matchAll(/\b([A-Z]{3})\b/g)]
        .map(a => a[1])
        .filter(a => IATA_AIRPORTS.has(a) && !airports.includes(a));
      airports.push(...standaloneAirports);
    }

    const depAirport = airports[0] || null;
    const arrAirport = airports[1] || null;

    // Dates and times in context
    const dates = [...ctx.matchAll(new RegExp(DATE_PAT.source, 'gi'))].map(d => normalizeDate(d[0])).filter(Boolean);
    const times = [...ctx.matchAll(new RegExp(TIME_PAT.source, 'gi'))].map(t => normalizeTime(t[0])).filter(Boolean);

    segments.push({
      flightNum,
      airline:    m[1],
      depAirport,
      arrAirport,
      depDate:    dates[0] || null,
      depTime:    times[0] || null,
      arrDate:    dates[1] || dates[0] || null,
      arrTime:    times[1] || null,
    });
  }

  // Deduplicate by flightNum
  const seen = new Set();
  return segments.filter(s => {
    if (seen.has(s.flightNum)) return false;
    seen.add(s.flightNum);
    return true;
  });
}

// ── Airline name from carrier code ────────────────────────────────────────────
const AIRLINE_CODES = {
  AA:'American Airlines', AS:'Alaska Airlines', B6:'JetBlue', DL:'Delta Air Lines',
  F9:'Frontier Airlines', G4:'Allegiant Air', HA:'Hawaiian Airlines', NK:'Spirit Airlines',
  SY:'Sun Country Airlines', UA:'United Airlines', WN:'Southwest Airlines', WS:'WestJet',
  AC:'Air Canada', BA:'British Airways', LH:'Lufthansa', AF:'Air France', KL:'KLM',
  EK:'Emirates', QR:'Qatar Airways', AA2:'American Airlines',
};
function airlineName(code) {
  return AIRLINE_CODES[code] || code;
}

// ── Confirmation number extractor ─────────────────────────────────────────────
function extractConfirmation(text) {
  return extract(text, [
    /(?:confirmation|record\s*locator|booking\s*(?:ref|reference|number|code)|conf(?:irmation)?\s*(?:#|number|code|no\.?))[:\s#]*([A-Z0-9\-]{4,12})/i,
    /(?:itinerary|reservation)\s*(?:number|#|no\.?)[:\s]*([A-Z0-9\-]{4,12})/i,
  ]);
}

async function handleParseTravel(req, res) {
  const { text } = req.body || {};

  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'Missing or too-short confirmation text' });
  }

  // ── Detect what type(s) of confirmation this is ───────────────────────────
  const t = text;
  const lower = t.toLowerCase();

  const hasFlight = /\b[A-Z]{2}\s*\d{3,4}\b/.test(t) || /depart|arrival|flight|airline|boarding/i.test(t);
  const hasHotel  = /check[\s\-]?in|check[\s\-]?out|hotel|resort|inn|suites|property|room/i.test(t);
  const hasCar    = /rental|rent[\s\-]?a[\s\-]?car|pickup|pick[\s\-]?up|vehicle|enterprise|hertz|avis|national|budget|alamo|dollar|thrifty/i.test(t);

  // ── FLIGHTS ───────────────────────────────────────────────────────────────
  const flightConfirmation = hasFlight ? extractConfirmation(t) : null;
  const segments = hasFlight ? extractFlightSegments(t) : [];

  // Determine outbound vs return
  // Strategy: look for "return" or "departing [home city]" keywords near second segment
  let flightOut    = segments[0] || null;
  let flightReturn = segments[1] || null;

  // If text explicitly labels a segment as "return"
  const returnIdx = t.search(/\b(?:return|returning|inbound|back)\b/i);
  if (returnIdx > 0 && segments.length >= 2) {
    // whichever segment appears after the "return" keyword is the return leg
    const afterReturn = t.substring(returnIdx);
    const returnMatch = afterReturn.match(/\b([A-Z]{2,3})\s*(\d{1,4})\b/);
    if (returnMatch) {
      const returnFlightNum = returnMatch[1] + returnMatch[2];
      const ri = segments.findIndex(s => s.flightNum === returnFlightNum);
      if (ri > 0) {
        flightOut    = segments.find((_, i) => i !== ri) || segments[0];
        flightReturn = segments[ri];
      }
    }
  }

  // ── HOTEL ─────────────────────────────────────────────────────────────────
  let hotel = null;
  if (hasHotel) {
    // Isolate hotel section to avoid stealing flight confirmation numbers
    const hotelSection = t.match(/(?:hotel|resort|inn|suites|property|check[\s\-]?in)[^\n]{0,500}/is)?.[0] || t;
    const hotelConf    = extractConfirmation(hotelSection);
    const checkinDate  = extractDateNear(t, 'check[\\s\\-]?in');
    const checkoutDate = extractDateNear(t, 'check[\\s\\-]?out');
    const checkinTime  = extractTimeNear(t, 'check[\\s\\-]?in');
    const checkoutTime = extractTimeNear(t, 'check[\\s\\-]?out');

    // Hotel name: look for property/hotel/resort label, or line before "check-in"
    let hotelName = extract(t, [
      /(?:property|hotel|resort|inn|suites|lodge)[:\s]+([^\n]{3,60})/i,
      /(?:you(?:'re| are) staying at|your hotel(?:\s+is)?)[:\s]+([^\n]{3,60})/i,
    ]);
    if (!hotelName) {
      // Grab the line immediately before "check-in" appears
      const ciIdx = t.search(/check[\s\-]?in/i);
      if (ciIdx > 0) {
        const before = t.substring(0, ciIdx).trim();
        const lines  = before.split('\n').map(l => l.trim()).filter(Boolean);
        const candidate = lines[lines.length - 1];
        if (candidate && candidate.length > 3 && candidate.length < 80) hotelName = candidate;
      }
    }

    // Address: street number + name, must end with a street type word
    const address = extract(t, [
      /(\d+\s+[A-Za-z0-9 ]{3,50}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Rd|Road|Way|Ln|Lane|Ct|Court|Pkwy|Parkway|Plaza|Circle|Pl(?:ace)?)[^\n]{0,40})/i,
    ]);

    // Phone
    const phone = extract(t, [
      /(?:phone|tel|call|front\s*desk)[:\s]*(\+?[\d\s\-\(\)\.]{7,20})/i,
      /(\(\d{3}\)\s*\d{3}[\s\-]\d{4})/,
      /(\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4})/,
    ]);

    hotel = { name: hotelName, confirmation: hotelConf, address, phone, checkinDate, checkinTime, checkoutDate, checkoutTime };
  }

  // ── CAR RENTAL ────────────────────────────────────────────────────────────
  let car = null;
  if (hasCar) {
    // Car confirmation — look specifically near rental/car keywords, not flight section
    const carSection = t.match(/(?:rent(?:al)?|car\s*rental|vehicle)[^\n]{0,200}/is)?.[0] || t;
    const carConf = extract(carSection, [
      /(?:confirmation|booking\s*(?:ref|reference|number|code)|conf(?:irmation)?\s*(?:#|number|no\.?))[:\s#]*([A-Z0-9\-]{4,15})/i,
      /\b([A-Z]{1,2}[\-]?\d{5,10})\b/,  // formats like E-5529183
    ]);

    // Company name
    const company = extract(t, [
      /(?:rental\s*company|rented?\s*(?:from|by|with)|provided\s*by)[:\s]+([^\n]{2,40})/i,
      /\b(Enterprise|Hertz|Avis|National|Budget|Alamo|Dollar|Thrifty|Sixt|Payless|Fox|Europcar|Firefly|Advantage)\b/i,
    ]);

    // Vehicle type — specific keyword match first, then labeled field
    const vehicleType = extract(t, [
      /\b(Sedan|SUV|Truck|Van|Minivan|Convertible|Compact|Economy|Midsize|Full[\s\-]Size|Luxury|Pickup|Crossover|Cargo Van|Passenger Van)\b/i,
      /(?:vehicle|car\s*type|class)[:\s]+([^\n,]{2,30})/i,
    ]);

    // Pickup location
    const pickupLocation = extract(t, [
      /(?:pickup|pick[\s\-]?up|collect(?:ion)?)\s*(?:location|at|from)?[:\s]+([^\n]{3,80})/i,
    ]);

    const pickupDate = extractDateNear(carSection, 'pick[\\s\\-]?up|pickup|collect');
    const pickupTime = extractTimeNear(carSection, 'pick[\\s\\-]?up|pickup|collect');
    const returnDate = extractDateNear(carSection, 'return|drop[\\s\\-]?off');
    const returnTime = extractTimeNear(carSection, 'return|drop[\\s\\-]?off');

    car = { company, confirmation: carConf, pickupLocation, vehicleType, pickupDate, pickupTime, returnDate, returnTime };
  }

  // ── Build parsed object ───────────────────────────────────────────────────
  const parsedData = {
    flight_out: flightOut ? {
      airline:           flightOut.airline ? airlineName(flightOut.airline) : null,
      confirmation:      flightConfirmation,
      flight_number:     flightOut.flightNum,
      departure_airport: flightOut.depAirport,
      arrival_airport:   flightOut.arrAirport,
      departure_date:    flightOut.depDate,
      departure_time:    flightOut.depTime,
      arrival_date:      flightOut.arrDate,
      arrival_time:      flightOut.arrTime,
    } : { airline:null, confirmation:null, flight_number:null, departure_airport:null, arrival_airport:null, departure_date:null, departure_time:null, arrival_date:null, arrival_time:null },

    flight_return: flightReturn ? {
      flight_number:     flightReturn.flightNum,
      departure_airport: flightReturn.depAirport,
      arrival_airport:   flightReturn.arrAirport,
      departure_date:    flightReturn.depDate,
      departure_time:    flightReturn.depTime,
      arrival_date:      flightReturn.arrDate,
      arrival_time:      flightReturn.arrTime,
    } : { flight_number:null, departure_airport:null, arrival_airport:null, departure_date:null, departure_time:null, arrival_date:null, arrival_time:null },

    hotel: hotel ? {
      name:          hotel.name,
      confirmation:  hotel.confirmation,
      address:       hotel.address,
      phone:         hotel.phone,
      checkin_date:  hotel.checkinDate,
      checkin_time:  hotel.checkinTime,
      checkout_date: hotel.checkoutDate,
      checkout_time: hotel.checkoutTime,
    } : { name:null, confirmation:null, address:null, phone:null, checkin_date:null, checkin_time:null, checkout_date:null, checkout_time:null },

    car: car ? {
      company:         car.company,
      confirmation:    car.confirmation,
      pickup_location: car.pickupLocation,
      vehicle_type:    car.vehicleType,
      pickup_date:     car.pickupDate,
      pickup_time:     car.pickupTime,
      return_date:     car.returnDate,
      return_time:     car.returnTime,
    } : { company:null, confirmation:null, pickup_location:null, vehicle_type:null, pickup_date:null, pickup_time:null, return_date:null, return_time:null },
  };

  const fo = parsedData.flight_out;
  const fr = parsedData.flight_return;
  const h  = parsedData.hotel;
  const c  = parsedData.car;

  // Map parsed data → Crew Assignments column IDs
  const raw = {
    // ── Outbound flight ──────────────────────────────────────────────────
    text_mm43k10m:  fo.airline,
    text_mm43x848:  fo.confirmation,
    text_mm43916d:  fo.departure_airport,
    text_mm43vmsd:  fo.arrival_airport,
    text_mm43px9p:  fo.flight_number,
    date_mm43db27:  fo.departure_date,
    date_mm43ctmh:  fo.arrival_date,
    hour_mm49krhd:  fo.departure_time ? toHourObj(fo.departure_time) : null,
    hour_mm499g4j:  fo.arrival_time   ? toHourObj(fo.arrival_time)   : null,
    // ── Return flight ────────────────────────────────────────────────────
    text_mm435t6s:  fr.flight_number,
    text_mm494548:  fr.departure_airport,
    text_mm49tdzy:  fr.arrival_airport,
    date_mm43x5w0:  fr.departure_date,
    date_mm43t4pw:  fr.arrival_date,
    hour_mm49xn0p:  fr.departure_time ? toHourObj(fr.departure_time) : null,
    hour_mm492d1m:  fr.arrival_time   ? toHourObj(fr.arrival_time)   : null,
    // ── Hotel ────────────────────────────────────────────────────────────
    text_mm43y099:      h.name,
    text_mm436s33:      h.confirmation,
    long_text_mm43mq97: h.address,
    phone_mm43519t:     h.phone,
    date_mm43en7b:      h.checkin_date,
    date_mm43zmaj:      h.checkout_date,
    hour_mm49afzj:  h.checkin_time  ? toHourObj(h.checkin_time)  : null,
    hour_mm49xtr5:  h.checkout_time ? toHourObj(h.checkout_time) : null,
    // ── Car rental ───────────────────────────────────────────────────────
    text_mm43fve1:  c.company,
    text_mm43p3np:  c.confirmation,
    text_mm43296r:  c.pickup_location,
    text_mm43a8tw:  c.vehicle_type,
    date_mm43dtbe:  c.pickup_date,
    date_mm434e7x:  c.return_date,
    hour_mm49secw:  c.pickup_time  ? toHourObj(c.pickup_time)  : null,
    hour_mm49mdz:   c.return_time  ? toHourObj(c.return_time)  : null,
  };

  // Strip nulls / empty strings — only return fields that were actually found
  const fields = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );

  console.log(`[parse-travel] Extracted ${Object.keys(fields).length} fields from ${text.length} chars`);

  return res.status(200).json({ success: true, fields, parsed: parsedData });
}

// monday.com hour column format: { hour: 14, minute: 30 }
function toHourObj(timeStr) {
  if (!timeStr) return null;
  const [hStr, mStr] = timeStr.split(':');
  const hour   = parseInt(hStr, 10);
  const minute = parseInt(mStr || '0', 10);
  if (isNaN(hour)) return null;
  return { hour, minute };
}
