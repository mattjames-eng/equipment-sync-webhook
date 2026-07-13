/**
 * Monday → Flex Contact Sync (Push Direction)
 *
 * Fires when a contact is created or updated in the Contacts & Companies board.
 * Pushes the contact to Flex Rental Solutions and writes the Flex UUID back
 * to the "Flex Contact ID" column to complete the loop.
 *
 * Loop prevention:
 *   - If "Flex Contact ID" is already populated → contact came from Flex,
 *     so we UPDATE Flex rather than creating a duplicate.
 *   - If "Flex Contact ID" is empty → contact was created manually in Monday,
 *     so we CREATE in Flex and write the UUID back.
 *
 * Address handling:
 *   - On CREATE: send parsed address fields in the POST body
 *   - On UPDATE: fetch existing addresses via GET /api/address/contact-addresses,
 *     then PUT the first one (update in place) — never append
 *   - Duplicate cleanup: DELETE /api/address/contact-addresses/{contactId} with
 *     array of extra address IDs before updating
 *
 * Monday webhook events handled:
 *   - create_item  → creates new contact in Flex
 *   - change_column_value → updates existing contact in Flex (if linked)
 *
 * Author: Antic Studios — ShowFlow
 * Endpoint: POST /api/contacts/push-to-flex
 */

const MONDAY_API_URL  = 'https://api.monday.com/v2';
const MONDAY_API_KEY  = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL   = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY    = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const CONTACTS_BOARD_ID = '18415573401';

// Column IDs on Contacts & Companies board
const COL = {
  flexContactId:   'text_mm56w1vz',
  flexContactType: 'dropdown_mm56cf0c',
  companyType:     'dropdown_mm3vm6jh',
  address:         'long_text_mm3vkzc6',
  email:           'email_mm3vezw3',
  phone:           'phone_mm3vwfvj',
  usualContact:    'text_mm3vg7e8',
  accountNotes:    'long_text_mm4fc8h7',
};

// ================================================================
// HELPER: Parse a free-text address into Flex ContactAddress fields
// Handles formats like:
//   "1846 S Cochran Ave\nLos Angeles, CA 90019\nUS"
//   "1846 S Cochran Ave, Los Angeles, CA 90019"
//   "1846 S Cochran Ave" (street only)
// ================================================================
function parseAddress(raw) {
  if (!raw || !raw.trim()) return null;

  // Normalize: collapse multiple newlines, trim each line
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);

  // If only one line, try comma-splitting
  if (lines.length === 1 && lines[0].includes(',')) {
    const parts = lines[0].split(',').map(s => s.trim());
    lines.length = 0;
    lines.push(...parts);
  }

  const addr = {
    line1: '',
    city: '',
    stateOrProvince: '',
    postalCode: '',
    country: '',
    defaultShipping: true,
    defaultMailing: true,
  };

  // Line 0 → street
  addr.line1 = lines[0] || '';

  // Line 1 → "City, State ZIP" or "City, State, ZIP"
  if (lines[1]) {
    // Match: "Los Angeles, CA 90019" or "Los Angeles, California, 90019"
    const cityStateZip = lines[1].match(/^(.+?),\s*([A-Za-z\s]+?)\s*,?\s*(\d{5}(?:-\d{4})?)?$/);
    if (cityStateZip) {
      addr.city           = cityStateZip[1].trim();
      addr.stateOrProvince = cityStateZip[2].trim();
      addr.postalCode     = (cityStateZip[3] || '').trim();
    } else {
      // Fallback: treat whole line as city
      addr.city = lines[1];
    }
  }

  // Line 2 → country or ZIP if not already captured
  if (lines[2]) {
    const isZip = /^\d{5}(-\d{4})?$/.test(lines[2].trim());
    if (isZip && !addr.postalCode) {
      addr.postalCode = lines[2].trim();
    } else if (!isZip) {
      // Normalize country
      const c = lines[2].trim().toUpperCase();
      addr.country = (c === 'US' || c === 'USA' || c === 'UNITED STATES') ? 'United States' : lines[2].trim();
    }
  }

  return addr;
}

