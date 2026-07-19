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
// TRAVEL CONFIRMATION PARSER
// POST /api/travel/parse  (rewrite → ?route=parse-travel)
//
// Body:   { "text": "<raw booking confirmation email or text>" }
// Returns:{ "success": true, "fields": { <mondayColumnId>: <value>, ... }, "parsed": { ... } }
//
// Requires env var: GEMINI_API_KEY
// Model: gemini-2.0-flash — FREE tier: 1,500 calls/day, no credit card needed
// Get key at: aistudio.google.com/apikey
// ─────────────────────────────────────────────────────────────────────────────
async function handleParseTravel(req, res) {
  const { text } = req.body || {};

  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'Missing or too-short confirmation text' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured in Vercel environment' });
  }

  const prompt = `You are a travel booking data extractor for an event production company's staffing system.
Parse the provided booking confirmation text and return ONLY a raw JSON object — no markdown, no explanation.

Schema (use null for any field not found):
{
  "flight_out": {
    "airline": null,
    "confirmation": null,
    "flight_number": null,
    "departure_airport": null,
    "arrival_airport": null,
    "departure_date": null,
    "departure_time": null,
    "arrival_date": null,
    "arrival_time": null
  },
  "flight_return": {
    "flight_number": null,
    "departure_airport": null,
    "arrival_airport": null,
    "departure_date": null,
    "departure_time": null,
    "arrival_date": null,
    "arrival_time": null
  },
  "hotel": {
    "name": null,
    "confirmation": null,
    "address": null,
    "phone": null,
    "checkin_date": null,
    "checkin_time": null,
    "checkout_date": null,
    "checkout_time": null
  },
  "car": {
    "company": null,
    "confirmation": null,
    "pickup_location": null,
    "vehicle_type": null,
    "pickup_date": null,
    "pickup_time": null,
    "return_date": null,
    "return_time": null
  }
}

Rules:
- All dates must be YYYY-MM-DD format
- All times must be HH:MM 24-hour format (e.g. "14:30" not "2:30 PM")
- Airport codes must be 3-letter IATA codes (e.g. "ORD" not "Chicago O'Hare")
- flight_out is the first/outbound leg; flight_return is the return leg
- If only one flight found (one-way), put it in flight_out
- Return ONLY the JSON object, nothing else

Booking confirmation text:
${text.substring(0, 4000)}`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1000 },
      }),
    }
  );

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    console.error('[parse-travel] Gemini error:', err);
    return res.status(500).json({ error: 'AI parsing failed', details: err });
  }

  const aiResult = await geminiRes.json();
  const rawContent = aiResult.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

  let parsedData;
  try {
    // Strip markdown fences if GPT wrapped in them anyway
    const clean = rawContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsedData = JSON.parse(clean);
  } catch (e) {
    console.error('[parse-travel] JSON parse error. Raw:', rawContent);
    return res.status(500).json({ error: 'Failed to parse AI response as JSON', raw: rawContent });
  }

  const fo = parsedData.flight_out    || {};
  const fr = parsedData.flight_return || {};
  const h  = parsedData.hotel         || {};
  const c  = parsedData.car           || {};

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
