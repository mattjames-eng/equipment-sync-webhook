/**
 * Flex → Monday Contact Sync (Pull Direction)
 *
 * Polls Flex Rental Solutions for contacts created or modified since the
 * last sync run, then creates or updates matching items in the
 * Contacts & Companies board in monday.com.
 *
 * Loop prevention:
 *   - When a Monday item was created by THIS endpoint, the monday item ID
 *     is stored in Flex's `externalNumber` field.  On subsequent polls we
 *     match on that field and UPDATE instead of creating duplicates.
 *   - When a Flex contact was created by the push-to-flex endpoint, the
 *     Flex UUID is already stored in the Monday "Flex Contact ID" column,
 *     so we simply UPDATE those items.
 *
 * Lookback window:
 *   - Default: 24 hours (suitable for the daily 9 AM cron job)
 *   - Override via ?hours=N query param or body { hours: N }
 *   - Pass ?full=true to re-sync ALL Flex contacts regardless of lastEditDate
 *     (use sparingly — will touch every contact)
 *
 * Invocation options:
 *   POST /api/contacts/pull-from-flex               → 24h lookback
 *   POST /api/contacts/pull-from-flex?hours=1       → 1h lookback (15-min cron)
 *   POST /api/contacts/pull-from-flex?full=true     → full resync
 *   GET  /api/contacts/pull-from-flex               → health check
 *
 * Author: Antic Studios — ShowFlow
 */

const MONDAY_API_URL  = 'https://api.monday.com/v2';
const MONDAY_API_KEY  = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL   = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY    = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const CONTACTS_BOARD_ID   = '18415573401';
const NEW_ADDITIONS_GROUP = 'group_mm3y3xvh';  // 🤝 NEW ADDITIONS — top group
const VENUES_GROUP        = 'group_mm3v505y';  // Venues

// Column IDs on Contacts & Companies board
const COL = {
  flexContactId:   'text_mm56w1vz',
  flexContactType: 'dropdown_mm56cf0c',
  address:         'long_text_mm3vkzc6',
  email:           'email_mm3vezw3',
  phone:           'phone_mm3vwfvj',
  usualContact:    'text_mm3vg7e8',
};

