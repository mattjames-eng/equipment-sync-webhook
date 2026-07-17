/**
 * Flex → monday.com Bulk Project Import Pipeline
 *
 * Pulls all upcoming events from Flex via broad search, de-dupes against
 * existing Projects board entries, and creates new projects for anything
 * not yet in the system. Fully reuses the field mapping and helper
 * patterns from create-project-from-quote.js.
 *
 * Endpoint: POST /api/bulk-import-upcoming
 *
 * Also handles GET requests as a diagnostic test (replaces test-bulk-search.js):
 *   GET /api/bulk-import-upcoming?prefix=26-&maxResults=200
 *   → Returns raw Flex search results classified by type. No monday.com writes.
 *
 * Body (all fields optional, POST only):
 * {
 *   "prefix":          "26-",    // Flex search term — default "26-"
 *   "maxResults":      number,   // Flex results per page (see handler for default)
 *   "includeClosed":   false,    // Include closed/past events — default false
 *   "dryRun":          false,    // true = analyze only, don't write to monday
 *   "resolveContacts": true,     // false = skip contact lookups (faster) — default true
 *   "batchSize":       number,   // Parallel project creates per wave (see handler for default)
 *   "limit":           number    // Max new projects to import per run (see handler for default)
 * }
 *
 * Author: Matt James, Antic Studios
 */

export const config = { api: { bodyParser: true } };
export const maxDuration = 60;

// ── Environment ───────────────────────────────────────────────────────────────
const FLEX_BASE_URL   = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY    = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;
const MONDAY_API_URL  = 'https://api.monday.com/v2';
const MONDAY_API_KEY  = process.env.MONDAY_API_KEY;
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL;

// ── Board / Group IDs ─────────────────────────────────────────────────────────
const PROJECTS_BOARD_ID  = '18415679761';
const CONTACTS_BOARD_ID  = '18415573401';
const UPCOMING_GROUP_ID  = 'group_mm3x407x'; // "Upcoming Projects" group

// ── Projects Board Column IDs (from board inspection) ─────────────────────────
const COL = {
  flexProjectNum:    'text_mm3x2yr6',    // Flex Project # — de-dupe key
  eventDate:         'date_mm3xca9r',
  prepDate:          'date_mm4at0qc',
  returnDate:        'date_mm4a7fn6',
  estimatedBudget:   'numeric_mm3xzncg',
  actualSpend:       'numeric_mm3xrd3e',
  flexProjectUUID:   'text_mm466djv',    // Event Folder UUID
  flexQuoteUUID:     'text_mm4cwasc',    // Quote UUID
  flexEquipListID:   'text_mm3y7xwa',    // Equipment List UUID
  equipmentCount:    'numeric_mm3zsgna',
  lastEquipSync:     'date_mm3z1vqz',
  clientRelation:    'board_relation_mm3x8evw',
  venueRelation:     'board_relation_mm3xrm02',
  pullsheetStatus:   'color_mm3y3bxj',   // "Not Synced"
};

// ── Create Google Drive folder structure via Apps Script ──────────────────────
async function createProjectFolder(projectName, projectId, clientName, eventDate, pmEmail) {
  if (!GOOGLE_APPS_SCRIPT_URL) {
    console.warn('[bulk-import] ⚠️ GOOGLE_APPS_SCRIPT_URL not set — skipping Drive folder creation');
    return null;
  }
  try {
    const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ projectName, projectId, clientName, eventDate, pmEmail })
    });
    if (!response.ok) throw new Error(`Apps Script HTTP ${response.status}`);
    return response.json();
  } catch (err) {
    console.warn(`[bulk-import] ⚠️ Drive folder creation failed: ${err.message}`);
    return null;
  }
}

