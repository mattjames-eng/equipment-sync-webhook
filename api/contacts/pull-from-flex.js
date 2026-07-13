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
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ status: 'ok', endpoint: 'pull-from-flex' });

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

    // ─── Pagination controls (for chunked full-sync runs) ──────
    const startPage   = parseInt(query.startPage   || body.startPage   || '0',  10);
    const pagesPerRun = parseInt(query.pagesPerRun || body.pagesPerRun || '20', 10);

    console.log(fullSync
      ? `🔁 Full sync mode — all Flex contacts (startPage=${startPage}, pagesPerRun=${pagesPerRun})`
      : `⏱️ Lookback: ${hoursBack}h (since ${sinceISO})`
    );

    // ─── Paginate through Flex contacts ───────────────────────
    const results = { created: 0, updated: 0, linked: 0, skipped: 0, errors: 0, details: [] };
    let page          = startPage;
    let pagesProcessed = 0;
    let lastRawCount  = 0;
    let keepGoing     = true;

    while (keepGoing) {
      const { contacts, rawCount } = await fetchFlexContacts(sinceISO, page, 100);
      lastRawCount = rawCount;

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

      pagesProcessed++;

      if (rawCount < 100) {
        // Last Flex page — no more data
        keepGoing = false;
      } else if (pagesProcessed >= pagesPerRun) {
        // Hit per-run page cap — caller can resume with nextPage
        console.log(`⏸️ pagesPerRun cap (${pagesPerRun}) reached at Flex page ${page}.`);
        keepGoing = false;
      } else {
        page++;
        if (page >= startPage + 20) {
          console.log('⚠️ Absolute page cap reached — stopping.');
          keepGoing = false;
        }
      }
    }

    const hasMore  = lastRawCount >= 100 && pagesProcessed >= pagesPerRun;
    const nextPage = hasMore ? page + 1 : null;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = {
      ok: true,
      elapsed:  `${elapsed}s`,
      window:   fullSync ? `full (page ${startPage}–${startPage + pagesProcessed - 1})` : `${hoursBack}h`,
      created:  results.created,
      updated:  results.updated,
      linked:   results.linked,
      skipped:  results.skipped,
      errors:   results.errors,
      hasMore,
      nextPage,
    };

    console.log('\n📊 pull-from-flex complete:', summary);
    return res.status(200).json(summary);

  } catch (err) {
    console.error('❌ pull-from-flex fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
