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
 * Body (all fields optional):
 * {
 *   "prefix":          "26-",    // Flex search term — default "26-"
 *   "maxResults":      200,      // Flex results per page — default 200
 *   "includeClosed":   false,    // Include closed/past events — default false
 *   "dryRun":          false,    // true = analyze only, don't write to monday
 *   "resolveContacts": true,     // false = skip contact lookups (faster) — default true
 *   "batchSize":       5,        // Parallel project creates per wave — default 5
 *   "limit":           30        // Max new projects to import per run — default 30
 * }
 *
 * Author: Matt James, Antic Studios
 * Created: July 2026 — bulk companion to create-project-from-quote.js
 */

export const config = { api: { bodyParser: true } };

// ── Environment ───────────────────────────────────────────────────────────────
const FLEX_BASE_URL   = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY    = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;
const MONDAY_API_URL  = 'https://api.monday.com/v2';
const MONDAY_API_KEY  = process.env.MONDAY_API_KEY;
const PM_DEFAULT_ID   = process.env.PM_DEFAULT_MONDAY_USER_ID || '102097223';

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
  clientNameText:    'text_mm435rt8',
  venueNameText:     'text_mm43r22q',
  handoffStage:      'color_mm43yjp9',   // "New" label
  accountManager:    'multiple_person_mm3xmbb2',
  pullsheetStatus:   'color_mm3y3bxj',   // "Not Synced"
  projectPhase:      'color_mm3x4534',   // "Design"
};

