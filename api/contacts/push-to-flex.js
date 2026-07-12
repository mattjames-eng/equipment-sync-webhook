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
  const mutation = `
    mutation {
      change_column_value(
        board_id: ${CONTACTS_BOARD_ID},
        item_id: ${itemId},
        column_id: "${COL.flexContactId}",
        value: ${JSON.stringify(flexUUID)}
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
    console.error('❌ Failed to write Flex Contact ID to Monday:', result.errors);
  } else {
    console.log(`✅ Flex Contact ID written to Monday item ${itemId}: ${flexUUID}`);
  }
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
  const response = await fetch(`${FLEX_BASE_URL}/api/contact/${flexUUID}?updateBaseContactOnly=false`, {
    method: 'PUT',
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
      // New contact in Monday — check Flex first to prevent duplication
      // (race condition: if it was just created in Flex before Monday wrote the UUID back)
      const existingByExternal = await findFlexContactByExternalNumber(itemId);
      if (existingByExternal) {
        console.log(`⚠️ Found existing Flex contact by externalNumber — writing UUID back to Monday`);
        await writeFlexIdToMonday(itemId, existingByExternal);
        return res.status(200).json({ ok: true, action: 'linked', flexId: existingByExternal, itemId });
      }

      // Genuinely new — create in Flex
      const flexId = await createFlexContact(payload);

      // Write UUID back to Monday
      await writeFlexIdToMonday(itemId, flexId);

      return res.status(200).json({ ok: true, action: 'created', flexId, itemId });
    }

  } catch (err) {
    console.error(`❌ push-to-flex error:`, err);
    return res.status(500).json({ error: err.message });
  }
}