// ── Domain Classifier (mirrors create-project-from-quote.js) ─────────────────
// 'simple-project-element' is also classified as event-folder based on observed Flex domain values
function classifyDomain(result) {
  const domain = (result.domainId || result.domain || result.type || '').toLowerCase();
  if (['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain))                                   return 'equipment-list';
  if (['project', 'event-folder', 'event_folder', 'folder', 'simple-project-element'].includes(domain)) return 'event-folder';
  if (['quote', 'financial-document', 'financial_document', 'financialdocument'].includes(domain))      return 'quote';
  return 'unknown';
}

// ── UUID Extractor (mirrors create-project-from-quote.js) ────────────────────
function extractUuid(obj) {
  if (!obj) return null;
  if (typeof obj === 'string' && obj.trim().length === 36) return obj.trim();
  if (typeof obj === 'object') {
    if (obj.data?.id)                                                      return obj.data.id.trim();
    if (typeof obj.data === 'string' && obj.data.trim().length === 36)    return obj.data.trim();
    if (obj.value && typeof obj.value === 'string' && obj.value.trim().length === 36) return obj.value.trim();
    if (obj.id   && typeof obj.id   === 'string' && obj.id.trim().length   === 36)   return obj.id.trim();
    for (const key in obj) {
      if (typeof obj[key] === 'string' && obj[key].trim().length === 36) return obj[key].trim();
    }
  }
  return null;
}

// ── Deep Name Extractor (mirrors create-project-from-quote.js) ───────────────
function deepExtractName(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.trim();
  if (Array.isArray(obj)) return deepExtractName(obj[0]);
  if (typeof obj === 'object') {
    if (obj.data?.preferredDisplayString) return String(obj.data.preferredDisplayString).trim();
    if (obj.data?.name)                   return String(obj.data.name).trim();
    if (obj.displayString)                return String(obj.displayString).trim();
    if (obj.preferredDisplayString)       return String(obj.preferredDisplayString).trim();
    if (obj.name)                         return String(obj.name).trim();
    if (obj.value)                        return String(obj.value).trim();
    if (obj.text)                         return String(obj.text).trim();
    for (const k in obj) {
      if (k !== 'id' && k !== 'fieldType' && typeof obj[k] === 'string' && obj[k].trim().length > 0)
        return obj[k].trim();
    }
  }
  return null;
}

// ── Numeric Extractor (mirrors create-project-from-quote.js) ─────────────────
function extractNumber(obj) {
  if (!obj) return 0;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return parseFloat(obj) || 0;
  if (typeof obj === 'object' && obj.data !== undefined)
    return typeof obj.data === 'number' ? obj.data : parseFloat(obj.data) || 0;
  return 0;
}

// ── Format a Flex ISO date string to YYYY-MM-DD for monday ───────────────────
function toMondayDate(isoString) {
  if (!isoString) return null;
  try { return isoString.split('T')[0]; } catch { return null; }
}

// ── Monday.com GraphQL helper ─────────────────────────────────────────────────
async function mondayRequest(query) {
  const res  = await fetch(MONDAY_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-10' },
    body:    JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Monday API: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// ── Flex HTTP helper ──────────────────────────────────────────────────────────
async function flexGet(path) {
  const res = await fetch(`${FLEX_BASE_URL}${path}`, {
    headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Flex ${path} → HTTP ${res.status}`);
  return res.json();
}

// ── Resolve contact UUID → human name via Flex identity endpoint ──────────────
async function resolveContactName(uuid, fallback) {
  if (!uuid) return fallback;
  try {
    const data = await flexGet(`/api/contact/${uuid}/identity`);
    return data.name || data.preferredDisplayString || fallback;
  } catch {
    return fallback;
  }
}

// ── Find monday.com user by email address ─────────────────────────────────────
async function findMondayUserByEmail(email) {
  if (!email) return null;
  try {
    const data = await mondayRequest(`query { users(emails: ["${email}"]) { id email } }`);
    return data?.users?.[0]?.id || null;
  } catch {
    return null;
  }
}

// ── Find contact in monday Contacts board ─────────────────────────────────────
// Primary:  match by Flex Contact UUID (text_mm56w1vz) — exact, instant
// Fallback: full-text name search — for contacts not yet synced from Flex
async function findContactByFlexUuid(flexUuid, nameFallback) {
  // Primary: UUID match via Flex Contact ID column
  if (flexUuid) {
    try {
      const data = await mondayRequest(`
        query {
          items_page_by_column_values(
            limit: 5,
            board_id: ${CONTACTS_BOARD_ID},
            columns: [{ column_id: "text_mm56w1vz", column_values: ["${flexUuid}"] }]
          ) { items { id name } }
        }
      `);
      const items = data?.items_page_by_column_values?.items || [];
      if (items.length > 0) {
        console.log(`[bulk-import] ✅ Contact matched by Flex UUID: "${items[0].name}" (${flexUuid})`);
        return items[0].id;
      }
    } catch (e) {
      console.warn(`[bulk-import] ⚠️ UUID contact lookup failed for ${flexUuid}:`, e.message);
    }
  }

  // Fallback: name search (contacts not yet synced from Flex)
  if (!nameFallback || nameFallback.includes('Unknown')) return null;
  const safe = nameFallback.trim().replace(/"/g, '\\"');
  console.log(`[bulk-import] 🔍 UUID miss — falling back to name search for: "${nameFallback}"`);
  try {
    const data = await mondayRequest(`
      query {
        boards(ids: [${CONTACTS_BOARD_ID}]) {
          items_page(limit: 50, query_params: { term: "${safe}" }) {
            items { id name }
          }
        }
      }
    `);
    const items = data?.boards?.[0]?.items_page?.items || [];
    const exact = items.find(i => i.name.trim().toLowerCase() === nameFallback.trim().toLowerCase());
    if (exact) {
      console.log(`[bulk-import] ✅ Contact matched by name fallback: "${exact.name}"`);
      return exact.id;
    }
  } catch {
    return null;
  }
  return null;
}

// ── Search Flex for all upcoming events by prefix ─────────────────────────────
async function searchFlex(prefix, maxResults, includeClosed) {
  const params = new URLSearchParams({
    searchText:     prefix,
    searchTypes:    'all',
    maxResults:     String(maxResults),
    includeDeleted: 'false',
    includeClosed:  String(includeClosed)
  });
  const raw = await flexGet(`/api/search?${params}`);

  // Normalize to flat array (Flex returns bare array OR {content:[...]} OR {results:[...]})
  if (Array.isArray(raw))              return raw;
  if (Array.isArray(raw?.content))     return raw.content;
  if (Array.isArray(raw?.results))     return raw.results;
  if (Array.isArray(raw?.data))        return raw.data;
  return [];
}

// ── Bulk-fetch all existing projects from the Projects board ──────────────────
// Returns a Map keyed by lowercase flex number → { id, hasBudget }
// Used for de-dupe AND to identify existing projects with missing budget data.
async function fetchExistingProjects() {
  const existing = new Map();
  let cursor = null;

  do {
    const cursorClause = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayRequest(`
      query {
        boards(ids: [${PROJECTS_BOARD_ID}]) {
          items_page(limit: 500${cursorClause}) {
            cursor
            items {
              id
              column_values(ids: ["${COL.flexProjectNum}", "${COL.estimatedBudget}"]) { id text }
            }
          }
        }
      }
    `);
    const page = data?.boards?.[0]?.items_page;
    for (const item of (page?.items || [])) {
      const flexNumCol = item.column_values?.find(c => c.id === COL.flexProjectNum);
      const budgetCol  = item.column_values?.find(c => c.id === COL.estimatedBudget);
      const flexNum    = flexNumCol?.text?.trim();
      if (flexNum) {
        existing.set(flexNum.toLowerCase(), {
          id:        item.id,
          hasBudget: !!(budgetCol?.text && parseFloat(budgetCol.text) > 0),
        });
      }
    }
    cursor = page?.cursor || null;
  } while (cursor);

  return existing;
}

// ── Fetch header data for a quote UUID ────────────────────────────────────────
// header-data requires codeList param — see create-project-from-quote.js for reference
// parentElementId must be explicitly requested in codeList to be included in the header-data response
async function fetchHeaderData(quoteUUID) {
  return flexGet(`/api/element/${quoteUUID}/header-data?codeList=elementNumber,name,clientId,venueId,personResponsibleId,personResponsibleDefaultEmailAddress,eventDate,plannedStartDate,plannedEndDate,totalPrice,notes,equipmentList,parentElementId`);
}

// ── Find equipment list for a quote (same fallback chain as create-project) ───
async function findEquipmentListUUID(quoteUUID) {
  try {
    const raw = await flexGet(`/api/equipment-list?parentElementId=${quoteUUID}&page=0&size=10`);
    const list = Array.isArray(raw) ? raw : (raw?.content || []);
    return list?.[0]?.id || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: Process a single quote result into a monday.com project
// Returns: { status: 'created'|'skipped'|'error', name, flexNum, itemId?, reason? }
// ─────────────────────────────────────────────────────────────────────────────
async function processQuote(quoteResult, options) {
  const { dryRun, resolveContacts } = options;
  // Flex may return name=null on numbered quotes — fall back to displayString
  const quoteName  = quoteResult.name || quoteResult.displayString || quoteResult.displayName || '(unnamed)';
  const quoteUUID  = quoteResult.id   || quoteResult.elementId     || quoteResult.uuid;
  // De-dupe key is the barcode field, not a value parsed from the name string
  const flexNum    = quoteResult.barcode || quoteResult.name?.match(/^\d{2}-\d+/)?.[0] || quoteName;

  console.log(`[bulk-import] Processing: "${quoteName}" (UUID: ${quoteUUID})`);

  try {
    // ── Fetch header data ──────────────────────────────────────────────────
    const hd = await fetchHeaderData(quoteUUID);

    // ── Extract dates ──────────────────────────────────────────────────────
    // header-data wraps dates in nested objects — use deepExtractName() + regex to extract.
    //      See create-project-from-quote.js for the same pattern.
    const today = new Date().toISOString().split('T')[0];
    function extractDate(field) {
      const raw = deepExtractName(field);
      if (!raw) return null;
      const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    }
    const eventDate  = extractDate(hd.eventDate  || hd.showStartDate);
    const prepDate   = extractDate(hd.plannedStartDate || hd.prepDate   || hd.loadInDate);
    const returnDate = extractDate(hd.plannedEndDate   || hd.returnDate || hd.loadOutDate);

    // Skip events in the past (eventDate < today)
    if (eventDate && eventDate < today) {
      console.log(`[bulk-import] ⏩ Skipping past event: "${quoteName}" (${eventDate})`);
      return { status: 'skipped', name: quoteName, flexNum, reason: `past event (${eventDate})` };
    }

    // ── Extract budget ─────────────────────────────────────────────────────
    // codeList returns totalPrice for budget; budgetedRevenue is not available via this endpoint
    const budget = extractNumber(hd.totalPrice || hd.budgetedRevenue || hd.resolvedBudgetedRevenue);

    // ── Skip empty shell quotes (numbered drafts with no real data) ────────
    // These are Flex drafts with no name, client, or eventDate — not real events
    const hasRealData = hd.clientId?.data || hd.eventDate?.data || hd.name?.data;
    if (!hasRealData) {
      console.log(`[bulk-import] ⏩ Skipping empty shell quote: "${quoteName}" (no client/date/name data)`);
      return { status: 'skipped', name: quoteName, flexNum, reason: 'empty shell — no event data in Flex' };
    }

    // ── Resolve Event Folder UUID (parent) ─────────────────────────────────
    // parentElementId is returned as a nested object — extract the UUID from within .data
    let eventFolderUUID = extractUuid(hd.parentElementId?.data) || extractUuid(hd.parentElementId);
    if (!eventFolderUUID) {
      try {
        const elem = await flexGet(`/api/element/${quoteUUID}`);
        eventFolderUUID = extractUuid(elem.parentElementId) || extractUuid(elem.data?.parentElementId);
      } catch { /* continue without folder UUID */ }
    }

    // ── Resolve Equipment List UUID ────────────────────────────────────────
    const equipListUUID = await findEquipmentListUUID(quoteUUID);

    // ── Extract contact UUIDs from header data ─────────────────────────────
    // codeList maps client/venue to hd.clientId / hd.venueId directly, not nested under hd.data
    const clientUUID            = extractUuid(hd.clientId          || hd.data?.client);
    const venueUUID             = extractUuid(hd.venueId           || hd.data?.venue);
    const personResponsibleEmail = hd.personResponsibleDefaultEmailAddress?.data || null;

    // ── Resolve human-readable names ───────────────────────────────────────
    let clientName = deepExtractName(hd.clientId) || deepExtractName(hd.data?.client) || deepExtractName(hd.clientName) || 'Unknown Client';
    let venueName  = deepExtractName(hd.venueId)  || deepExtractName(hd.data?.venue)  || deepExtractName(hd.venueName)  || 'Unknown Venue';

    if (resolveContacts && clientUUID && clientName === 'Unknown Client') {
      clientName = await resolveContactName(clientUUID, 'Unknown Client');
    }
    if (resolveContacts && venueUUID && venueName === 'Unknown Venue') {
      venueName = await resolveContactName(venueUUID, 'Unknown Venue');
    }


    // ── Find monday.com Contact item IDs (optional) ────────────────────────
    let clientItemId = null;
    let venueItemId  = null;
    if (resolveContacts) {
      [clientItemId, venueItemId] = await Promise.all([
        findContactByFlexUuid(clientUUID, clientName),
        findContactByFlexUuid(venueUUID,  venueName)
      ]);
    }

    // ── Build project name ─────────────────────────────────────────────────
    // Use Flex quote name directly — same approach as create-project-from-quote
    const projectName = quoteName;

    // ── Build column values ────────────────────────────────────────────────
    const columnValues = {
      [COL.flexProjectNum]:  flexNum,
      [COL.flexProjectUUID]: eventFolderUUID || '',
      [COL.flexQuoteUUID]:   quoteUUID       || '',
      [COL.flexEquipListID]: equipListUUID   || '',
      [COL.pullsheetStatus]: { label: 'Not Synced' },
      [COL.lastEquipSync]:   today,
    };

    if (eventDate)  columnValues[COL.eventDate]  = { date: eventDate };
    if (prepDate)   columnValues[COL.prepDate]   = { date: prepDate };
    if (returnDate) columnValues[COL.returnDate] = { date: returnDate };
    if (budget > 0) columnValues[COL.estimatedBudget] = String(budget);

    if (clientItemId) columnValues[COL.clientRelation] = { item_ids: [parseInt(clientItemId)] };
    if (venueItemId)  columnValues[COL.venueRelation]  = { item_ids: [parseInt(venueItemId)] };

    // ── Dry run: report without writing ───────────────────────────────────
    if (dryRun) {
      return {
        status:      'dry-run',
        name:        projectName,
        flexNum,
        eventDate,
        budget,
        clientName,
        venueName,
        eventFolderUUID,
        quoteUUID,
        equipListUUID
      };
    }

    // ── Create the project ─────────────────────────────────────────────────
    const colJson = JSON.stringify(JSON.stringify(columnValues));
    const data = await mondayRequest(`
      mutation {
        create_item(
          board_id:      ${PROJECTS_BOARD_ID},
          group_id:      "${UPCOMING_GROUP_ID}",
          item_name:     ${JSON.stringify(projectName)},
          column_values: ${colJson}
        ) { id }
      }
    `);

    const itemId = data?.create_item?.id;
    console.log(`[bulk-import] ✅ Created: "${projectName}" → item ${itemId}`);

    // ── Create Google Drive folder structure ───────────────────────────────
    if (itemId) {
      try {
        const driveResult = await createProjectFolder(
          projectName,
          itemId,
          clientName,
          eventDate,
          personResponsibleEmail
        );
        if (driveResult?.folderId) {
          console.log(`[bulk-import] 📁 Drive folder created: ${driveResult.folderUrl}`);
        }
      } catch (driveErr) {
        console.warn(`[bulk-import] ⚠️ Drive folder creation skipped: ${driveErr.message}`);
      }
    }

    return { status: 'created', name: projectName, flexNum, eventDate, budget, clientName, venueName, itemId };

  } catch (err) {
    console.error(`[bulk-import] ❌ Error on "${quoteName}":`, err.message);
    return { status: 'error', name: quoteName, flexNum, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// GEOCODE-LOCATIONS ACTION
//
// Reads the Address (long_text) column on the Contacts & Companies board
// and populates the Location column via Nominatim (free, no API key).
//
// Usage: GET /api/bulk-import-upcoming?action=geocode-locations
//        GET /api/bulk-import-upcoming?action=geocode-locations&batch=0
//        GET /api/bulk-import-upcoming?action=geocode-locations&batch=1
//        GET /api/bulk-import-upcoming?action=geocode-locations&dryRun=true
//
// Subject to serverless timeout. Process addresses in batches to stay within time limits.
// Repeat with batch=0, 1, 2... until response says done: true.
// ══════════════════════════════════════════════════════════════════════════════
const GEOCODE_ADDRESS_COL  = 'long_text_mm3vkzc6';
const GEOCODE_LOCATION_COL = 'location_mm50h12r';
const GEOCODE_BATCH_SIZE   = 10;

function cleanAddressForGeocode(raw) {
  let addr = raw.trim();
  // Multi-line: take only the first meaningful line
  const lines = addr.split(/\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) addr = lines[0];
  // Strip parenthetical notes: "(Operated by ...)"
  addr = addr.replace(/\s*\(.*?\)\s*/g, '').trim();
  // Strip "Label: " prefixes like "Corporate HQ: " or "Venue: "
  addr = addr.replace(/^[A-Za-z &\/]+:\s*/i, '').trim();
  return addr || raw.trim();
}

async function geocodeAddress(rawAddress) {
  const addr = cleanAddressForGeocode(rawAddress);
  const params = new URLSearchParams({ q: addr, format: 'json', limit: '1', addressdetails: '1' });
  const url = `https://nominatim.openstreetmap.org/search?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AnticStudios/ShowFlow (matt.james@anticstudios.com)' }
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.length === 0) return null;
  const r    = data[0];
  const addr2 = r.address || {};
  // Nominatim city can be in city, town, village, county, state depending on location type
  const cityName   = addr2.city || addr2.town || addr2.village || addr2.county || addr2.state || null;
  const streetName = addr2.road || addr2.pedestrian || addr2.path || null;
  const houseNum   = addr2.house_number || null;
  const countryName  = addr2.country || null;
  const countryShort = (addr2.country_code || 'us').toUpperCase();
  return {
    address:      r.display_name,
    lat:          String(r.lat),
    lng:          String(r.lon),
    countryName,
    countryShort,
    cityName,
    streetName,
    houseNum,
  };
}

async function writeLocationColumn(itemIds, geo) {
  // Build the location value using monday.com's required nested schema
  const locObj = {
    address: geo.address,
    lat:     geo.lat,
    lng:     geo.lng,
    country: geo.countryName
      ? { long_name: geo.countryName,  short_name: geo.countryShort || geo.countryName }
      : null,
    city: geo.cityName
      ? { long_name: geo.cityName, short_name: geo.cityName }
      : null,
    street: geo.streetName
      ? { long_name: geo.streetName, short_name: geo.streetName }
      : null,
    streetNumber: geo.houseNum
      ? { long_name: geo.houseNum, short_name: geo.houseNum }
      : null,
  };
  const colVal = JSON.stringify(locObj).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Update in chunks of 20 (GraphQL complexity limit)
  for (let i = 0; i < itemIds.length; i += 20) {
    const chunk = itemIds.slice(i, i + 20);
    const mutations = chunk
      .map((id, idx) => `m${idx}: change_column_value(board_id: ${CONTACTS_BOARD_ID}, item_id: ${id}, column_id: "${GEOCODE_LOCATION_COL}", value: "${colVal}") { id }`)
      .join('\n');
    await mondayRequest(`mutation { ${mutations} }`);
  }
}

async function fetchContactsWithAddresses() {
  const items = [];
  let cursor = null;
  do {
    const cursorClause = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayRequest(`
      query {
        boards(ids: [${CONTACTS_BOARD_ID}]) {
          items_page(limit: 500${cursorClause}) {
            cursor
            items { id column_values(ids: ["${GEOCODE_ADDRESS_COL}"]) { id text } }
          }
        }
      }
    `);
    const page = data?.boards?.[0]?.items_page;
    for (const item of (page?.items || [])) {
      const addr = item.column_values?.[0]?.text?.trim();
      if (addr) items.push({ id: item.id, address: addr });
    }
    cursor = page?.cursor || null;
  } while (cursor);
  return items;
}

async function handleGeocodeLocations(req, res) {
  // ── Mode 1: list=true → return address→itemIds map (no geocoding) ──────────
  // Fast call — just fetches monday.com items and returns the mapping.
  // Python driver calls this once to get all addresses, then loops geocode-one.
  if (req.query.list === 'true') {
    const allItems = await fetchContactsWithAddresses();
    const addrMap = {};
    for (const { id, address } of allItems) {
      if (!addrMap[address]) addrMap[address] = [];
      addrMap[address].push(id);
    }
    return res.json({
      ok: true,
      totalItems: allItems.length,
      uniqueAddresses: Object.keys(addrMap).length,
      map: addrMap
    });
  }

  // ── Mode 2: geocode ONE address and write to monday ────────────────────────
  // Caller passes ?address=<raw>&itemIds=<id,id,...>
  // Each call takes ~1-2s (one Nominatim hit + one monday mutation). No timeout risk.
  const rawAddr = req.query.address;
  const rawIds  = req.query.itemIds;
  if (!rawAddr || !rawIds) {
    return res.status(400).json({ ok: false, error: 'Pass ?list=true OR ?address=<addr>&itemIds=<id,id,...>' });
  }
  const itemIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
  let geo = null;
  try {
    geo = await geocodeAddress(rawAddr);
  } catch (err) {
    return res.json({ ok: false, address: rawAddr, reason: 'Geocode error: ' + err.message });
  }
  if (!geo) {
    return res.json({ ok: false, address: rawAddr, reason: 'No geocode result from Nominatim' });
  }
  try {
    await writeLocationColumn(itemIds, geo);
    return res.json({ ok: true, address: rawAddr, lat: geo.lat, lng: geo.lng, itemsUpdated: itemIds.length });
  } catch (err) {
    return res.json({ ok: false, address: rawAddr, reason: 'Monday update error: ' + err.message });
  }
}
// ── End geocode-locations block ───────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.body?.challenge)      return res.status(200).json({ challenge: req.body.challenge });

  // ── GET = cron trigger (Vercel Cron) OR diagnostic mode ──────────────────
  if (req.method === 'GET') {
    // ── Geocode-locations action ───────────────────────────────────────────
    if (req.query.action === 'geocode-locations') {
      if (!MONDAY_API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY not configured' });
      try {
        return await handleGeocodeLocations(req, res);
      } catch (err) {
        console.error('[geocode] Fatal:', err);
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    if (!FLEX_API_KEY) return res.status(500).json({ error: 'FLEX_API_KEY not configured' });

    // ── Cron mode: triggered by Vercel Cron scheduler ─────────────────────
    // Vercel sends Authorization: Bearer <CRON_SECRET> on every cron invocation.
    // We validate it here so random GETs can't trigger real imports.
    const cronSecret    = process.env.CRON_SECRET;
    const authHeader    = req.headers['authorization'] ?? '';
    const isCronRequest = cronSecret && authHeader === `Bearer ${cronSecret}`;

    if (isCronRequest) {
      if (!MONDAY_API_KEY) return res.status(500).json({ error: 'MONDAY_API_KEY not configured' });
      console.log('[bulk-import] ⏰ Cron triggered — running full import (dryRun=false)');
      try {
        const result = await runImport({
          prefix:          '26-',
          maxResults:      200,
          includeClosed:   false,
          dryRun:          false,
          resolveContacts: true,
          batchSize:       5,
          limit:           30,
        });
        console.log(`[bulk-import] ✅ Cron complete — created: ${result.results.created}, skipped: ${result.results.skipped}, errors: ${result.results.errors}`);
        return res.status(200).json({ triggered: 'cron', ...result });
      } catch (err) {
        console.error('[bulk-import] ❌ Cron failed:', err.message);
        return res.status(500).json({ error: 'Cron import failed', details: err.message });
      }
    }

    // ── Diagnostic mode: GET without cron secret = raw Flex search results ─
    const prefix        = req.query.prefix       ?? '26-';
    const maxResults    = parseInt(req.query.maxResults ?? '200', 10);
    const includeClosed = req.query.includeClosed === 'true';
    try {
      const allResults = await searchFlex(prefix, maxResults, includeClosed);
      const buckets    = { quotes: [], eventFolders: [], equipmentLists: [], unknown: [] };
      for (const r of allResults) {
        const type  = classifyDomain(r);
        const entry = {
          id:          r.id || r.elementId || r.uuid || null,
          name:        r.name || r.displayString || r.displayName || '(no name)',
          barcode:     r.barcode || null,
          rawDomain:   r.domainId || r.domain || r.type || null,
          classifiedAs: type
        };
        if      (type === 'quote')          buckets.quotes.push(entry);
        else if (type === 'event-folder')   buckets.eventFolders.push(entry);
        else if (type === 'equipment-list') buckets.equipmentLists.push(entry);
        else                                buckets.unknown.push(entry);
      }
      return res.status(200).json({
        mode: 'diagnostic — GET only, no writes',
        searchPrefix: prefix, maxResultsRequested: maxResults, includeClosed,
        totalRawResults: allResults.length,
        hitSearchLimit:  allResults.length >= maxResults,
        breakdown: { quotes: buckets.quotes.length, eventFolders: buckets.eventFolders.length, equipmentLists: buckets.equipmentLists.length, unknown: buckets.unknown.length },
        quotes: buckets.quotes, eventFolders: buckets.eventFolders, equipmentLists: buckets.equipmentLists, unknown: buckets.unknown,
        rawSample: allResults.slice(0, 3)
      });
    } catch (err) {
      return res.status(500).json({ error: 'Diagnostic failed', details: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET (diagnostic) or POST (import)' });

  if (!FLEX_API_KEY)    return res.status(500).json({ error: 'FLEX_API_KEY not configured' });
  if (!MONDAY_API_KEY)  return res.status(500).json({ error: 'MONDAY_API_KEY not configured' });

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  try {
    const summary = await runImport({
      prefix:          body.prefix          ?? '26-',
      maxResults:      body.maxResults       ?? 200,
      includeClosed:   body.includeClosed    ?? false,
      dryRun:          body.dryRun           ?? false,
      resolveContacts: body.resolveContacts  ?? true,
      batchSize:       Math.min(body.batchSize ?? 5, 10),
      limit:           body.limit            ?? 30,
    });
    return res.status(200).json(summary);
  } catch (err) {
    console.error('[bulk-import] 💥 Fatal error:', err);
    return res.status(500).json({ error: 'Bulk import failed', details: err.message });
  }
}

// ── Core import logic — shared by POST handler and cron GET trigger ──────────
async function runImport({ prefix, maxResults, includeClosed, dryRun, resolveContacts, batchSize, limit }) {
  console.log(`[bulk-import] 🚀 Starting — prefix="${prefix}", maxResults=${maxResults}, dryRun=${dryRun}, resolveContacts=${resolveContacts}, limit=${limit}`);

  // ── PHASE 1: Discover quotes from Flex ──────────────────────────────────
  console.log('[bulk-import] Phase 1: Searching Flex...');
  const allResults = await searchFlex(prefix, maxResults, includeClosed);
  const hitLimit   = allResults.length >= maxResults;

  const quotes = allResults.filter(r => classifyDomain(r) === 'quote');
  console.log(`[bulk-import] Found ${allResults.length} total Flex results → ${quotes.length} quotes`);

  // ── PHASE 2: De-dupe against existing Projects board ────────────────────
  console.log('[bulk-import] Phase 2: Loading existing Projects...');
  const existingProjects = await fetchExistingProjects();
  console.log(`[bulk-import] ${existingProjects.size} existing projects in monday.com`);

  const newQuotes = quotes.filter(q => {
    const num = q.barcode || (q.name || '').match(/^\d{2}-\d+/)?.[0];
    if (!num) return true;
    return !existingProjects.has(num.toLowerCase());
  });

  // Collect existing projects that have no budget — Vibe-created projects land here
  const budgetBackfillQueue = quotes.filter(q => {
    const num = q.barcode || (q.name || '').match(/^\d{2}-\d+/)?.[0];
    if (!num) return false;
    const existing = existingProjects.get(num.toLowerCase());
    return existing && !existing.hasBudget;
  });

  const alreadyExists = quotes.length - newQuotes.length;
  console.log(`[bulk-import] ${newQuotes.length} new quotes to import (${alreadyExists} already in monday.com, ${budgetBackfillQueue.length} need budget backfill)`);

  const toProcess = newQuotes.slice(0, limit);
  const truncated = newQuotes.length > limit;

  if (dryRun) console.log('[bulk-import] 🔍 DRY RUN — processing without writing...');

  // ── PHASE 3: Process in batches ──────────────────────────────────────────
  const results = { created: [], skipped: [], errors: [], dryRun: [] };
  const options = { dryRun, resolveContacts };

  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    console.log(`[bulk-import] Batch ${Math.floor(i / batchSize) + 1} — processing ${batch.length} quotes`);

    const batchResults = await Promise.all(batch.map(q => processQuote(q, options)));

    for (const r of batchResults) {
      if      (r.status === 'created')  results.created.push(r);
      else if (r.status === 'dry-run')  results.dryRun.push(r);
      else if (r.status === 'skipped')  results.skipped.push(r);
      else                              results.errors.push(r);
    }

    if (i + batchSize < toProcess.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── PHASE 3.5: Budget backfill for existing projects missing Estimated Budget ──
  // Catches projects created via Vibe app (create-folder flow) that never got a
  // totalPrice written because the quote was priced after the project was created.
  const backfillResults = { updated: [], skipped: [], errors: [] };
  if (budgetBackfillQueue.length > 0 && !dryRun) {
    console.log(`[bulk-import] Phase 3.5: Backfilling budget for ${budgetBackfillQueue.length} projects...`);

    for (const q of budgetBackfillQueue) {
      const num      = q.barcode || (q.name || '').match(/^\d{2}-\d+/)?.[0];
      const existing = existingProjects.get(num?.toLowerCase());
      const quoteId  = q.id || q.elementId || q.uuid;

      if (!existing?.id || !quoteId) {
        backfillResults.skipped.push({ flexNum: num, reason: 'missing item ID or quote UUID' });
        continue;
      }

      try {
        // Fetch just totalPrice — fast single-field call
        const hd     = await flexGet(`/api/element/${quoteId}/header-data?codeList=totalPrice`);
        const budget = extractNumber(hd?.totalPrice);

        if (budget > 0) {
          await mondayRequest(`
            mutation {
              change_column_value(
                board_id:  ${PROJECTS_BOARD_ID},
                item_id:   ${existing.id},
                column_id: "${COL.estimatedBudget}",
                value:     ${JSON.stringify(String(budget))}
              ) { id }
            }
          `);
          console.log(`[bulk-import] 💰 Budget backfilled: ${num} → $${budget} (item ${existing.id})`);
          backfillResults.updated.push({ flexNum: num, itemId: existing.id, budget });
        } else {
          console.log(`[bulk-import] ⏩ Budget backfill skipped: ${num} — Flex reports $0`);
          backfillResults.skipped.push({ flexNum: num, reason: 'Flex totalPrice is $0' });
        }
      } catch (err) {
        console.error(`[bulk-import] ❌ Budget backfill error for ${num}:`, err.message);
        backfillResults.errors.push({ flexNum: num, reason: err.message });
      }
    }
    console.log(`[bulk-import] Phase 3.5 done — Backfilled: ${backfillResults.updated.length}, Skipped: ${backfillResults.skipped.length}, Errors: ${backfillResults.errors.length}`);
  }

  // ── PHASE 4: Build summary ────────────────────────────────────────────────
  const summary = {
    success:           true,
    dryRun,
    searchPrefix:      prefix,
    flexTotalResults:  allResults.length,
    flexQuotesFound:   quotes.length,
    hitSearchLimit:    hitLimit,
    alreadyInMonday:   alreadyExists,
    newQuotesFound:    newQuotes.length,
    processedThisRun:  toProcess.length,
    truncatedToLimit:  truncated,
    remainingToImport: truncated ? newQuotes.length - limit : 0,
    results: {
      created:         results.created.length,
      skipped:         results.skipped.length,
      errors:          results.errors.length,
      budgetBackfilled: backfillResults.updated.length,
      ...(dryRun && { preview: results.dryRun })
    },
    createdProjects:       results.created,
    skippedDetails:        results.skipped,
    errorDetails:          results.errors,
    budgetBackfillDetails: backfillResults.updated,
  };

  console.log(`[bulk-import] ✅ Done — Created: ${results.created.length}, Skipped: ${results.skipped.length}, Budget Backfilled: ${backfillResults.updated.length}, Errors: ${results.errors.length}`);
  return summary;
}