// ── Domain Classifier (mirrors create-project-from-quote.js) ─────────────────
function classifyDomain(result) {
  const domain = (result.domainId || result.domain || result.type || '').toLowerCase();
  if (['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain))             return 'equipment-list';
  if (['project', 'event-folder', 'event_folder', 'folder'].includes(domain))    return 'event-folder';
  if (['quote', 'financial-document', 'financial_document', 'financialdocument'].includes(domain)) return 'quote';
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

// ── Find existing contact item in monday Contacts board by name ───────────────
async function findContactInMonday(name) {
  if (!name || name.includes('Unknown')) return null;
  const safe = name.trim().replace(/"/g, '\\"');
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
    const exact = items.find(i => i.name.trim().toLowerCase() === name.trim().toLowerCase());
    return exact ? exact.id : null;
  } catch {
    return null;
  }
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

// ── Bulk-fetch all existing Flex numbers already in Projects board ─────────────
// Returns a Set of strings for O(1) de-dupe lookups.
async function fetchExistingFlexNumbers() {
  const existing = new Set();
  let cursor = null;

  do {
    const cursorClause = cursor ? `, cursor: "${cursor}"` : '';
    const data = await mondayRequest(`
      query {
        boards(ids: [${PROJECTS_BOARD_ID}]) {
          items_page(limit: 500${cursorClause}) {
            cursor
            items {
              column_values(ids: ["${COL.flexProjectNum}"]) { text }
            }
          }
        }
      }
    `);
    const page = data?.boards?.[0]?.items_page;
    for (const item of (page?.items || [])) {
      const val = item.column_values?.[0]?.text?.trim();
      if (val) existing.add(val.toLowerCase());
    }
    cursor = page?.cursor || null;
  } while (cursor);

  return existing;
}

// ── Fetch header data for a quote UUID ────────────────────────────────────────
async function fetchHeaderData(quoteUUID) {
  return flexGet(`/api/element/${quoteUUID}/header-data`);
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
  const quoteName  = quoteResult.name || quoteResult.displayName || '(unnamed)';
  const quoteUUID  = quoteResult.id   || quoteResult.elementId   || quoteResult.uuid;
  const flexNum    = quoteResult.name?.match(/^\d{2}-\d+/)?.[0] || quoteName;

  console.log(`[bulk-import] Processing: "${quoteName}" (UUID: ${quoteUUID})`);

  try {
    // ── Fetch header data ──────────────────────────────────────────────────
    const hd = await fetchHeaderData(quoteUUID);

    // ── Extract dates ──────────────────────────────────────────────────────
    const eventDate  = toMondayDate(hd.eventDate  || hd.showStartDate);
    const prepDate   = toMondayDate(hd.prepDate   || hd.loadInDate);
    const returnDate = toMondayDate(hd.returnDate || hd.loadOutDate);
    const today      = new Date().toISOString().split('T')[0];

    // Skip events in the past (eventDate < today)
    if (eventDate && eventDate < today) {
      console.log(`[bulk-import] ⏩ Skipping past event: "${quoteName}" (${eventDate})`);
      return { status: 'skipped', name: quoteName, flexNum, reason: `past event (${eventDate})` };
    }

    // ── Extract budget ─────────────────────────────────────────────────────
    const budget = extractNumber(hd.budgetedRevenue || hd.resolvedBudgetedRevenue);

    // ── Resolve Event Folder UUID (parent) ─────────────────────────────────
    let eventFolderUUID = extractUuid(hd.parentElementId) || extractUuid(hd.data?.parentElementId);
    if (!eventFolderUUID) {
      try {
        const elem = await flexGet(`/api/element/${quoteUUID}`);
        eventFolderUUID = extractUuid(elem.parentElementId) || extractUuid(elem.data?.parentElementId);
      } catch { /* continue without folder UUID */ }
    }

    // ── Resolve Equipment List UUID ────────────────────────────────────────
    const equipListUUID = await findEquipmentListUUID(quoteUUID);

    // ── Extract contact UUIDs from header data ─────────────────────────────
    const clientUUID = extractUuid(hd.data?.client || hd.clientId);
    const venueUUID  = extractUuid(hd.data?.venue  || hd.venueId);

    // ── Resolve human-readable names ───────────────────────────────────────
    let clientName = deepExtractName(hd.data?.client) || deepExtractName(hd.clientName) || 'Unknown Client';
    let venueName  = deepExtractName(hd.data?.venue)  || deepExtractName(hd.venueName)  || 'Unknown Venue';

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
        findContactInMonday(clientName),
        findContactInMonday(venueName)
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
      [COL.clientNameText]:  clientName,
      [COL.venueNameText]:   venueName,
      [COL.handoffStage]:    { label: 'New' },
      [COL.pullsheetStatus]: { label: 'Not Synced' },
      [COL.projectPhase]:    { label: 'Design' },
      [COL.lastEquipSync]:   today,
      [COL.accountManager]:  { personsAndTeams: [{ id: parseInt(PM_DEFAULT_ID), kind: 'person' }] }
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
    return { status: 'created', name: projectName, flexNum, eventDate, budget, clientName, venueName, itemId };

  } catch (err) {
    console.error(`[bulk-import] ❌ Error on "${quoteName}":`, err.message);
    return { status: 'error', name: quoteName, flexNum, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ status: 'ok', endpoint: 'bulk-import-upcoming' });
  if (req.body?.challenge)      return res.status(200).json({ challenge: req.body.challenge });
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Use POST' });

  if (!FLEX_API_KEY)    return res.status(500).json({ error: 'FLEX_API_KEY not configured' });
  if (!MONDAY_API_KEY)  return res.status(500).json({ error: 'MONDAY_API_KEY not configured' });

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const prefix          = body.prefix          ?? '26-';
  const maxResults      = body.maxResults       ?? 200;
  const includeClosed   = body.includeClosed    ?? false;
  const dryRun          = body.dryRun           ?? false;
  const resolveContacts = body.resolveContacts  ?? true;
  const batchSize       = Math.min(body.batchSize ?? 5, 10); // cap at 10 for safety
  const limit           = body.limit            ?? 30;       // max new projects per run

  console.log(`[bulk-import] 🚀 Starting — prefix="${prefix}", maxResults=${maxResults}, dryRun=${dryRun}, resolveContacts=${resolveContacts}, limit=${limit}`);

  try {
    // ── PHASE 1: Discover quotes from Flex ────────────────────────────────
    console.log('[bulk-import] Phase 1: Searching Flex...');
    const allResults = await searchFlex(prefix, maxResults, includeClosed);
    const hitLimit   = allResults.length >= maxResults;

    // Filter to quotes only — we don't create projects for event folders or equipment lists
    const quotes = allResults.filter(r => classifyDomain(r) === 'quote');
    console.log(`[bulk-import] Found ${allResults.length} total Flex results → ${quotes.length} quotes`);

    // ── PHASE 2: De-dupe against existing Projects board ──────────────────
    console.log('[bulk-import] Phase 2: Loading existing Projects...');
    const existingNums = await fetchExistingFlexNumbers();
    console.log(`[bulk-import] ${existingNums.size} existing projects in monday.com`);

    const newQuotes = quotes.filter(q => {
      const num = (q.name || '').match(/^\d{2}-\d+/)?.[0];
      if (!num) return true; // no number extracted — include to be safe
      return !existingNums.has(num.toLowerCase());
    });

    const alreadyExists = quotes.length - newQuotes.length;
    console.log(`[bulk-import] ${newQuotes.length} new quotes to import (${alreadyExists} already in monday.com)`);

    // Apply per-run limit
    const toProcess = newQuotes.slice(0, limit);
    const truncated = newQuotes.length > limit;

    if (dryRun) {
      console.log('[bulk-import] 🔍 DRY RUN — processing without writing...');
    }

    // ── PHASE 3: Process in batches ────────────────────────────────────────
    const results   = { created: [], skipped: [], errors: [], dryRun: [] };
    const options   = { dryRun, resolveContacts };

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);
      console.log(`[bulk-import] Batch ${Math.floor(i / batchSize) + 1} — processing ${batch.length} quotes`);

      const batchResults = await Promise.all(batch.map(q => processQuote(q, options)));

      for (const r of batchResults) {
        if (r.status === 'created')  results.created.push(r);
        else if (r.status === 'dry-run')  results.dryRun.push(r);
        else if (r.status === 'skipped') results.skipped.push(r);
        else                              results.errors.push(r);
      }

      // Breathe between batches to avoid monday.com rate limits
      if (i + batchSize < toProcess.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // ── PHASE 4: Report ────────────────────────────────────────────────────
    const summary = {
      success:           true,
      dryRun,
      searchPrefix:      prefix,
      flexTotalResults:  allResults.length,
      flexQuotesFound:   quotes.length,
      hitSearchLimit:    hitLimit,        // true = raise maxResults or run again
      alreadyInMonday:   alreadyExists,
      newQuotesFound:    newQuotes.length,
      processedThisRun:  toProcess.length,
      truncatedToLimit:  truncated,       // true = run again to get the rest
      remainingToImport: truncated ? newQuotes.length - limit : 0,
      results: {
        created:  results.created.length,
        skipped:  results.skipped.length,  // past events filtered out
        errors:   results.errors.length,
        ...(dryRun && { preview: results.dryRun })
      },
      createdProjects: results.created,
      skippedDetails:  results.skipped,
      errorDetails:    results.errors
    };

    console.log(`[bulk-import] ✅ Done — Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);
    return res.status(200).json(summary);

  } catch (err) {
    console.error('[bulk-import] 💥 Fatal error:', err);
    return res.status(500).json({ error: 'Bulk import failed', details: err.message });
  }
}
