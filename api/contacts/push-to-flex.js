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
  flexContactId:   'text_mm56w1vz',     // Flex UUID — written by sync, never by agents
  flexContactType: 'dropdown_mm56cf0c', // Client | Venue | Other
  companyType:     'dropdown_mm3vm6jh', // 20-value Company Type dropdown
  address:         'long_text_mm3vkzc6',
  email:           'email_mm3vezw3',
  phone:           'phone_mm3vwfvj',
  usualContact:    'text_mm3vg7e8',
  accountNotes:    'long_text_mm4fc8h7',
};

// ================================================================
// HELPER: Fetch a page of Monday contacts that have NO Flex Contact ID
// Returns { items: [...], nextCursor: string|null }
// ================================================================
async function getMondayItemsWithoutFlexId(cursor, limit) {
  const cursorClause = cursor ? `, cursor: "${cursor}"` : '';
  const query = `
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(
          limit: ${limit}
          ${cursorClause}
          query_params: {
            rules: [{ column_id: "${COL.flexContactId}", compare_value: [], operator: is_empty }]
          }
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
// Used by both the webhook handler and the bulk sync mode
// ================================================================
async function syncContactToFlex(item) {
  const columns = parseColumnValues(item.column_values);
  const existingFlexId = columns[COL.flexContactId]?.text?.trim();

  // Safety check — skip if UUID somehow already present
  if (existingFlexId) {
    console.log(`⏭️ Skipping "${item.name}" — already linked (${existingFlexId})`);
    return { action: 'skipped', itemId: item.id, flexId: existingFlexId };
  }

  const payload = buildFlexPayload(item, columns, item.id);

  // Check if already in Flex by externalNumber (Monday item ID) — prevents duplicate creates
  const existingByExternal = await findFlexContactByExternalNumber(item.id);
  if (existingByExternal) {
    console.log(`⚠️ Found existing Flex contact by externalNumber for "${item.name}" — linking`);
    await writeFlexIdToMonday(item.id, existingByExternal);
    return { action: 'linked', itemId: item.id, flexId: existingByExternal };
  }

  // Create in Flex and write UUID back to Monday
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
  // Use change_multiple_column_values — more reliable for text columns
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
    // Throw so the caller surfaces the error in the HTTP response
    throw new Error(`Monday write-back failed: ${JSON.stringify(result.errors)}`);
  }
  console.log(`✅ Flex Contact ID written to Monday item ${itemId}: ${flexUUID}`);
}

// ================================================================
// HELPER: Build a Flex contact payload from Monday item data
// ================================================================
function buildFlexPayload(item, columns, mondayItemId) {
  const flexType = columns[COL.flexContactType]?.text || '';
  const emailText = columns[COL.email]?.text || '';
  const phoneText = columns[COL.phone]?.text || '';
  const addressText = columns[COL.address]?.text || '';

  const payload = {
    name: item.name,
    organization: true, // Contacts & Companies are orgs; individuals are in subitems
    externalNumber: String(mondayItemId), // Store monday ID for reverse lookup
  };

  // Nested email
  if (emailText) {
    payload.internetAddresses = [{ url: emailText, defaultEmail: true }];
  }

  // Nested phone
  if (phoneText) {
    // Monday phone format: "+1 555-867-5309" or "555-867-5309"
    const cleaned = phoneText.replace(/\s+/g, '').replace(/[()]/g, '');
    payload.phoneNumbers = [{ dialNumber: cleaned, defaultPhone: true }];
  }

  // Nested address (parse from free text — best effort)
  if (addressText) {
    payload.addresses = [{
      line1: addressText.split('\n')[0] || addressText,
      defaultShipping: true,
      defaultMailing: true,
    }];
  }

  // Notes field with source attribution
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
// HELPER: Update existing contact in Flex
// ================================================================
async function updateFlexContact(flexUUID, payload) {
  console.log(`📤 Updating Flex contact: ${flexUUID} ("${payload.name}")`);
  // Flex requires the contact id in the PUT body as well as the URL
  const bodyWithId = { ...payload, id: flexUUID };
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
// Returns the Flex UUID if found, null otherwise
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
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── BULK SYNC MODE ──────────────────────────────────────────────
  // GET /api/contacts/push-to-flex?bulk=true&cursor=<cursor>&batchSize=10
  // Pages through all Monday contacts with no Flex UUID, creates each
  // in Flex, and writes the UUID back. Call repeatedly until hasMore=false.
  if (req.method === 'GET' && req.query?.bulk === 'true') {
    const cursor    = req.query.cursor   || null;
    const batchSize = Math.min(parseInt(req.query.batchSize) || 10, 20);

    console.log(`\n📦 Bulk push-to-flex | cursor: ${cursor || 'start'} | batchSize: ${batchSize}`);

    try {
      const { items, nextCursor } = await getMondayItemsWithoutFlexId(cursor, batchSize);
      console.log(`📋 Found ${items.length} contacts without Flex UUID`);

      // Process all contacts in parallel — each is independent
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

  // Only process events from the Contacts & Companies board
  const boardId = String(event.boardId || '');
  if (boardId && boardId !== CONTACTS_BOARD_ID) {
    console.log(`⏭️ Skipping — event from board ${boardId}, not Contacts board`);
    return res.status(200).json({ skipped: true, reason: 'wrong board' });
  }

  console.log(`\n🚀 push-to-flex triggered | event: ${event.type} | item: ${itemId}`);

  try {
    // ─── Step 1: Fetch full item from Monday ───────────────────
    const item = await getMondayItem(itemId);
    if (!item) {
      console.log(`⚠️ Item ${itemId} not found in Monday — may have been deleted`);
      return res.status(200).json({ skipped: true, reason: 'item not found' });
    }

    const columns = parseColumnValues(item.column_values);
    const existingFlexId = columns[COL.flexContactId]?.text?.trim();

    console.log(`📋 Item: "${item.name}" | Existing Flex ID: ${existingFlexId || 'none'}`);

    // ─── Step 2: Build payload ──────────────────────────────────
    const payload = buildFlexPayload(item, columns, itemId);

    // ─── Step 3: Create or Update in Flex ──────────────────────
    if (existingFlexId) {
      // Contact already linked — this is an update from Monday back to Flex
      console.log(`🔄 Contact already linked to Flex (${existingFlexId}) — pushing update`);
      await updateFlexContact(existingFlexId, payload);
      return res.status(200).json({ ok: true, action: 'updated', flexId: existingFlexId, itemId });

    } else {
      // New contact in Monday — use shared helper (handles externalNumber check + create + writeback)
      const result = await syncContactToFlex(item);
      return res.status(200).json({ ok: true, ...result });
    }

  } catch (err) {
    console.error(`❌ push-to-flex error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