// ================================================================
// HELPER: Fetch a page of Flex contacts, optionally filtered by date
// Flex contacts are sorted by lastEditDate descending so newest first.
// ================================================================
async function fetchFlexContacts(sinceISO, page = 0, size = 100) {
  let url = `${FLEX_BASE_URL}/api/contact?page=${page}&size=${size}&sort=lastEditDate,desc`;
  console.log(`📥 Fetching Flex contacts page ${page} since ${sinceISO || 'beginning of time'}`);

  const response = await fetch(url, {
    headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Flex contact list failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const contacts = data.content || data.data || [];
  const totalPages = data.totalPages ?? (contacts.length < size ? 1 : null);

  // If sinceISO is set, filter client-side by lastEditDate
  // (Flex doesn't support date range filtering on the list endpoint)
  const filtered = sinceISO
    ? contacts.filter(c => {
        if (!c.lastEditDate) return false;
        return new Date(c.lastEditDate) > new Date(sinceISO);
      })
    : contacts;

  return { contacts: filtered, totalPages, rawCount: contacts.length };
}

// ================================================================
// HELPER: Fetch a single Flex contact with all nested resources
// (addresses, phones, internetAddresses)
// ================================================================
async function fetchFlexContactFull(flexId) {
  const response = await fetch(`${FLEX_BASE_URL}/api/contact/${flexId}`, {
    headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' },
  });
  if (!response.ok) return null;
  return response.json();
}

// ================================================================
// HELPER: Find existing Monday item by Flex Contact ID column value
// ================================================================
async function findMondayItemByFlexId(flexUUID) {
  const query = `
    query {
      items_page_by_column_values(
        limit: 5,
        board_id: ${CONTACTS_BOARD_ID},
        columns: [{ column_id: "${COL.flexContactId}", column_values: ["${flexUUID}"] }]
      ) { items { id name } }
    }
  `;
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  const items = result.data?.items_page_by_column_values?.items || [];
  return items[0] || null;
}

// ================================================================
// HELPER: Find existing Monday item by name (fuzzy fallback)
// ================================================================
async function findMondayItemByName(name) {
  if (!name || name.trim() === '') return null;
  const safe = name.trim().replace(/"/g, '\\"');
  const query = `
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: 20, query_params: { term: "${safe}" }) {
          items { id name }
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
  const items = result.data?.boards?.[0]?.items_page?.items || [];
  const exact = items.find(i => i.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact || null;
}

// ================================================================
// HELPER: Build Monday column_values JSON from a Flex contact object
// ================================================================
function buildMondayColumnValues(flexContact) {
  const cols = {};

  // Always stamp the Flex UUID
  cols[COL.flexContactId] = flexContact.id;

  // Email — grab the defaultEmail or first entry
  const emailObj = flexContact.internetAddresses?.find(e => e.defaultEmail) ||
                   flexContact.internetAddresses?.[0];
  if (emailObj?.url && emailObj.url.includes('@')) {
    cols[COL.email] = JSON.stringify({ email: emailObj.url, text: emailObj.url });
  }

  // Phone — grab the defaultPhone or first entry
  const phoneObj = flexContact.phoneNumbers?.find(p => p.defaultPhone) ||
                   flexContact.phoneNumbers?.[0];
  if (phoneObj?.dialNumber) {
    const phone = phoneObj.dialNumber.replace(/[^0-9+]/g, '');
    cols[COL.phone] = JSON.stringify({ phone, countryShortName: 'US' });
  }

  // Address — build from first shipping address or first available
  const addrObj = flexContact.addresses?.find(a => a.defaultShipping) ||
                  flexContact.addresses?.[0];
  if (addrObj) {
    const parts = [
      addrObj.line1,
      addrObj.line2,
      addrObj.line3,
      [addrObj.city, addrObj.stateOrProvince, addrObj.postalCode].filter(Boolean).join(', '),
      addrObj.country,
    ].filter(Boolean);
    if (parts.length > 0) {
      cols[COL.address] = JSON.stringify(parts.join('\n'));
    }
  }

  return JSON.stringify(cols);
}

// ================================================================
// HELPER: Determine which Monday group a new contact should land in
// based on whatever type info we have from Flex
// ================================================================
function resolveGroupForFlexContact(flexContact) {
  // Check the narrativeDescription for type hints (set by push-to-flex)
  const notes = (flexContact.narrativeDescription || '').toLowerCase();
  if (notes.includes('type: venue')) return VENUES_GROUP;
  // Default all others to NEW ADDITIONS — Bertha will sort them
  return NEW_ADDITIONS_GROUP;
}

// ================================================================
// HELPER: Create a new item in the Contacts & Companies board
// ================================================================
async function createMondayContact(flexContact) {
  const name = (flexContact.name || flexContact.preferredDisplayString || 'Unknown').replace(/"/g, '\\"');
  const groupId = resolveGroupForFlexContact(flexContact);
  const columnValues = buildMondayColumnValues(flexContact);

  const mutation = `
    mutation {
      create_item(
        board_id: ${CONTACTS_BOARD_ID},
        group_id: "${groupId}",
        item_name: "${name}",
        column_values: ${JSON.stringify(columnValues)}
      ) { id name }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await response.json();

  if (result.errors) throw new Error(`Monday create failed: ${JSON.stringify(result.errors)}`);
  const created = result.data?.create_item;
  console.log(`✅ Created Monday item: "${created?.name}" (ID: ${created?.id})`);

  // Write monday item ID back to Flex externalNumber for future dedup
  if (created?.id) {
    await writeExternalNumberToFlex(flexContact.id, created.id);
  }

  return created;
}

// ================================================================
// HELPER: Update an existing Monday item with fresh Flex data
// ================================================================
async function updateMondayContact(mondayItemId, flexContact) {
  const columnValues = buildMondayColumnValues(flexContact);
  const name = (flexContact.name || '').replace(/"/g, '\\"');

  // Update name if it has changed
  const nameMutation = name ? `
    update_item: change_item_value(board_id: ${CONTACTS_BOARD_ID}, item_id: ${mondayItemId}, column_id: "name", value: "${name}") { id }
  ` : '';

  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${CONTACTS_BOARD_ID},
        item_id: ${mondayItemId},
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
    console.error(`❌ Monday update failed for item ${mondayItemId}:`, result.errors);
  } else {
    console.log(`🔄 Updated Monday item ${mondayItemId} from Flex ${flexContact.id}`);
  }
}

// ================================================================
// HELPER: Write monday item ID back to Flex externalNumber
// This is what makes Flex the dedup-aware side in future polls
// ================================================================
async function writeExternalNumberToFlex(flexId, mondayItemId) {
  try {
    const response = await fetch(`${FLEX_BASE_URL}/api/contact/${flexId}?updateBaseContactOnly=true`, {
      method: 'PUT',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ externalNumber: String(mondayItemId) }),
    });
    if (response.ok) {
      console.log(`🔗 Flex externalNumber set for ${flexId} → monday item ${mondayItemId}`);
    } else {
      console.log(`⚠️ Could not set Flex externalNumber for ${flexId}: ${response.status}`);
    }
  } catch (e) {
    console.log(`⚠️ Flex externalNumber write failed: ${e.message}`);
  }
}

// ================================================================
// HELPER: Process a single Flex contact — create or update in Monday
// ================================================================
async function processFlexContact(flexContact) {
  const flexId = flexContact.id;
  const name   = flexContact.name || flexContact.preferredDisplayString || null;

  if (!flexId) {
    console.log('⚠️ Skipping Flex contact with no ID');
    return { action: 'skipped', reason: 'no id' };
  }

  // Skip soft-deleted contacts
  if (flexContact.deleted) {
    console.log(`🗑️ Skipping deleted Flex contact: ${flexId}`);
    return { action: 'skipped', reason: 'deleted' };
  }

  console.log(`\n▶ Processing: "${name}" (Flex: ${flexId})`);

  // 1. Check if we have a Monday item already linked to this Flex UUID
  let mondayItem = await findMondayItemByFlexId(flexId);

  if (mondayItem) {
    // Known contact — update
    console.log(`  → Existing Monday item found: ${mondayItem.id} ("${mondayItem.name}")`);
    await updateMondayContact(mondayItem.id, flexContact);
    return { action: 'updated', flexId, mondayId: mondayItem.id, name };
  }

  // 2. Check if externalNumber points to a Monday item (set during a previous create)
  if (flexContact.externalNumber) {
    const byExternal = await findMondayItemByFlexId(flexId);
    if (byExternal) {
      console.log(`  → Matched via externalNumber: ${byExternal.id}`);
      await updateMondayContact(byExternal.id, flexContact);
      return { action: 'updated', flexId, mondayId: byExternal.id, name };
    }
  }

  // 3. Fuzzy name match as last resort before creating
  if (name) {
    const byName = await findMondayItemByName(name);
    if (byName) {
      console.log(`  → Matched by name: ${byName.id} ("${byName.name}") — linking and updating`);
      // Fetch full contact details for column population
      const fullContact = await fetchFlexContactFull(flexId) || flexContact;
      await updateMondayContact(byName.id, fullContact);
      // Write Flex externalNumber back to Flex for future dedup
      await writeExternalNumberToFlex(flexId, byName.id);
      return { action: 'linked', flexId, mondayId: byName.id, name };
    }
  }

  // 4. Genuinely new — fetch full details and create in Monday
  console.log(`  → No match found — creating new Monday contact`);
  const fullContact = await fetchFlexContactFull(flexId) || flexContact;
  const created = await createMondayContact(fullContact);
  return { action: 'created', flexId, mondayId: created?.id, name };
}

// ================================================================
// MAIN HANDLER
// ================================================================
// ============================================================================
// PO SYNC — Flex Rental POs (RPO-) and Purchase POs (PPO-) → monday.com
// Route: POST /api/contacts/pull-from-flex?route=pos
// URL alias: POST /api/pos/pull-from-flex  (via vercel.json rewrite)
// ============================================================================

// ── Board / Group IDs ─────────────────────────────────────────────────────────
const RENTAL_PO_BOARD_ID      = '18421660479';
const RENTAL_PO_ACTIVE_GROUP  = 'group_mm57c3y5';  // Active
const RENTAL_PO_DONE_GROUP    = 'group_mm578khs';  // Completed
const RENTAL_PO_HOLD_GROUP    = 'group_mm57k644';  // On Hold

const PURCHASE_PO_BOARD_ID     = '18421660481';
const PURCHASE_PO_ACTIVE_GROUP = 'group_mm57nqk9'; // Active
const PURCHASE_PO_DONE_GROUP   = 'group_mm57vjj2'; // Received
const PURCHASE_PO_HOLD_GROUP   = 'group_mm57hrnr'; // On Hold

// ── Rental PO Column IDs ──────────────────────────────────────────────────────
const RPO_COL = {
  docNumber:    'text_mm5797r7',
  status:       'color_mm57je6p',
  project:      'board_relation_mm571y7r',
  vendor:       'board_relation_mm573b8h',
  dateExpected: 'date_mm57vxxc',
  returnDate:   'date_mm57xda8',
  period:       'timerange_mm579gb8',
  notes:        'long_text_mm57w1p6',
  flexUUID:     'text_mm5738bk',
  lastSynced:   'date_mm57djxq',
  total:        'numeric_mm573mez',
};

// ── Purchase PO Column IDs ────────────────────────────────────────────────────
const PPO_COL = {
  docNumber:        'text_mm579qkq',
  status:           'color_mm57m944',
  project:          'board_relation_mm577rxk',
  vendor:           'board_relation_mm5782gc',
  expectedDelivery: 'date_mm5733jm',
  notes:            'long_text_mm57webg',
  flexUUID:         'text_mm572tag',
  lastSynced:       'date_mm57d9pj',
  total:            'numeric_mm57ps47',
};

const PROJECTS_BOARD_ID = '18415679761';
// CONTACTS_BOARD_ID already defined at top of file

// ── Projects board UUID columns (used for parentId-based project lookup) ────────
// Flex POs have a parentId pointing to either the Quote or the Pullsheet.
// We try to match that UUID against these two columns before falling back to name.
const PROJ_QUOTE_UUID_COL = 'text_mm4cwasc';  // Quote UUID
const PROJ_EQUIP_UUID_COL = 'text_mm3y7xwa';  // Equipment List / Pullsheet UUID

// Flex headerFieldTypeIds that the list-row-data endpoint accepts.
// 'plannedEndDate' is requested explicitly because it is not in the default payload.
// Labor POs (and any other non-RPO/PPO doc types) are skipped client-side by prefix.
const FLEX_PO_FIELD_TYPES = [
  'name', 'documentNumber', 'statusId', 'vendorCompany',
  'plannedStartDate', 'plannedEndDate',
].join(',');

// ── Flex status name → monday status label ────────────────────────────────────
function _mapRPOStatus(s) {
  s = (s || '').toLowerCase();
  if (s.includes('tentative'))                              return 'Tentative';
  if (s.includes('confirmed'))                              return 'Confirmed';
  if (s.includes('active') || s.includes('out'))            return 'Active / Out';
  if (s.includes('return') || s.includes('complete') || s.includes('received')) return 'Returned';
  if (s.includes('closed') || s.includes('cancel'))         return 'Closed';
  if (s.includes('hold'))                                   return 'On Hold';
  return 'Tentative';
}

function _mapPPOStatus(s) {
  s = (s || '').toLowerCase();
  if (s.includes('tentative') || s.includes('draft'))       return 'Draft';
  if (s.includes('submit'))                                 return 'Submitted';
  if (s.includes('order') || s.includes('confirmed'))       return 'Ordered';
  if (s.includes('expect'))                                 return 'Expected';
  if (s.includes('receiv') || s.includes('complete'))       return 'Received';
  if (s.includes('closed') || s.includes('cancel'))         return 'Closed';
  return 'Draft';
}

function _resolveRPOGroup(statusLabel) {
  if (['Returned','Closed'].includes(statusLabel)) return RENTAL_PO_DONE_GROUP;
  if (['On Hold'].includes(statusLabel))           return RENTAL_PO_HOLD_GROUP;
  return RENTAL_PO_ACTIVE_GROUP;
}

function _resolvePPOGroup(statusLabel) {
  if (['Received','Closed'].includes(statusLabel)) return PURCHASE_PO_DONE_GROUP;
  return PURCHASE_PO_ACTIVE_GROUP;
}

// Extract "{Project Name}" from "{Vendor} - {Project Name}" convention
function _extractProjectName(poName) {
  const idx = (poName || '').indexOf(' - ');
  if (idx === -1) return null;
  const name = poName.substring(idx + 3).trim();
  return name.length > 0 ? name : null;
}

function _formatDate(iso) {
  return iso ? iso.substring(0, 10) : null;
}

// Fetch the total dollar amount for a Flex document.
// GET /api/financial-document/{documentId}/document-total → plain number
async function _fetchFlexPOTotal(documentId) {
  try {
    const url = `${FLEX_BASE_URL}/api/financial-document/${documentId}/document-total`;
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`  ⚠️  Could not fetch total for ${documentId}: HTTP ${res.status}`);
      return null;
    }
    const val = await res.json();
    return typeof val === 'number' ? val : null;
  } catch (e) {
    console.warn(`  ⚠️  Total fetch error for ${documentId}:`, e.message);
    return null;
  }
}

