/**
 * Create Flex Event Folder
 *
 * Called by the Vibe "Project Setup" app when a designer wants to pre-create
 * a project structure before a full quote exists in Flex. Creates an event
 * folder element in Flex Rental Solutions and returns the new elementId and
 * elementNumber so the Vibe app can display it.
 *
 * Endpoint: POST /api/create-flex-event-folder
 *
 * Body:
 * {
 *   "projectName": "Artist Name | Venue Name",   // required
 *   "eventDate":   "2026-08-15",                 // required (YYYY-MM-DD)
 *   "clientName":  "Acme Corp",                  // optional
 *   "pmEmail":     "matt@anticstudios.com"        // optional
 * }
 *
 * Response (success):
 * {
 *   "ok": true,
 *   "flexEventFolderId":  "uuid-string",
 *   "flexElementNumber":  "26-0145",
 *   "flexElementName":    "Artist Name | Venue Name",
 *   "clientLinked":       true | false,
 *   "clientFlexId":       "uuid-string" | null
 * }
 *
 * Env vars:
 *   FLEX_EVENT_DEFINITION_ID  — UUID of the "Event Folder" element definition
 *                               in your Flex account. Find it by hitting:
 *                               GET /api/element-definition/enabled-definitions
 *                               If not set, the endpoint will look it up
 *                               dynamically on first call and log it for you.
 *
 * Author: Matt James, Antic Studios
 * Created: July 2026
 */

export const config = { api: { bodyParser: true } };
export const maxDuration = 30;

// ── Environment ───────────────────────────────────────────────────────────────
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

// UUID of the "Event Folder" / "simple-project-element" definition in your Flex account.
// Set FLEX_EVENT_DEFINITION_ID in Vercel env vars to skip the dynamic lookup.
let _cachedDefinitionId = process.env.FLEX_EVENT_DEFINITION_ID || null;

// ── Flex HTTP helpers ─────────────────────────────────────────────────────────
async function flexGet(path) {
  const res = await fetch(`${FLEX_BASE_URL}${path}`, {
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Flex GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function flexPost(path, body) {
  const res = await fetch(`${FLEX_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Accept':       'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flex POST ${path} → HTTP ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Convert YYYY-MM-DD → ISO date-time string required by Flex ────────────────
function toFlexDateTime(dateStr) {
  if (!dateStr) return null;
  // Already has time component — return as-is
  if (dateStr.includes('T')) return dateStr;
  return `${dateStr}T00:00:00.000Z`;
}

// ── Resolve the "Event Folder" definitionId from Flex ─────────────────────────
// Calls GET /api/element-definition/enabled-definitions and finds the definition
// whose typeCode or name indicates it's a top-level event/project folder.
// Result is cached in-process so subsequent calls are instant.
async function resolveEventFolderDefinitionId() {
  if (_cachedDefinitionId) return _cachedDefinitionId;

  console.log('[create-flex-event-folder] 🔍 Looking up event folder definition ID...');
  const defs = await flexGet('/api/element-definition/enabled-definitions');

  if (!Array.isArray(defs) || defs.length === 0) {
    throw new Error('No element definitions returned from Flex. Check FLEX_API_KEY.');
  }

  // Log all definitions so the correct one is easy to identify in Vercel logs
  console.log('[create-flex-event-folder] Available definitions:');
  for (const d of defs) {
    console.log(`  id=${d.id}  code=${d.code}  name="${d.name}"  namePlural="${d.namePlural}"`);
  }

  // Heuristic: prefer a definition whose name/code contains "event" or "project"
  // and is NOT a quote, equipment list, or crew list.
  const EXCLUDE = ['quote', 'equipment', 'crew', 'expense', 'task', 'session', 'manifest'];
  const PREFER  = ['event', 'project', 'folder', 'show'];

  const candidates = defs.filter(d => {
    const haystack = `${d.name} ${d.namePlural} ${d.code}`.toLowerCase();
    const excluded = EXCLUDE.some(x => haystack.includes(x));
    const preferred = PREFER.some(x => haystack.includes(x));
    return preferred && !excluded;
  });

  const chosen = candidates[0] || defs[0];
  _cachedDefinitionId = chosen.id;

  console.log(`[create-flex-event-folder] ✅ Using definition: id=${chosen.id} name="${chosen.name}" code="${chosen.code}"`);
  console.log(`[create-flex-event-folder] 💡 Set FLEX_EVENT_DEFINITION_ID=${chosen.id} to skip this lookup`);

  return _cachedDefinitionId;
}

// ── Resolve client name → Flex contact UUID ───────────────────────────────────
// Uses GET /api/contact/search — returns PageContactSearchEntry { content: [...] }
// ContactSearchEntry fields: id, name, company, jobTitle, email, organization
async function resolveClientUUID(clientName) {
  if (!clientName?.trim()) return null;
  try {
    const encoded = encodeURIComponent(clientName.trim());
    const data    = await flexGet(`/api/contact/search?searchText=${encoded}&size=5`);
    const results = data?.content || [];

    if (!results.length) {
      console.log(`[create-flex-event-folder] ⚠️ No contacts found for "${clientName}"`);
      return null;
    }

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

// ── Create the Flex event folder element ──────────────────────────────────────
// POST /api/element — ElementPersistRequest
// Response: ElementKeyInfo { elementId, elementNumber, elementName, ... }
async function createFlexEventFolder(projectName, eventDate, clientUUID, definitionId) {
  const payload = {
    definitionId,
    name:             projectName,
    eventDate:        toFlexDateTime(eventDate),
    plannedStartDate: toFlexDateTime(eventDate),
    plannedEndDate:   toFlexDateTime(eventDate),
  };

  if (clientUUID) payload.clientId = clientUUID;

  console.log(`[create-flex-event-folder] 📤 Creating: "${projectName}" on ${eventDate} (def: ${definitionId})`);
  const data = await flexPost('/api/element', payload);

  // Response is ElementKeyInfo — primary key is elementId
  const elementId     = data?.elementId;
  const elementNumber = data?.elementNumber || null;
  const elementName   = data?.elementName   || projectName;

  if (!elementId) {
    throw new Error(`Flex returned no elementId. Response: ${JSON.stringify(data)}`);
  }

  console.log(`[create-flex-event-folder] ✅ Created: elementId=${elementId} number=${elementNumber}`);
  return { elementId, elementNumber, elementName };
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate.trim())) {
    return res.status(400).json({ error: 'eventDate must be YYYY-MM-DD format' });
  }

  console.log(`\n🚀 create-flex-event-folder | "${projectName}" | ${eventDate} | client: ${clientName || 'none'} | pm: ${pmEmail || 'none'}`);

  try {
    // ── Step 1: Resolve definition ID + client UUID in parallel ───────────────
    const [definitionId, clientUUID] = await Promise.all([
      resolveEventFolderDefinitionId(),
      resolveClientUUID(clientName),
    ]);

    // ── Step 2: Create the event folder in Flex ────────────────────────────
    const { elementId, elementNumber, elementName } =
      await createFlexEventFolder(projectName.trim(), eventDate.trim(), clientUUID, definitionId);

    return res.status(200).json({
      ok:               true,
      flexEventFolderId: elementId,
      flexElementNumber: elementNumber,
      flexElementName:   elementName,
      clientLinked:     !!clientUUID,
      clientFlexId:     clientUUID || null,
    });

  } catch (err) {
    console.error(`[create-flex-event-folder] ❌ Error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
