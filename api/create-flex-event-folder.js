/**
 * Create Flex Event Folder
 *
 * Called by the Vibe "Project Setup" app when a designer wants to pre-create
 * a project structure before a full quote exists in Flex. Creates an event
 * folder (simple-project-element) in Flex Rental Solutions and returns the
 * new element ID and element number so the Vibe app can display it.
 *
 * Also optionally resolves a client name → Flex contact UUID and links it
 * to the new event folder if found.
 *
 * Endpoint: POST /api/create-flex-event-folder
 *
 * Body:
 * {
 *   "projectName": "Artist Name | Venue Name",   // required
 *   "eventDate":   "2026-08-15",                 // required (YYYY-MM-DD)
 *   "clientName":  "Acme Corp",                  // optional — used to link client
 *   "pmEmail":     "matt@anticstudios.com"        // optional — for reference/logging
 * }
 *
 * Response (success):
 * {
 *   "ok": true,
 *   "flexEventFolderId":  "uuid-string",
 *   "flexElementNumber":  "26-0145",
 *   "clientLinked":       true | false,
 *   "clientFlexId":       "uuid-string" | null
 * }
 *
 * Author: Matt James, Antic Studios
 * Created: July 2026
 */

export const config = { api: { bodyParser: true } };
export const maxDuration = 30;

// ── Environment ───────────────────────────────────────────────────────────────
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

// ── Flex HTTP helpers ─────────────────────────────────────────────────────────
async function flexGet(path) {
  const res = await fetch(`${FLEX_BASE_URL}${path}`, {
    headers: {
      'X-Auth-Token':  FLEX_API_KEY,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
  });
  if (!res.ok) throw new Error(`Flex GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function flexPost(path, body) {
  const res = await fetch(`${FLEX_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Auth-Token':  FLEX_API_KEY,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flex POST ${path} → HTTP ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Resolve client name → Flex contact UUID ───────────────────────────────────
// Searches Flex contacts by name, returns UUID of best match (or null).
async function resolveClientUUID(clientName) {
  if (!clientName || !clientName.trim()) return null;
  try {
    const encoded = encodeURIComponent(clientName.trim());
    const data    = await flexGet(`/api/contact/search?searchText=${encoded}&size=5`);
    const results = data?.content || data?.data || (Array.isArray(data) ? data : []);
    if (!results.length) return null;

    // Prefer exact name match, fallback to first result
    const exact = results.find(
      c => (c.name || '').trim().toLowerCase() === clientName.trim().toLowerCase()
    );
    const match = exact || results[0];
    console.log(`[create-flex-event-folder] ✅ Client resolved: "${match.name}" → ${match.id}`);
    return match.id || null;
  } catch (err) {
    console.warn(`[create-flex-event-folder] ⚠️ Client lookup failed: ${err.message}`);
    return null;
  }
}

// ── Create the Flex event folder ──────────────────────────────────────────────
// Uses POST /api/element with domainId "simple-project-element".
// eventDate maps to both eventDate and plannedStartDate/plannedEndDate
// so the folder shows up in Flex calendar views.
async function createFlexEventFolder(projectName, eventDate, clientUUID) {
  const payload = {
    name:               projectName,
    domainId:           'simple-project-element',
    eventDate:          eventDate,
    plannedStartDate:   eventDate,
    plannedEndDate:     eventDate,
  };

  // Link client if we resolved a UUID
  if (clientUUID) {
    payload.clientId = clientUUID;
  }

  console.log(`[create-flex-event-folder] 📤 Creating event folder: "${projectName}" on ${eventDate}`);
  const data = await flexPost('/api/element', payload);

  // Flex returns the new element — extract ID and element number
  const id            = data?.id            || data?.data?.id;
  const elementNumber = data?.elementNumber || data?.data?.elementNumber || data?.barcode || null;

  if (!id) throw new Error(`Flex returned no ID for new element. Response: ${JSON.stringify(data)}`);

  console.log(`[create-flex-event-folder] ✅ Created: ${id} (${elementNumber || 'no number yet'})`);
  return { id, elementNumber };
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  const { projectName, eventDate, clientName, pmEmail } = body || {};

  // ── Validate required fields ───────────────────────────────────────────────
  if (!projectName?.trim()) {
    return res.status(400).json({ error: 'projectName is required' });
  }
  if (!eventDate?.trim()) {
    return res.status(400).json({ error: 'eventDate is required (YYYY-MM-DD)' });
  }

  // Basic date format validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate.trim())) {
    return res.status(400).json({ error: 'eventDate must be YYYY-MM-DD format' });
  }

  console.log(`\n🚀 create-flex-event-folder | "${projectName}" | ${eventDate} | client: ${clientName || 'none'} | pm: ${pmEmail || 'none'}`);

  try {
    // ── Step 1: Resolve client UUID (optional) ─────────────────────────────
    const clientUUID = await resolveClientUUID(clientName);

    // ── Step 2: Create the event folder in Flex ────────────────────────────
    const { id: flexEventFolderId, elementNumber: flexElementNumber } =
      await createFlexEventFolder(projectName.trim(), eventDate.trim(), clientUUID);

    // ── Respond ────────────────────────────────────────────────────────────
    return res.status(200).json({
      ok:                 true,
      flexEventFolderId,
      flexElementNumber,
      clientLinked:       !!clientUUID,
      clientFlexId:       clientUUID || null,
    });

  } catch (err) {
    console.error(`[create-flex-event-folder] ❌ Error:`, err.message);
    return res.status(500).json({
      ok:    false,
      error: err.message,
    });
  }
}