// Caches to avoid repeated monday lookups within a single sync run
const _poProjectUUIDCache = {};  // parentId (UUID) → monday item id
const _poProjectNameCache = {};  // parsed project name → monday item id
const _poVendorCache      = {};

// ── Primary: match by parentId UUID against Projects board UUID columns ────────
// Flex POs have parentId = UUID of either the parent Quote or parent Pullsheet.
// We try Quote UUID column first, then Equipment List UUID column.
async function _findProjectByParentUUID(parentId) {
  if (!parentId) return null;
  if (_poProjectUUIDCache[parentId] !== undefined) return _poProjectUUIDCache[parentId];

  for (const colId of [PROJ_QUOTE_UUID_COL, PROJ_EQUIP_UUID_COL]) {
    const result = await mondayQueryPO(`
      query {
        items_page_by_column_values(
          limit: 3, board_id: ${PROJECTS_BOARD_ID},
          columns: [{ column_id: "${colId}", column_values: ["${parentId}"] }]
        ) { items { id name } }
      }
    `);
    const match = result.data?.items_page_by_column_values?.items?.[0] || null;
    if (match) {
      console.log(`  🔗 Project via UUID (${colId === PROJ_QUOTE_UUID_COL ? 'Quote' : 'Pullsheet'}): "${match.name}"`);
      _poProjectUUIDCache[parentId] = parseInt(match.id);
      return _poProjectUUIDCache[parentId];
    }
  }

  _poProjectUUIDCache[parentId] = null;
  return null;
}