// ================================================================
// HELPER: Fetch existing Flex addresses for a contact
// GET /api/address/contact-addresses?contactId={id}
// Returns array of ContactAddress objects (may be empty)
// ================================================================
async function fetchFlexAddresses(flexContactId) {
  try {
    const res = await fetch(
      `${FLEX_BASE_URL}/api/address/contact-addresses?contactId=${encodeURIComponent(flexContactId)}`,
      { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`  ⚠️  fetchFlexAddresses error: ${e.message}`);
    return [];
  }
}

// ================================================================
// HELPER: Delete duplicate address records, keeping only keepId
// DELETE /api/address/contact-addresses/{contactId}  body: [id, id, ...]
// ================================================================
async function deleteFlexAddresses(flexContactId, idsToDelete) {
  if (!idsToDelete.length) return;
  console.log(`  🗑️  Deleting ${idsToDelete.length} duplicate address(es) for ${flexContactId}`);
  try {
    const res = await fetch(
      `${FLEX_BASE_URL}/api/address/contact-addresses/${flexContactId}`,
      {
        method: 'DELETE',
        headers: {
          'X-Auth-Token': FLEX_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(idsToDelete),
      }
    );
    if (!res.ok) console.warn(`  ⚠️  Delete addresses HTTP ${res.status}`);
    else console.log(`  ✅ Deleted duplicate addresses`);
  } catch (e) {
    console.warn(`  ⚠️  deleteFlexAddresses error: ${e.message}`);
  }
}

// ================================================================
// HELPER: Update an existing Flex address record in place
// PUT /api/address/contact-addresses/{contactId}/{addressId}
// ================================================================
async function updateFlexAddress(flexContactId, addressId, addrPayload) {
  const body = { ...addrPayload, id: addressId, contactId: flexContactId };
  const res = await fetch(
    `${FLEX_BASE_URL}/api/address/contact-addresses/${flexContactId}/${addressId}`,
    {
      method: 'PUT',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`  ⚠️  updateFlexAddress HTTP ${res.status}: ${txt}`);
  } else {
    console.log(`  ✅ Address updated in place (${addressId})`);
  }
}

// ================================================================
// HELPER: Create a new Flex address record
// POST /api/address/contact-addresses/{contactId}
// ================================================================
async function createFlexAddress(flexContactId, addrPayload) {
  const body = { ...addrPayload, contactId: flexContactId };
  const res = await fetch(
    `${FLEX_BASE_URL}/api/address/contact-addresses/${flexContactId}`,
    {
      method: 'POST',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`  ⚠️  createFlexAddress HTTP ${res.status}: ${txt}`);
  } else {
    console.log(`  ✅ Address created`);
  }
}

// ================================================================
// HELPER: Sync address for an existing Flex contact
// - Fetches current addresses
// - Deletes all but the first (dedup)
// - Updates the first in place, or creates if none exist
// ================================================================
async function syncFlexAddress(flexContactId, addrPayload) {
  if (!addrPayload) return;

  const existing = await fetchFlexAddresses(flexContactId);

  if (existing.length === 0) {
    // No address yet — create one
    await createFlexAddress(flexContactId, addrPayload);
  } else {
    // Keep the first record, delete the rest (duplicates)
    const [keep, ...extras] = existing;
    if (extras.length > 0) {
      await deleteFlexAddresses(flexContactId, extras.map(a => a.id));
    }
    // Update the keeper in place
    await updateFlexAddress(flexContactId, keep.id, addrPayload);
  }
}

// ================================================================
// HELPER: Fetch a page of Monday contacts that have NO Flex Contact ID
// ================================================================
async function getMondayItemsWithoutFlexId(cursor, limit) {
  const paginationClause = cursor
    ? `cursor: "${cursor}"`
    : `query_params: { rules: [{ column_id: "${COL.flexContactId}", compare_value: [], operator: is_empty }] }`;

  const query = `
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(
          limit: ${limit}
          ${paginationClause}
        ) {
          cursor
          items {
            id
            name
            column_values(ids: [
              "${COL.flexContactId}",
              "${COL.flexContactType}",
              "${COL.address}",
              "${COL.email}",
              "${COL.phone}",
              "${COL.usualContact}"
            ]) {
              id value text
            }
          }
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  const page = result.data?.boards?.[0]?.items_page;
  if (!page) throw new Error(`Monday items_page query failed: ${JSON.stringify(result.errors)}`);
  return {
    items: page.items || [],
    nextCursor: page.cursor || null,
  };
}

// ================================================================
// HELPER: Sync a single Monday contact to Flex (create + write UUID back)
// ================================================================
async function syncContactToFlex(item) {
  const columns = parseColumnValues(item.column_values);
  const existingFlexId = columns[COL.flexContactId]?.text?.trim();

  if (existingFlexId) {
    console.log(`⏭️ Skipping "${item.name}" — already linked (${existingFlexId})`);
    return { action: 'skipped', itemId: item.id, flexId: existingFlexId };
  }

  const payload = buildFlexPayload(item, columns, item.id);

  const existingByExternal = await findFlexContactByExternalNumber(item.id);
  if (existingByExternal) {
    console.log(`⚠️ Found existing Flex contact by externalNumber for "${item.name}" — linking`);
    await writeFlexIdToMonday(item.id, existingByExternal);
    return { action: 'linked', itemId: item.id, flexId: existingByExternal };
  }

  const flexId = await createFlexContact(payload);
  await writeFlexIdToMonday(item.id, flexId);
  return { action: 'created', itemId: item.id, flexId };
}

// ================================================================
// HELPER: Fetch full column values for a monday item
// ================================================================
async function getMondayItem(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        id
        name
        column_values(ids: [
          "${COL.flexContactId}",
          "${COL.flexContactType}",
          "${COL.address}",
          "${COL.email}",
          "${COL.phone}",
          "${COL.usualContact}"
        ]) {
          id
          value
          text
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  return result.data?.items?.[0] || null;
}

// ================================================================
// HELPER: Parse a monday column_values array into a flat key/value map
// ================================================================
function parseColumnValues(columnValues) {
  const map = {};
  for (const col of (columnValues || [])) {
    try {
      const parsed = col.value ? JSON.parse(col.value) : null;
      map[col.id] = { raw: col.value, text: col.text, parsed };
    } catch {
      map[col.id] = { raw: col.value, text: col.text, parsed: null };
    }
  }
  return map;
}

// ================================================================
// HELPER: Write Flex Contact ID back to Monday item
// ================================================================
async function writeFlexIdToMonday(itemId, flexUUID) {
  const columnValues = JSON.stringify({ [COL.flexContactId]: flexUUID });
  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${CONTACTS_BOARD_ID},
        item_id: ${itemId},
        column_values: ${JSON.stringify(columnValues)}
      ) { id }
    }
  `;
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await response.json();
  if (result.errors) {
    throw new Error(`Monday write-back failed: ${JSON.stringify(result.errors)}`);
  }
  console.log(`✅ Flex Contact ID written to Monday item ${itemId}: ${flexUUID}`);
}

// ================================================================
// HELPER: Build a Flex contact payload from Monday item data
// NOTE: addresses are NOT included here for updates — they are
// handled separately via syncFlexAddress() to avoid duplicates.
// For creates, addresses ARE included in the POST body (Flex creates
// the first address record as part of the contact creation).
// ================================================================
function buildFlexPayload(item, columns, mondayItemId, includeAddress = true) {
  const flexType    = columns[COL.flexContactType]?.text || '';
  const emailText   = columns[COL.email]?.text || '';
  const phoneText   = columns[COL.phone]?.text || '';
  const addressText = columns[COL.address]?.text || '';

  const payload = {
    name: item.name,
    organization: true,
    externalNumber: String(mondayItemId),
  };

  if (emailText) {
    payload.internetAddresses = [{ url: emailText, defaultEmail: true }];
  }

  if (phoneText) {
    const cleaned = phoneText.replace(/\s+/g, '').replace(/[()]/g, '');
    payload.phoneNumbers = [{ dialNumber: cleaned, defaultPhone: true }];
  }

  // Only include address in CREATE payloads — updates use syncFlexAddress()
  if (includeAddress && addressText) {
    const parsed = parseAddress(addressText);
    if (parsed) payload.addresses = [parsed];
  }

  payload.narrativeDescription = `Synced from ShowFlow monday.com | Type: ${flexType || 'Unknown'} | Item ID: ${mondayItemId}`;

  return payload;
}

// ================================================================
// HELPER: Create new contact in Flex
// ================================================================
async function createFlexContact(payload) {
  console.log(`📤 Creating Flex contact: "${payload.name}"`);
  const response = await fetch(`${FLEX_BASE_URL}/api/contact`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Flex create failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const flexId = data.id || data.data?.id;
  if (!flexId) throw new Error('Flex create returned no ID');
  console.log(`✅ Flex contact created: ${flexId}`);
  return flexId;
}

// ================================================================
// HELPER: Update existing contact in Flex (base fields only — no addresses)
// ================================================================
async function updateFlexContact(flexUUID, payload) {
  console.log(`📤 Updating Flex contact: ${flexUUID} ("${payload.name}")`);
  // Strip addresses from PUT body — handled separately via syncFlexAddress()
  const { addresses, ...basePayload } = payload;
  const bodyWithId = { ...basePayload, id: flexUUID };

  const response = await fetch(`${FLEX_BASE_URL}/api/contact/${flexUUID}?updateBaseContactOnly=true`, {
    method: 'PUT',
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(bodyWithId),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Flex update failed (${response.status}): ${errorText}`);
  }

  console.log(`✅ Flex contact updated: ${flexUUID}`);
}

// ================================================================
// HELPER: Search Flex for contact by externalNumber (monday item ID)
// ================================================================
async function findFlexContactByExternalNumber(mondayItemId) {
  try {
    const response = await fetch(
      `${FLEX_BASE_URL}/api/contact/search?searchText=${encodeURIComponent(String(mondayItemId))}&size=5`,
      { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const contacts = data.content || data.data || [];
    const match = contacts.find(c => c.externalNumber === String(mondayItemId));
    return match?.id || null;
  } catch (e) {
    console.log(`⚠️ Flex search by externalNumber failed: ${e.message}`);
    return null;
  }
}


// ================================================================
// CLEANUP ROUTE: address deduplication across all linked contacts
// GET  ?route=cleanup        — dry run (no changes)
// POST ?route=cleanup        — live delete
// GET  ?route=cleanup&page=N — paginate (25/page)
// ================================================================
const FLEX_UUID_COL_CLEANUP = 'text_mm56w1vz';
const CLEANUP_BATCH         = 25;
const CLEANUP_CONCURRENCY   = 5;

function scoreAddress(addr) {
  let score = 0;
  if (addr.defaultMailing)  score += 3;
  if (addr.defaultShipping) score += 2;
  for (const f of ['line1', 'city', 'stateOrProvince', 'postalCode', 'country']) {
    if (addr[f] && addr[f].trim()) score += 1;
  }
  return score;
}

function pickBestAddress(addresses) {
  return addresses.slice().sort((a, b) => {
    const diff = scoreScore(b) - scoreScore(a);
    if (diff !== 0) return diff;
    if (a.ordinal !== b.ordinal) return (a.ordinal ?? 999) - (b.ordinal ?? 999);
    return new Date(a.createdDate || 0) - new Date(b.createdDate || 0);
  })[0];
  function scoreScore(x) { return scoreAddress(x); }
}

async function getContactsWithFlexId(cursor, limit) {
  const clause = cursor
    ? `cursor: "${cursor}"`
    : `query_params: { rules: [{ column_id: "${FLEX_UUID_COL_CLEANUP}", compare_value: [], operator: is_not_empty }] }`;
  const q = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: ${limit} ${clause}) { cursor items { id name column_values(ids: ["${FLEX_UUID_COL_CLEANUP}"]) { id text } } } } }`;
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: q }),
  });
  const result = await res.json();
  const page = result.data?.boards?.[0]?.items_page;
  if (!page) throw new Error('Monday query failed: ' + JSON.stringify(result.errors));
  return { items: page.items || [], nextCursor: page.cursor || null };
}

async function cleanupOneContact(name, flexId, dryRun) {
  const addrs = await fetchFlexAddresses(flexId);
  if (addrs.length <= 1) return { name, flexId, status: 'ok', addressCount: addrs.length, deleted: 0 };
  const best   = pickBestAddress(addrs);
  const extras = addrs.filter(a => a.id !== best.id).map(a => a.id);
  if (dryRun) {
    return { name, flexId, status: 'would_delete', addressCount: addrs.length,
      kept: { id: best.id, line1: best.line1, city: best.city, score: scoreAddress(best) },
      deleted: extras.length };
  }
  await deleteFlexAddresses(flexId, extras);
  return { name, flexId, status: 'cleaned', addressCount: addrs.length,
    kept: { id: best.id, line1: best.line1, city: best.city, score: scoreAddress(best) },
    deleted: extras.length };
}

async function handleCleanupRoute(req, res) {
  const dryRun = req.method === 'GET';
  const page   = parseInt(req.query && req.query.page ? req.query.page : '1');
  console.log('\n🧹 cleanup | mode: ' + (dryRun ? 'DRY RUN' : 'LIVE') + ' | page: ' + page);

  let cursor = null, pageNum = 0;
  while (true) {
    pageNum++;
    const { items, nextCursor } = await getContactsWithFlexId(cursor, CLEANUP_BATCH);
    if (pageNum === page) {
      const results = [];
      for (let i = 0; i < items.length; i += CLEANUP_CONCURRENCY) {
        const chunk = items.slice(i, i + CLEANUP_CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(c => {
          const flexId = (c.column_values.find(v => v.id === FLEX_UUID_COL_CLEANUP) || {}).text;
          const fid = flexId && flexId.trim();
          if (!fid) return Promise.resolve({ name: c.name, status: 'no_uuid', deleted: 0 });
          return cleanupOneContact(c.name, fid, dryRun);
        }));
        settled.forEach(r => results.push(r.status === 'fulfilled' ? r.value : { status: 'exception', error: r.reason && r.reason.message }));
      }
      const totalDeleted = results.reduce((s, r) => s + (r.deleted || 0), 0);
      const hasMore = items.length === CLEANUP_BATCH && !!nextCursor;
      return res.status(200).json({
        mode: dryRun ? 'dry_run' : 'live', page, hasMore, nextPage: hasMore ? page + 1 : null,
        summary: {
          contactsProcessed: results.length,
          alreadyClean:  results.filter(r => r.status === 'ok').length,
          deduplicated:  results.filter(r => r.status === 'cleaned' || r.status === 'would_delete').length,
          addressesRemoved: totalDeleted,
          errors: results.filter(r => ['fetch_error','delete_error','exception'].includes(r.status)).length,
        },
        detail: results,
      });
    }
    if (!nextCursor || items.length < CLEANUP_BATCH) {
      return res.status(200).json({
        mode: dryRun ? 'dry_run' : 'live', page, hasMore: false, nextPage: null,
        summary: { contactsProcessed: 0, alreadyClean: 0, deduplicated: 0, addressesRemoved: 0, errors: 0 },
        detail: [], message: 'Only ' + (pageNum - 1) + ' page(s) available',
      });
    }
    cursor = nextCursor;
  }
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── CLEANUP ROUTE ─────────────────────────────────────────────
  if (req.query && req.query.route === 'cleanup') {
    try { return await handleCleanupRoute(req, res); }
    catch (err) { console.error('❌ cleanup error:', err); return res.status(500).json({ error: err.message }); }
  }


  // ── BULK SYNC MODE ──────────────────────────────────────────────
  if (req.method === 'GET' && req.query?.bulk === 'true') {
    const cursor    = req.query.cursor   || null;
    const batchSize = Math.min(parseInt(req.query.batchSize) || 10, 20);

    console.log(`\n📦 Bulk push-to-flex | cursor: ${cursor || 'start'} | batchSize: ${batchSize}`);

    try {
      const { items, nextCursor } = await getMondayItemsWithoutFlexId(cursor, batchSize);
      console.log(`📋 Found ${items.length} contacts without Flex UUID`);

      const results = await Promise.allSettled(items.map(item => syncContactToFlex(item)));

      const successes = [];
      const errors    = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          successes.push(r.value);
        } else {
          errors.push({ itemId: items[i].id, name: items[i].name, error: r.reason?.message });
          console.error(`❌ Failed "${items[i].name}" (${items[i].id}): ${r.reason?.message}`);
        }
      });

      const hasMore = items.length === batchSize && !!nextCursor;

      console.log(`✅ Batch done: ${successes.length} synced, ${errors.length} errors, hasMore: ${hasMore}`);

      return res.status(200).json({
        processed:   successes.length,
        errors,
        hasMore,
        nextCursor:  hasMore ? nextCursor : null,
        batchDetail: successes,
      });

    } catch (err) {
      console.error(`❌ Bulk sync error:`, err);
      return res.status(500).json({ error: err.message });
    }
  }

  // monday.com webhook challenge handshake
  if (req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const event = body?.event;
  if (!event) return res.status(400).json({ error: 'Missing event data' });

  const itemId = event.pulseId || event.itemId;
  if (!itemId) return res.status(400).json({ error: 'Missing item ID in event' });

  const boardId = String(event.boardId || '');
  if (boardId && boardId !== CONTACTS_BOARD_ID) {
    console.log(`⏭️ Skipping — event from board ${boardId}, not Contacts board`);
    return res.status(200).json({ skipped: true, reason: 'wrong board' });
  }

  console.log(`\n🚀 push-to-flex triggered | event: ${event.type} | item: ${itemId}`);

  try {
    const item = await getMondayItem(itemId);
    if (!item) {
      console.log(`⚠️ Item ${itemId} not found in Monday — may have been deleted`);
      return res.status(200).json({ skipped: true, reason: 'item not found' });
    }

    const columns        = parseColumnValues(item.column_values);
    const existingFlexId = columns[COL.flexContactId]?.text?.trim();
    const addressText    = columns[COL.address]?.text || '';

    console.log(`📋 Item: "${item.name}" | Existing Flex ID: ${existingFlexId || 'none'}`);

    if (existingFlexId) {
      // ── UPDATE path ──────────────────────────────────────────
      // Build payload WITHOUT address (handled separately)
      const payload = buildFlexPayload(item, columns, itemId, false);
      await updateFlexContact(existingFlexId, payload);

      // Sync address separately: dedup + update in place
      const addrPayload = parseAddress(addressText);
      await syncFlexAddress(existingFlexId, addrPayload);

      return res.status(200).json({ ok: true, action: 'updated', flexId: existingFlexId, itemId });

    } else {
      // ── CREATE path ──────────────────────────────────────────
      // Address included in POST body (Flex creates it as part of contact)
      const result = await syncContactToFlex(item);
      return res.status(200).json({ ok: true, ...result });
    }

  } catch (err) {
    console.error(`❌ push-to-flex error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