// ── Fallback: match by parsed name when UUID lookup finds nothing ──────────────
// Name convention: "{Vendor abbrev} - {Project Name}"
// e.g. "Legacy - Nocturnal Valley 2026" → search for "Nocturnal Valley 2026"
async function _findProjectByNameFallback(poName) {
  const parsedName = _extractProjectName(poName);
  if (!parsedName) return null;
  const key = parsedName.toLowerCase().trim();
  if (_poProjectNameCache[key] !== undefined) return _poProjectNameCache[key];
  const safe = parsedName.replace(/"/g, '\\"');
  const result = await mondayQueryPO(`
    query {
      boards(ids: [${PROJECTS_BOARD_ID}]) {
        items_page(limit: 10, query_params: { term: "${safe}" }) {
          items { id name }
        }
      }
    }
  `);
  const items = result.data?.boards?.[0]?.items_page?.items || [];
  const match = items.find(i =>
    i.name.toLowerCase().includes(key) || key.includes(i.name.toLowerCase().trim())
  );
  _poProjectNameCache[key] = match ? parseInt(match.id) : null;
  if (match) console.log(`  🔗 Project via name: "${parsedName}" → "${match.name}"`);
  else       console.log(`  ⚠️  Project not found: parentId has no UUID match, name parse failed for "${parsedName}"`);
  return _poProjectNameCache[key];
}

async function _findVendorByName(vendorName) {
  if (!vendorName) return null;
  const key = vendorName.toLowerCase().trim();
  if (_poVendorCache[key] !== undefined) return _poVendorCache[key];
  const safe = vendorName.replace(/"/g, '\\"');
  const result = await mondayQueryPO(`
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: 10, query_params: { term: "${safe}" }) {
          items { id name }
        }
      }
    }
  `);
  const items = result.data?.boards?.[0]?.items_page?.items || [];
  const exact   = items.find(i => i.name.toLowerCase().trim() === key);
  const partial = items.find(i => i.name.toLowerCase().includes(key) || key.includes(i.name.toLowerCase()));
  const match   = exact || partial || null;
  _poVendorCache[key] = match ? parseInt(match.id) : null;
  if (match) console.log(`  🔗 Vendor: "${vendorName}" → "${match.name}"`);
  else       console.log(`  ⚠️  Vendor not found: "${vendorName}"`);
  return _poVendorCache[key];
}

// Dedicated monday helper for PO sync (uses same credentials)
async function mondayQueryPO(query) {
  const response = await fetch(MONDAY_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body:    JSON.stringify({ query }),
  });
  const result = await response.json();
  if (result.errors) console.error('Monday PO query errors:', JSON.stringify(result.errors));
  return result;
}

async function _findPOByFlexUUID(boardId, uuidColId, flexUUID) {
  const result = await mondayQueryPO(`
    query {
      items_page_by_column_values(
        limit: 3, board_id: ${boardId},
        columns: [{ column_id: "${uuidColId}", column_values: ["${flexUUID}"] }]
      ) { items { id } }
    }
  `);
  return result.data?.items_page_by_column_values?.items?.[0] || null;
}

async function _fetchAllFlexPOs() {
  const all = [];
  let page = 0;
  while (true) {
    // Use 'page' / 'size' (Flex pageable convention), request parentId via headerFieldTypeIds.
    // Note: parentId is always returned in ReceivingElementRowData regardless of headerFieldTypeIds.
    // We include plannedEndDate explicitly since it is not in the default payload.
    const url = `${FLEX_BASE_URL}/api/receiving/list-row-data?page=${page}&size=100&headerFieldTypeIds=${FLEX_PO_FIELD_TYPES}`;
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Flex PO list error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.content || [];
    all.push(...content);
    console.log(`  📄 Flex POs page ${page}: ${content.length} records (total pages: ${data.totalPages ?? '?'})`);
    if (content.length < 100 || page + 1 >= (data.totalPages || 1)) break;
    page++;
  }
  return all;
}

async function _buildRPOCols(po, today) {
  // statusId from list-row-data is a plain string (confirmed by ReceivingElementRowData schema)
  const statusName = typeof po.statusId === 'object' ? po.statusId?.name : (po.statusId || '');
  const label      = _mapRPOStatus(statusName);

  // Project: UUID-first (parentId → Quote or Pullsheet UUID in Projects board),
  // fallback to name parsing if UUID lookup returns nothing.
  const projId = po.parentId
    ? (await _findProjectByParentUUID(po.parentId) ?? await _findProjectByNameFallback(po.name))
    : await _findProjectByNameFallback(po.name);

  const vendorId = await _findVendorByName(po.vendorCompany);
  const total    = await _fetchFlexPOTotal(po.id);

  const start = _formatDate(po.plannedStartDate);
  const end   = _formatDate(po.plannedEndDate);  // present when headerFieldTypeIds includes 'plannedEndDate'
  const cols  = {
    [RPO_COL.docNumber]:  po.documentNumber || '',
    [RPO_COL.status]:     { label },
    [RPO_COL.flexUUID]:   po.id,
    [RPO_COL.lastSynced]: { date: today },
  };
  if (start)          cols[RPO_COL.dateExpected] = { date: start };
  if (end)            cols[RPO_COL.returnDate]   = { date: end };
  if (start && end)   cols[RPO_COL.period]       = { from: start, to: end };
  if (vendorId)       cols[RPO_COL.vendor]       = { item_ids: [vendorId] };
  if (projId)         cols[RPO_COL.project]      = { item_ids: [projId] };
  if (total !== null) cols[RPO_COL.total]        = total;
  return { colsJSON: JSON.stringify(cols), group: _resolveRPOGroup(label) };
}

async function _buildPPOCols(po, today) {
  const statusName = typeof po.statusId === 'object' ? po.statusId?.name : (po.statusId || '');
  const label      = _mapPPOStatus(statusName);

  // Same UUID-first, name-fallback pattern
  const projId = po.parentId
    ? (await _findProjectByParentUUID(po.parentId) ?? await _findProjectByNameFallback(po.name))
    : await _findProjectByNameFallback(po.name);

  const vendorId = await _findVendorByName(po.vendorCompany);
  const total    = await _fetchFlexPOTotal(po.id);

  const delivery = _formatDate(po.plannedStartDate);
  const cols = {
    [PPO_COL.docNumber]:  po.documentNumber || '',
    [PPO_COL.status]:     { label },
    [PPO_COL.flexUUID]:   po.id,
    [PPO_COL.lastSynced]: { date: today },
  };
  if (delivery)       cols[PPO_COL.expectedDelivery] = { date: delivery };
  if (vendorId)       cols[PPO_COL.vendor]           = { item_ids: [vendorId] };
  if (projId)         cols[PPO_COL.project]          = { item_ids: [projId] };
  if (total !== null) cols[PPO_COL.total]            = total;
  return { colsJSON: JSON.stringify(cols), group: _resolvePPOGroup(label) };
}

async function _processPO(po, today, dryRun, stats) {
  const docNum = po.documentNumber || '';
  const isRPO  = docNum.startsWith('RPO-');
  const isPPO  = docNum.startsWith('PPO-');
  if (!isRPO && !isPPO) { stats.skipped++; return; }

  const boardId  = isRPO ? RENTAL_PO_BOARD_ID    : PURCHASE_PO_BOARD_ID;
  const uuidCol  = isRPO ? RPO_COL.flexUUID       : PPO_COL.flexUUID;

  console.log(`\n📄 ${docNum} — "${po.name}"`);

  const { colsJSON, group } = isRPO
    ? await _buildRPOCols(po, today)
    : await _buildPPOCols(po, today);

  const existing = await _findPOByFlexUUID(boardId, uuidCol, po.id);
  const safeName = (po.name || docNum).replace(/"/g, '\\"');

  if (existing) {
    if (!dryRun) await mondayQueryPO(`
      mutation {
        change_multiple_column_values(
          board_id: ${boardId}, item_id: ${existing.id},
          column_values: ${JSON.stringify(colsJSON)}
        ) { id }
      }
    `);
    console.log(`  🔄 Updated ${existing.id}`);
    stats.updated++;
  } else {
    if (!dryRun) await mondayQueryPO(`
      mutation {
        create_item(
          board_id: ${boardId}, group_id: "${group}",
          item_name: "${safeName}", column_values: ${JSON.stringify(colsJSON)}
        ) { id }
      }
    `);
    console.log(`  ✅ Created in ${group}`);
    stats.created++;
  }
}

async function handlePOSync(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok', route: 'pos',
      boards: { rentalPOs: RENTAL_PO_BOARD_ID, purchasePOs: PURCHASE_PO_BOARD_ID },
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const dryRun = req.query?.dryRun === 'true' || req.body?.dryRun === true;
  const today  = new Date().toISOString().substring(0, 10);
  console.log(`\n🚀 PO sync started${dryRun ? ' (DRY RUN)' : ''} — ${today}`);

  const stats  = { created: 0, updated: 0, skipped: 0, errors: 0, total: 0 };
  const errors = [];

  try {
    const allPOs = await _fetchAllFlexPOs();
    stats.total  = allPOs.length;
    const rpos   = allPOs.filter(p => (p.documentNumber || '').startsWith('RPO-'));
    const ppos   = allPOs.filter(p => (p.documentNumber || '').startsWith('PPO-'));
    console.log(`📊 ${allPOs.length} POs: ${rpos.length} RPOs, ${ppos.length} PPOs`);

    for (let i = 0; i < allPOs.length; i += 5) {
      await Promise.all(
        allPOs.slice(i, i + 5).map(po =>
          _processPO(po, today, dryRun, stats).catch(err => {
            console.error(`❌ ${po.documentNumber}:`, err.message);
            errors.push({ doc: po.documentNumber, error: err.message });
            stats.errors++;
          })
        )
      );
    }

    console.log(`✅ PO sync done — created: ${stats.created}, updated: ${stats.updated}, errors: ${stats.errors}`);
    return res.status(200).json({
      ok: true, dryRun, today, stats,
      summary: { rpos: rpos.length, ppos: ppos.length },
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    console.error('❌ PO sync fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ============================================================================
// END PO SYNC
// ============================================================================


// ================================================================
// GEOCODE ROUTE: enrich New Additions group with location data
// GET  ?route=geocode  — dry run (shows what would be geocoded)
// POST ?route=geocode  — live run (writes to Monday location column)
// Skips contacts that already have a location value.
// ================================================================
const GOOGLE_MAPS_KEY   = process.env.GEOCODING_API_KEY;
const LOCATION_COL      = 'location_mm50h12r';
const GEOCODE_CONCURRENCY = 5;

async function geocodeAddress(rawAddress) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
    + encodeURIComponent(rawAddress) + '&key=' + GOOGLE_MAPS_KEY;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocode HTTP ' + res.status);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error('Geocode status: ' + data.status + (data.error_message ? ' — ' + data.error_message : ''));
  }
  const r = data.results[0];
  const countryComp = (r.address_components || []).find(c => c.types.includes('country'));
  return {
    lat:              r.geometry.location.lat,
    lng:              r.geometry.location.lng,
    address:          r.formatted_address,
    countryShortName: countryComp?.short_name || '',
    placeId:          r.place_id || '',
  };
}

async function writeLocationToMonday(itemId, loc) {
  const val = JSON.stringify({ lat: loc.lat, lng: loc.lng, address: loc.address, changed_at: new Date().toISOString() });
  const mutation = `mutation {
    change_column_value(
      board_id: ${CONTACTS_BOARD_ID},
      item_id: ${itemId},
      column_id: "${LOCATION_COL}",
      value: ${JSON.stringify(val)}
    ) { id }
  }`;
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await res.json();
  if (result.errors) throw new Error('Monday location write failed: ' + JSON.stringify(result.errors));
}

async function getAllNewAdditionsItems() {
  const all = [];
  let cursor = null;
  do {
    const clause = cursor ? `cursor: "${cursor}"` : `query_params: {
      rules: [{ column_id: "group", compare_value: ["${NEW_ADDITIONS_GROUP}"], operator: any_of }]
    }`;
    const q = `query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: 100 ${clause}) {
          cursor
          items {
            id name
            column_values(ids: ["${COL.address}", "${LOCATION_COL}"]) { id text value }
          }
        }
      }
    }`;
    const res = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
      body: JSON.stringify({ query: q }),
    });
    const result = await res.json();
    const page = result.data?.boards?.[0]?.items_page;
    if (!page) throw new Error('Monday group fetch failed: ' + JSON.stringify(result.errors));
    all.push(...(page.items || []));
    cursor = page.cursor || null;
  } while (cursor);
  return all;
}

async function handleGeocodeRoute(req, res) {
  const dryRun = req.method === 'GET';
  console.log('\n📍 geocode-new | mode: ' + (dryRun ? 'DRY RUN' : 'LIVE'));

  const allItems = await getAllNewAdditionsItems();

  // Only process items that have an address but no location yet
  const toGeocode = allItems.filter(item => {
    const addr = (item.column_values?.find(c => c.id === COL.address) || {}).text?.trim();
    const loc  = (item.column_values?.find(c => c.id === LOCATION_COL) || {}).text?.trim();
    return addr && !loc;
  });

  const alreadyDone = allItems.length - toGeocode.length;
  console.log(`📋 ${allItems.length} in group | ${toGeocode.length} to geocode | ${alreadyDone} already have location`);

  const results = [];
  for (let i = 0; i < toGeocode.length; i += GEOCODE_CONCURRENCY) {
    const chunk = toGeocode.slice(i, i + GEOCODE_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(async item => {
      const rawAddr = (item.column_values?.find(c => c.id === COL.address) || {}).text?.trim();
      if (dryRun) {
        return { name: item.name, itemId: item.id, status: 'would_geocode', address: rawAddr };
      }
      try {
        const loc = await geocodeAddress(rawAddr);
        await writeLocationToMonday(item.id, loc);
        console.log(`  ✅ "${item.name}" → ${loc.lat},${loc.lng} (${loc.address})`);
        return { name: item.name, itemId: item.id, status: 'geocoded',
          location: { lat: loc.lat, lng: loc.lng, address: loc.address } };
      } catch (err) {
        console.warn(`  ⚠️  "${item.name}": ${err.message}`);
        return { name: item.name, itemId: item.id, status: 'error', error: err.message, address: rawAddr };
      }
    }));
    settled.forEach(r => results.push(r.status === 'fulfilled' ? r.value : { status: 'exception', error: r.reason?.message }));
    // Polite pause between chunks on live runs
    if (!dryRun && i + GEOCODE_CONCURRENCY < toGeocode.length) {
      await new Promise(ok => setTimeout(ok, 250));
    }
  }

  return res.status(200).json({
    mode: dryRun ? 'dry_run' : 'live',
    summary: {
      totalInGroup:    allItems.length,
      alreadyGeocoded: alreadyDone,
      processed:       results.length,
      geocoded:        results.filter(r => r.status === 'geocoded' || r.status === 'would_geocode').length,
      errors:          results.filter(r => r.status === 'error' || r.status === 'exception').length,
    },
    detail: results,
  });
}


// ================================================================
// DEDUP ROUTE: remove duplicate items in New Additions group
// GET  ?route=dedup-group — dry run (shows what would be deleted)
// POST ?route=dedup-group — live run (deletes duplicates)
//
// Groups items by normalized name. For each group with >1 item:
//   - Scores each by number of non-empty column values
//   - Keeps highest scorer (tiebreak: lowest item ID = oldest)
//   - Deletes the rest
// Skips generic/ambiguous names: N/A, Quote, Cash Deposit, etc.
// ================================================================
const SKIP_NAMES = new Set(['n/a', 'quote', 'cash deposit', 'internal quote', 'do not use', 'test']);

function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isGenericName(name) {
  const n = (name || '').trim().toLowerCase();
  for (const skip of SKIP_NAMES) {
    if (n === skip || n.startsWith(skip)) return true;
  }
  return false;
}

function scoreItem(item) {
  let score = 0;
  for (const cv of (item.column_values || [])) {
    const v = cv.text || cv.value;
    if (v && v.trim() && v !== 'null' && v !== '{}') score++;
  }
  return score;
}

async function deleteMondayItem(itemId) {
  const mutation = `mutation { delete_item(item_id: ${itemId}) { id } }`;
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await res.json();
  if (result.errors) throw new Error('Delete failed: ' + JSON.stringify(result.errors));
}

async function handleDedupGroupRoute(req, res) {
  const dryRun = req.method === 'GET';
  console.log('\n🔍 dedup-group | mode: ' + (dryRun ? 'DRY RUN' : 'LIVE'));

  // Fetch all items in group with all column values
  const allItems = await getAllNewAdditionsItems();
  console.log('Total items in group:', allItems.length);

  // Group by normalized name — skip generic names
  const groups = {};
  const skipped = [];
  for (const item of allItems) {
    if (isGenericName(item.name)) { skipped.push(item.name); continue; }
    const key = normalizeName(item.name);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const dupGroups = Object.values(groups).filter(g => g.length > 1);
  console.log('Duplicate groups found:', dupGroups.length, '| Skipped (generic):', skipped.length);

  const toDelete = [];
  const toKeep   = [];

  for (const group of dupGroups) {
    // Sort: highest score first, tiebreak lowest itemId (oldest)
    group.sort((a, b) => {
      const diff = scoreItem(b) - scoreItem(a);
      if (diff !== 0) return diff;
      return parseInt(a.id) - parseInt(b.id);
    });
    toKeep.push({ name: group[0].name, itemId: group[0].id, score: scoreItem(group[0]) });
    for (const dup of group.slice(1)) {
      toDelete.push({ name: dup.name, itemId: dup.id, score: scoreItem(dup) });
    }
  }

  if (dryRun) {
    return res.status(200).json({
      mode: 'dry_run',
      summary: {
        totalInGroup:    allItems.length,
        uniqueNames:     Object.keys(groups).length,
        skippedGeneric:  skipped.length,
        dupGroups:       dupGroups.length,
        wouldDelete:     toDelete.length,
        wouldKeep:       toKeep.length,
      },
      keep:   toKeep,
      delete: toDelete,
    });
  }

  // Live — delete in batches of 10
  const results = [];
  for (let i = 0; i < toDelete.length; i += 10) {
    const chunk = toDelete.slice(i, i + 10);
    const settled = await Promise.allSettled(chunk.map(async item => {
      await deleteMondayItem(item.itemId);
      console.log('  🗑️  deleted', item.name, item.itemId);
      return { ...item, status: 'deleted' };
    }));
    settled.forEach(r => results.push(r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message }));
  }

  return res.status(200).json({
    mode: 'live',
    summary: {
      totalInGroup:  allItems.length,
      dupGroups:     dupGroups.length,
      deleted:       results.filter(r => r.status === 'deleted').length,
      errors:        results.filter(r => r.status === 'error').length,
      skippedGeneric: skipped.length,
    },
    kept:    toKeep,
    deleted: results,
  });
}


// ================================================================
// SORT-NEW ROUTE: classify + move New Additions into proper groups
// GET  ?route=sort-new — dry run (shows proposed classification)
// POST ?route=sort-new — live (sets Company Type + moves to group)
//
// Skips items that already have Company Type set (idempotent).
// Classification priority:
//   1. Keyword patterns in name
//   2. Flex Contact Type (Client → Artist, Venue → Venue)
//   3. Fallback → Other Services & Vendors
// ================================================================

// Company Type dropdown IDs
const COMPANY_TYPE = {
  ARTIST:       1,   // Artist/Performer/DJ
  VENUE:        2,   // Venue
  FESTIVAL:     3,   // Festival/Event Producer
  PRODUCTION:   4,   // Production Company
  LIGHTING:     5,   // Lighting Company
  AUDIO:        6,   // Audio/Sound Company
  STAGING:      7,   // Staging/Equipment Rental
  AV:           8,   // Event Technology/AV Company
  PROMOTER:     9,   // Promoter/Booking Agency
  MANAGEMENT:  10,   // Artist Management/Agency
  TRANSPORT:   11,   // Transportation/Logistics
  VISUAL:      12,   // Visual/Creative Services
  LABEL:       13,   // Record Label/Music Company
  LOCAL:       14,   // Local Business/Venue Support
  VENDOR:      15,   // Service Provider/Vendor
  DRIVER:      16,   // Driver
  EMPLOYEE:    17,   // Employee
  CARRIER:     18,   // Carrier
  FREELANCE:   19,   // Freelance Contractor
  INTERNAL:    20,   // Internal Only
};

// Company Type → Group mapping
const TYPE_TO_GROUP = {
  [COMPANY_TYPE.ARTIST]:     'group_mm3vsdmn',  // Artists & Performers
  [COMPANY_TYPE.VENUE]:      'group_mm3v505y',  // Venues
  [COMPANY_TYPE.FESTIVAL]:   'group_mm3vb6nj',  // Festivals & Events
  [COMPANY_TYPE.PRODUCTION]: 'group_mm3va781',  // Production Companies
  [COMPANY_TYPE.LIGHTING]:   'group_mm3vdthn',  // Technical Services
  [COMPANY_TYPE.AUDIO]:      'group_mm3vdthn',  // Technical Services
  [COMPANY_TYPE.STAGING]:    'group_mm3vdthn',  // Technical Services
  [COMPANY_TYPE.AV]:         'group_mm3vdthn',  // Technical Services
  [COMPANY_TYPE.PROMOTER]:   'group_mm3v6p7c',  // Promoters & Booking
  [COMPANY_TYPE.MANAGEMENT]: 'group_mm3v1f04',  // Management & Agencies
  [COMPANY_TYPE.TRANSPORT]:  'group_mm3vr6j8',  // Transportation & Logistics
  [COMPANY_TYPE.VISUAL]:     'group_mm3vv87y',  // Creative & Visual Services
  [COMPANY_TYPE.LABEL]:      'group_mm3v1f04',  // Management & Agencies
  [COMPANY_TYPE.LOCAL]:      'group_mm3vwsm1',  // Other Services & Vendors
  [COMPANY_TYPE.VENDOR]:     'group_mm3vwsm1',  // Other Services & Vendors
  [COMPANY_TYPE.DRIVER]:     'group_mm3vr6j8',  // Transportation & Logistics
  [COMPANY_TYPE.EMPLOYEE]:   'group_mm3vwsm1',  // Other Services & Vendors
  [COMPANY_TYPE.CARRIER]:    'group_mm3vr6j8',  // Transportation & Logistics
  [COMPANY_TYPE.FREELANCE]:  'group_mm3vwsm1',  // Other Services & Vendors
  [COMPANY_TYPE.INTERNAL]:   'group_mm3vwsm1',  // Other Services & Vendors
};

const GROUP_NAMES = {
  'group_mm3vsdmn': 'Artists & Performers',
  'group_mm3v505y': 'Venues',
  'group_mm3vb6nj': 'Festivals & Events',
  'group_mm3va781': 'Production Companies',
  'group_mm3vdthn': 'Technical Services (Lighting/Audio/Staging)',
  'group_mm3v6p7c': 'Promoters & Booking',
  'group_mm3v1f04': 'Management & Agencies',
  'group_mm3vr6j8': 'Transportation & Logistics',
  'group_mm3vv87y': 'Creative & Visual Services',
  'group_mm3vwsm1': 'Other Services & Vendors',
};

const COMPANY_TYPE_NAMES = {
  1: 'Artist/Performer/DJ', 2: 'Venue', 3: 'Festival/Event Producer',
  4: 'Production Company', 5: 'Lighting Company', 6: 'Audio/Sound Company',
  7: 'Staging/Equipment Rental', 8: 'Event Technology/AV Company',
  9: 'Promoter/Booking Agency', 10: 'Artist Management/Agency',
  11: 'Transportation/Logistics', 12: 'Visual/Creative Services',
  13: 'Record Label/Music Company', 14: 'Local Business/Venue Support',
  15: 'Service Provider/Vendor', 16: 'Driver', 17: 'Employee',
  18: 'Carrier', 19: 'Freelance Contractor', 20: 'Internal Only',
};

function classifyContact(name, flexContactType) {
  const n = (name || '').toLowerCase();

  // Internal / junk signals
  if (/internal|do not use|test customer|n\/a|^quote$|^cash deposit$/.test(n))
    return COMPANY_TYPE.INTERNAL;

  // Venue
  if (/venue|theater|theatre|hall|arena|stadium|amphitheater|ballroom/.test(n))
    return COMPANY_TYPE.VENUE;
  if (flexContactType === 'Venue')
    return COMPANY_TYPE.VENUE;

  // Festival / event producer
  if (/festival|music festival|event producer|digital rising/.test(n))
    return COMPANY_TYPE.FESTIVAL;

  // Artist management / agency (check before artist to catch "Management")
  if (/management|mgmt|agency|agencies|custom management/.test(n))
    return COMPANY_TYPE.MANAGEMENT;

  // Promoter / booking
  if (/promoter|booking|presents|hard dance|jay goldberg events/.test(n))
    return COMPANY_TYPE.PROMOTER;

  // Production company
  if (/production|productions|btsm|zombie productions/.test(n))
    return COMPANY_TYPE.PRODUCTION;

  // Audio / sound
  if (/audio|sound alliance|audio alliance/.test(n))
    return COMPANY_TYPE.AUDIO;

  // AV / event tech
  if (/interactive|av |a\/v |technology|tech(?!nical)|enttec/.test(n))
    return COMPANY_TYPE.AV;

  // Lighting
  if (/lighting|light(?!s)/.test(n))
    return COMPANY_TYPE.LIGHTING;

  // Visual / creative
  if (/visual|creative|design|photo|video|film|media/.test(n))
    return COMPANY_TYPE.VISUAL;

  // Transportation / logistics
  if (/transport|logistics|trucking|carrier|freight|shipping/.test(n))
    return COMPANY_TYPE.TRANSPORT;

  // Record label / music company
  if (/records|recordings|label|music(?! festival)/.test(n))
    return COMPANY_TYPE.LABEL;

  // Local business
  if (/grill|restaurant|cafe|catering|hotel|bar(?!celona)/.test(n))
    return COMPANY_TYPE.LOCAL;

  // If Flex says Client — likely artist / performer
  if (flexContactType === 'Client')
    return COMPANY_TYPE.ARTIST;

  // Default
  return COMPANY_TYPE.VENDOR;
}

async function getNewAdditionsForSort() {
  const all = [];
  let cursor = null;
  do {
    const clause = cursor ? `cursor: "${cursor}"` : `query_params: {
      rules: [{ column_id: "group", compare_value: ["${NEW_ADDITIONS_GROUP}"], operator: any_of }]
    }`;
    const q = `query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: 100 ${clause}) {
          cursor
          items {
            id name
            column_values(ids: ["${COL.flexContactType}", "dropdown_mm3vm6jh"]) { id text value }
          }
        }
      }
    }`;
    const res = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
      body: JSON.stringify({ query: q }),
    });
    const result = await res.json();
    const page = result.data?.boards?.[0]?.items_page;
    if (!page) throw new Error('Monday fetch failed: ' + JSON.stringify(result.errors));
    all.push(...(page.items || []));
    cursor = page.cursor || null;
  } while (cursor);
  return all;
}

async function moveItemToGroup(itemId, groupId) {
  const mutation = `mutation { move_item_to_group(item_id: ${itemId}, group_id: "${groupId}") { id } }`;
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await res.json();
  if (result.errors) throw new Error('Move failed: ' + JSON.stringify(result.errors));
}

async function setCompanyType(itemId, typeId) {
  const val = JSON.stringify({ ids: [typeId] });
  const mutation = `mutation {
    change_column_value(
      board_id: ${CONTACTS_BOARD_ID},
      item_id: ${itemId},
      column_id: "dropdown_mm3vm6jh",
      value: ${JSON.stringify(val)}
    ) { id }
  }`;
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await res.json();
  if (result.errors) throw new Error('Dropdown write failed: ' + JSON.stringify(result.errors));
}

async function handleSortNewRoute(req, res) {
  const dryRun = req.method === 'GET';
  console.log('\n📦 sort-new | mode: ' + (dryRun ? 'DRY RUN' : 'LIVE'));

  const allItems = await getNewAdditionsForSort();
  console.log('Total in New Additions:', allItems.length);

  // Skip items that already have Company Type set
  const toProcess = allItems.filter(item => {
    const existing = (item.column_values?.find(c => c.id === 'dropdown_mm3vm6jh') || {}).text?.trim();
    return !existing;
  });
  const alreadyTyped = allItems.length - toProcess.length;

  const plan = toProcess.map(item => {
    const flexType = (item.column_values?.find(c => c.id === COL.flexContactType) || {}).text?.trim() || '';
    const typeId   = classifyContact(item.name, flexType);
    const groupId  = TYPE_TO_GROUP[typeId] || 'group_mm3vwsm1';
    return { itemId: item.id, name: item.name, flexType, typeId, groupId,
             typeName: COMPANY_TYPE_NAMES[typeId], groupName: GROUP_NAMES[groupId] };
  });

  if (dryRun) {
    return res.status(200).json({
      mode: 'dry_run',
      summary: { totalInGroup: allItems.length, alreadyTyped, toProcess: plan.length },
      plan,
    });
  }

  // Live — process in batches of 5
  const results = [];
  for (let i = 0; i < plan.length; i += 5) {
    const chunk = plan.slice(i, i + 5);
    const settled = await Promise.allSettled(chunk.map(async p => {
      await setCompanyType(p.itemId, p.typeId);
      await moveItemToGroup(p.itemId, p.groupId);
      console.log(`  ✅ "${p.name}" → ${p.typeName} / ${p.groupName}`);
      return { ...p, status: 'sorted' };
    }));
    settled.forEach(r => results.push(r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message }));
    if (i + 5 < plan.length) await new Promise(ok => setTimeout(ok, 200));
  }

  return res.status(200).json({
    mode: 'live',
    summary: {
      totalInGroup: allItems.length,
      alreadyTyped,
      processed: results.length,
      sorted:  results.filter(r => r.status === 'sorted').length,
      errors:  results.filter(r => r.status === 'error').length,
    },
    results,
  });
}




// ================================================================
// OOC SYNC CONSTANTS (Equipment Repair Tracker)
// ================================================================
const REPAIR_TRACKER_BOARD_ID          = process.env.REPAIR_TRACKER_BOARD_ID || '18422076626';
const REPAIR_TRACKER_SUBITEMS_BOARD_ID = '18422076650';

const OOC_COL = {
  serialNumber:      'text_mm59e67m',
  barcode:           'text_mm598skj',
  modelName:         'text_mm59m56r',
  currentStatus:     'color_mm59nf37',
  currentLocation:   'text_mm596rtg',
  totalOocIncidents: 'numeric_mm59gjpv',
  lastSynced:        'date_mm59m0y5',
  flexUnitId:        'text_mm59zh5f',
};

const OOC_SUB_COL = {
  repairStatus:  'color_mm59ah67',
  oocReason:     'long_text_mm59vb84',
  reportedDate:  'date_mm592kt0',
  reportedBy:    'text_mm59tg2y',
  resolvedDate:  'date_mm59541s',
  daysDown:      'numeric_mm59b96r',
  flexOocId:     'text_mm59zmdy',
};

// ================================================================
// BATCH HELPER — fires ALL chunks in parallel via Promise.all
// mutations: array of GQL mutation strings (without 'mutation {}' wrapper)
// chunkSize: how many to pack into each GQL request (default 25)
// Returns array of { id } results in same order
// ================================================================
async function runBatchedMutations(mutations, chunkSize = 25) {
  if (!mutations.length) return [];

  // Split into chunks, preserving original index for alias naming
  const chunks = [];
  for (let i = 0; i < mutations.length; i += chunkSize) {
    chunks.push({ start: i, muts: mutations.slice(i, i + chunkSize) });
  }

  // Fire ALL chunks simultaneously
  const chunkResults = await Promise.all(chunks.map(async ({ start, muts }) => {
    const body = 'mutation {\n' +
      muts.map((m, j) => `  op${start + j}: ${m}`).join('\n') +
      '\n}';
    const res = await fetch(MONDAY_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
      body:    JSON.stringify({ query: body }),
    });
    const data = await res.json();
    if (data.errors) console.error(`Chunk @${start} errors:`, JSON.stringify(data.errors).slice(0, 400));
    return { start, count: muts.length, data };
  }));

  // Reassemble in original order
  const results = new Array(mutations.length).fill(null);
  for (const { start, count, data } of chunkResults) {
    for (let j = 0; j < count; j++) {
      results[start + j] = data.data?.[`op${start + j}`] ?? null;
    }
  }
  return results;
}

// ================================================================
// Pre-fetch ALL existing parent items → { flexUnitId: mondayItemId }
// ================================================================
async function buildParentItemsMap() {
  const map = {};
  let cursor = null;
  do {
    const q = `{ boards(ids:[${REPAIR_TRACKER_BOARD_ID}]) { items_page(limit:100${cursor ? `,cursor:"${cursor}"` : ''}) { cursor items { id column_values(ids:["${OOC_COL.flexUnitId}"]) { id text } } } } }`;
    const res    = await fetch(MONDAY_API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_API_KEY}, body:JSON.stringify({query:q}) });
    const result = await res.json();
    const page   = result.data?.boards?.[0]?.items_page;
    for (const item of page?.items || []) {
      const fid = item.column_values?.find(c => c.id === OOC_COL.flexUnitId)?.text?.trim();
      if (fid) map[fid] = item.id;
    }
    cursor = page?.cursor || null;
  } while (cursor);
  return map;
}

// ================================================================
// Pre-fetch ALL existing subitems → { flexOocId: mondaySubitemId }
// ================================================================
async function buildSubitemsMap() {
  const map = {};
  let cursor = null;
  do {
    const q = `{ boards(ids:[${REPAIR_TRACKER_SUBITEMS_BOARD_ID}]) { items_page(limit:100${cursor ? `,cursor:"${cursor}"` : ''}) { cursor items { id column_values(ids:["${OOC_SUB_COL.flexOocId}"]) { id text } } } } }`;
    const res    = await fetch(MONDAY_API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_API_KEY}, body:JSON.stringify({query:q}) });
    const result = await res.json();
    const page   = result.data?.boards?.[0]?.items_page;
    for (const item of page?.items || []) {
      const fid = item.column_values?.find(c => c.id === OOC_SUB_COL.flexOocId)?.text?.trim();
      if (fid) map[fid] = item.id;
    }
    cursor = page?.cursor || null;
  } while (cursor);
  return map;
}

// ================================================================
// ROUTE: sync-ooc — batched mutations, no serial unit fetches
// ================================================================
async function handleSyncOocRoute(req, res) {
  const startedAt = Date.now();
  console.log('\n🔧 sync-ooc starting (batched)');

  // 1. Fetch all OOC records from Flex
  const allOocRecords = [];
  let page = 0, keepGoing = true;
  while (keepGoing) {
    const url  = `${FLEX_BASE_URL}/api/ooc-record/grid-node?page=${page}&size=100`;
    const resp = await fetch(url, { method:'POST', headers:{'X-Auth-Token':FLEX_API_KEY,'Accept':'application/json','Content-Type':'application/json'}, body:'[]' });
    if (!resp.ok) throw new Error(`Flex OOC failed: ${resp.status}`);
    const data = await resp.json();
    const recs = data.content || [];
    allOocRecords.push(...recs);
    console.log(`  📄 Flex OOC page ${page}: ${recs.length} records`);
    if (data.last || recs.length < 100) keepGoing = false;
    else if (++page >= 50) keepGoing = false;
  }
  console.log(`📋 Total OOC records: ${allOocRecords.length}`);

  // 2. Group by serialUnitId — skip non-serialized items
  const byUnit = {};
  for (const rec of allOocRecords) {
    if (!rec.serialUnitId) continue;
    (byUnit[rec.serialUnitId] = byUnit[rec.serialUnitId] || []).push(rec);
  }
  const unitIds = Object.keys(byUnit);
  console.log(`🔩 Unique serialized units: ${unitIds.length}`);

  // 3. Bulk pre-fetch existing monday items & subitems in parallel
  console.log('📦 Pre-fetching existing monday data...');
  const [parentMap, subMap] = await Promise.all([buildParentItemsMap(), buildSubitemsMap()]);
  console.log(`  ✅ Parents: ${Object.keys(parentMap).length} | Subitems: ${Object.keys(subMap).length}`);

  const today = new Date().toISOString().split('T')[0];

  // 4. Build batched parent mutations
  const parentCreates = [], parentUpdates = [];
  const unitIdOrder   = []; // track order for new-item ID mapping

  for (const unitId of unitIds) {
    const recs   = byUnit[unitId];
    const sample = recs[0];
    const serial = sample.serialNumber || '';
    const hasUnresolved = recs.some(r => !r.resolved);
    const status = hasUnresolved ? 'OOC' : 'In Service';

    const cv = JSON.stringify(JSON.stringify({
      [OOC_COL.serialNumber]:      serial,
      [OOC_COL.barcode]:           sample.barcode || '',
      [OOC_COL.modelName]:         sample.modelName || '',
      [OOC_COL.currentStatus]:     { label: status },
      [OOC_COL.currentLocation]:   sample.locationName || '',
      [OOC_COL.totalOocIncidents]: recs.length,
      [OOC_COL.lastSynced]:        { date: today },
      [OOC_COL.flexUnitId]:        unitId,
    }));

    const itemName = JSON.stringify(`${sample.modelName || ''} — SN:${serial}`);

    if (parentMap[unitId]) {
      parentUpdates.push(`change_multiple_column_values(board_id:${REPAIR_TRACKER_BOARD_ID},item_id:${parentMap[unitId]},column_values:${cv}) { id }`);
    } else {
      unitIdOrder.push(unitId);
      parentCreates.push(`create_item(board_id:${REPAIR_TRACKER_BOARD_ID},item_name:${itemName},column_values:${cv}) { id }`);
    }
  }

  console.log(`🔨 Parent creates: ${parentCreates.length} | updates: ${parentUpdates.length}`);

  // 5. Run parent batches
  const [createResults, updateResults] = await Promise.all([
    parentCreates.length ? runBatchedMutations(parentCreates, 10) : Promise.resolve([]),
    parentUpdates.length ? runBatchedMutations(parentUpdates, 10) : Promise.resolve([]),
  ]);

  // Update parentMap with newly created item IDs
  createResults.forEach((r, idx) => {
    if (r?.id) parentMap[unitIdOrder[idx]] = r.id;
  });

  console.log(`✅ Parents done. Created: ${createResults.filter(r=>r?.id).length} | Updated: ${updateResults.length}`);

  // 6. Build batched subitem mutations
  const subCreates = [], subUpdates = [];

  for (const unitId of unitIds) {
    const parentItemId = parentMap[unitId];
    if (!parentItemId) continue;

    for (const rec of byUnit[unitId]) {
      const flexOocId    = String(rec.id);
      const repairStatus = rec.resolved ? 'Resolved' : 'Open';
      const reportedDate = rec.reportedDate ? rec.reportedDate.split('T')[0] : null;
      const resolvedDate = rec.resolvedDate ? rec.resolvedDate.split('T')[0] : null;
      const daysDown     = (reportedDate && resolvedDate)
        ? Math.round((new Date(resolvedDate) - new Date(reportedDate)) / 86400000) : null;

      const cv = JSON.stringify(JSON.stringify({
        [OOC_SUB_COL.repairStatus]:  { label: repairStatus },
        [OOC_SUB_COL.oocReason]:     { text: rec.reason || '' },
        ...(reportedDate && { [OOC_SUB_COL.reportedDate]: { date: reportedDate } }),
        [OOC_SUB_COL.reportedBy]:    rec.reportedBy || '',
        ...(resolvedDate && { [OOC_SUB_COL.resolvedDate]: { date: resolvedDate } }),
        ...(daysDown !== null && { [OOC_SUB_COL.daysDown]: daysDown }),
        [OOC_SUB_COL.flexOocId]:     flexOocId,
      }));

      const subName = JSON.stringify((rec.reason || 'OOC Incident').substring(0, 80).replace(/\n/g, ' '));

      if (subMap[flexOocId]) {
        subUpdates.push(`change_multiple_column_values(board_id:${REPAIR_TRACKER_SUBITEMS_BOARD_ID},item_id:${subMap[flexOocId]},column_values:${cv}) { id }`);
      } else {
        subCreates.push(`create_subitem(parent_item_id:${parentItemId},item_name:${subName},column_values:${cv}) { id }`);
      }
    }
  }

  console.log(`🔨 Subitem creates: ${subCreates.length} | updates: ${subUpdates.length}`);

  // 7. Run subitem batches
  const [subCreateResults, subUpdateResults] = await Promise.all([
    subCreates.length ? runBatchedMutations(subCreates, 10) : Promise.resolve([]),
    subUpdates.length ? runBatchedMutations(subUpdates, 10) : Promise.resolve([]),
  ]);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    ok: true, elapsed: `${elapsed}s`,
    totalOocRecords: allOocRecords.length,
    uniqueUnits: unitIds.length,
    itemsCreated:     createResults.filter(r=>r?.id).length,
    itemsUpdated:     parentUpdates.length,
    subitemsCreated:  subCreateResults.filter(r=>r?.id).length,
    subitemsUpdated:  subUpdates.length,
  };
  console.log('\n📊 sync-ooc complete:', summary);
  return res.status(200).json(summary);
}

// ================================================================
// ROUTE: resolve-ooc — push resolution from monday back to Flex
// ================================================================
async function handleResolveOocRoute(req, res) {
  console.log('\n✅ resolve-ooc triggered');
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });

  const subitemId = body.event?.pulseId;
  if (!subitemId) return res.status(400).json({ error: 'Missing pulseId' });

  try {
    const query = `{ items(ids:[${subitemId}]) { column_values(ids:["${OOC_SUB_COL.flexOocId}","${OOC_SUB_COL.reportedDate}","${OOC_SUB_COL.repairStatus}"]) { id text } } }`;
    const mondayRes  = await fetch(MONDAY_API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_API_KEY}, body:JSON.stringify({query}) });
    const mondayData = await mondayRes.json();
    const cols        = mondayData.data?.items?.[0]?.column_values || [];
    const flexOocId   = cols.find(c => c.id === OOC_SUB_COL.flexOocId)?.text?.trim();
    const reportedDate = cols.find(c => c.id === OOC_SUB_COL.reportedDate)?.text?.trim();
    const repairStatus = cols.find(c => c.id === OOC_SUB_COL.repairStatus)?.text?.trim();

    if (repairStatus !== 'Resolved') return res.status(200).json({ ok:true, skipped:true, reason:'Not resolved' });
    if (!flexOocId)                  return res.status(200).json({ ok:true, skipped:true, reason:'No Flex OOC ID' });

    const flexRes = await fetch(`${FLEX_BASE_URL}/api/ooc-record/resolve?id=${encodeURIComponent(flexOocId)}`,
      { method:'PUT', headers:{'X-Auth-Token':FLEX_API_KEY,'Accept':'application/json'} });
    if (!flexRes.ok) console.error(`❌ Flex resolve failed ${flexOocId}: ${flexRes.status}`);
    else             console.log(`✅ Flex OOC ${flexOocId} resolved`);

    const today    = new Date().toISOString().split('T')[0];
    const daysDown = reportedDate ? Math.round((new Date(today) - new Date(reportedDate)) / 86400000) : null;
    const updateCv = JSON.stringify({ [OOC_SUB_COL.resolvedDate]:{ date:today }, ...(daysDown !== null && { [OOC_SUB_COL.daysDown]:daysDown }) });
    await fetch(MONDAY_API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':MONDAY_API_KEY},
      body:JSON.stringify({ query:`mutation { change_multiple_column_values(board_id:${REPAIR_TRACKER_SUBITEMS_BOARD_ID},item_id:${subitemId},column_values:${JSON.stringify(updateCv)}) { id } }` }) });

    return res.status(200).json({ ok:true, flexOocId, resolvedDate:today, daysDown });
  } catch (err) {
    console.error('❌ resolve-ooc error:', err);
    return res.status(500).json({ error: err.message });
  }
}



export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GEOCODE ROUTE ──────────────────────────────────────────────
  if (req.query && req.query.route === 'geocode') {
    try { return await handleGeocodeRoute(req, res); }
    catch (err) { console.error('❌ geocode error:', err); return res.status(500).json({ error: err.message }); }
  }

  // ── DEDUP GROUP ROUTE ─────────────────────────────────────────
  if (req.query && req.query.route === 'dedup-group') {
    try { return await handleDedupGroupRoute(req, res); }
    catch (err) { console.error('❌ dedup-group error:', err); return res.status(500).json({ error: err.message }); }
  }

  // ── SYNC-OOC ROUTE ───────────────────────────────────────────
  if (req.query && req.query.route === 'sync-ooc') {
    try { return await handleSyncOocRoute(req, res); }
    catch (err) { console.error('❌ sync-ooc error:', err); return res.status(500).json({ error: err.message }); }
  }

  // ── RESOLVE-OOC ROUTE ─────────────────────────────────────────
  if (req.query && req.query.route === 'resolve-ooc') {
    try { return await handleResolveOocRoute(req, res); }
    catch (err) { console.error('❌ resolve-ooc error:', err); return res.status(500).json({ error: err.message }); }
  }

  // ── SORT-NEW ROUTE ────────────────────────────────────────────
  if (req.query && req.query.route === 'sort-new') {
    try { return await handleSortNewRoute(req, res); }
    catch (err) { console.error('❌ sort-new error:', err); return res.status(500).json({ error: err.message }); }
  }

  if (req.method === 'GET')     return res.status(200).json({ status: 'ok', endpoint: 'pull-from-flex' });

  // ── PO sync sub-route ──────────────────────────────────────────────────────
  // Reached via: POST /api/contacts/pull-from-flex?route=pos
  // Rewritten from:  POST /api/pos/pull-from-flex  (vercel.json rewrite)
  if ((req.query?.route || '') === 'pos') return handlePOSync(req, res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('\n🚀 pull-from-flex starting');
  const startedAt = Date.now();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const query = req.query || {};

    // ─── Determine lookback window ─────────────────────────────
    const fullSync = query.full === 'true' || body.full === true;
    const hoursBack = parseInt(query.hours || body.hours || '24', 10);
    const sinceISO = fullSync
      ? null
      : new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    console.log(fullSync
      ? `🔁 Full sync mode — all Flex contacts`
      : `⏱️ Lookback: ${hoursBack}h (since ${sinceISO})`
    );

    // ─── Paginate through Flex contacts ───────────────────────
    const results = { created: 0, updated: 0, linked: 0, skipped: 0, errors: 0, details: [] };
    let page = 0;
    let keepGoing = true;

    while (keepGoing) {
      const { contacts, rawCount } = await fetchFlexContacts(sinceISO, page, 100);

      console.log(`  📄 Page ${page}: ${rawCount} raw, ${contacts.length} in window`);

      // If not in full sync and we got fewer results than requested, we've passed the date window
      if (!fullSync && contacts.length === 0) {
        keepGoing = false;
        break;
      }

      for (const contact of contacts) {
        try {
          const outcome = await processFlexContact(contact);
          results[outcome.action] = (results[outcome.action] || 0) + 1;
          results.details.push(outcome);
        } catch (e) {
          console.error(`❌ Error processing Flex contact ${contact.id}:`, e.message);
          results.errors++;
          results.details.push({ action: 'error', flexId: contact.id, name: contact.name, error: e.message });
        }
      }

      // Stop if we got fewer than a full page (last page) or exceeded date window
      if (rawCount < 100) {
        keepGoing = false;
      } else {
        page++;
        // Safety: cap at 20 pages (2000 contacts) per run to avoid runaway cron
        if (page >= 20) {
          console.log('⚠️ Page cap reached (20) — stopping. Run again or use ?full=true for more.');
          keepGoing = false;
        }
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = {
      ok: true,
      elapsed: `${elapsed}s`,
      window: fullSync ? 'full' : `${hoursBack}h`,
      created:  results.created,
      updated:  results.updated,
      linked:   results.linked,
      skipped:  results.skipped,
      errors:   results.errors,
    };

    console.log('\n📊 pull-from-flex complete:', summary);
    return res.status(200).json(summary);

  } catch (err) {
    console.error('❌ pull-from-flex fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
