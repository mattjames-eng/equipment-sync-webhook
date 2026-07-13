/**
 * Contact Dedup — Merge & Clean
 *
 * The full Flex→Monday sync created new contact items (with Flex UUIDs) alongside
 * existing Monday contacts (without UUIDs) when the name-match fallback failed.
 * This endpoint finds those duplicate pairs and merges them:
 *
 *   1. Fetch all contacts from the board
 *   2. Group by normalized name
 *   3. For each group where one item HAS a UUID and one DOES NOT:
 *        a. Write the UUID onto the original (no-UUID) item
 *        b. Write the externalNumber from the new item's UUID back to Flex
 *           so Flex knows which Monday item ID to use going forward
 *        c. Delete the new (duplicate) item
 *   4. Contacts where the new item has NO name-match original are left alone
 *      (they are genuinely new Flex contacts with no prior Monday record)
 *
 * Modes:
 *   GET  /api/contacts/dedup              → health check
 *   POST /api/contacts/dedup              → dry run (reports what WOULD happen, no writes)
 *   POST /api/contacts/dedup?execute=true → live run (writes + deletes)
 *
 * Author: Antic Studios — ShowFlow
 */

const MONDAY_API_URL    = 'https://api.monday.com/v2';
const MONDAY_API_KEY    = process.env.MONDAY_API_KEY;
const FLEX_BASE_URL     = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY      = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;
const CONTACTS_BOARD_ID = '18415573401';

const COL_FLEX_ID = 'text_mm56w1vz';

// ── Normalize name for comparison ────────────────────────────────────────────
function normalize(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Fetch ALL items from the contacts board (handles pagination) ──────────────
async function fetchAllContacts() {
  const items = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const query = `
      query {
        boards(ids: [${CONTACTS_BOARD_ID}]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              name
              group { id }
              column_values(ids: ["${COL_FLEX_ID}"]) {
                id
                text
              }
            }
          }
        }
      }
    `;
    const resp = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
      body: JSON.stringify({ query }),
    });
    const result = await resp.json();
    if (result.errors) throw new Error(`Monday fetch error: ${JSON.stringify(result.errors)}`);

    const page = result.data?.boards?.[0]?.items_page;
    const batch = page?.items || [];
    items.push(...batch);
    cursor = page?.cursor || null;
  } while (cursor);

  return items;
}

// ── Stamp Flex UUID onto an existing Monday item ──────────────────────────────
async function stampUuidOnItem(itemId, flexUUID) {
  const colVals = JSON.stringify(JSON.stringify({ [COL_FLEX_ID]: flexUUID }));
  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${CONTACTS_BOARD_ID},
        item_id: ${itemId},
        column_values: ${colVals}
      ) { id }
    }
  `;
  const resp = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await resp.json();
  if (result.errors) throw new Error(`Stamp UUID failed for item ${itemId}: ${JSON.stringify(result.errors)}`);
  return result.data?.change_multiple_column_values?.id;
}

// ── Write Monday item ID to Flex externalNumber (so Flex dedup knows the right item) ──
async function writeExternalNumberToFlex(flexUUID, mondayItemId) {
  try {
    const resp = await fetch(`${FLEX_BASE_URL}/api/contact/${flexUUID}?updateBaseContactOnly=true`, {
      method: 'PUT',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ externalNumber: String(mondayItemId) }),
    });
    if (resp.ok) {
      console.log(`🔗 Flex externalNumber updated: ${flexUUID} → Monday ${mondayItemId}`);
    } else {
      console.log(`⚠️  Flex externalNumber write failed (${resp.status}) for ${flexUUID}`);
    }
  } catch (e) {
    console.log(`⚠️  Flex externalNumber write threw: ${e.message}`);
  }
}

// ── Delete a Monday item ──────────────────────────────────────────────────────
async function deleteItem(itemId) {
  const mutation = `
    mutation {
      delete_item(item_id: ${itemId}) { id }
    }
  `;
  const resp = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation }),
  });
  const result = await resp.json();
  if (result.errors) throw new Error(`Delete failed for item ${itemId}: ${JSON.stringify(result.errors)}`);
  return true;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ status: 'ok', endpoint: 'dedup' });
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const execute = (req.query?.execute === 'true') || (req.body?.execute === true);
  console.log(`\n🧹 dedup starting — mode: ${execute ? 'LIVE EXECUTE' : 'DRY RUN'}`);
  const startedAt = Date.now();

  try {
    // ── 1. Fetch everything ──────────────────────────────────────────────────
    console.log('📥 Fetching all contacts...');
    const allItems = await fetchAllContacts();
    console.log(`   Total items: ${allItems.length}`);

    // ── 2. Split into UUID haves / have-nots ────────────────────────────────
    const withUUID    = [];
    const withoutUUID = [];

    for (const item of allItems) {
      const uuid = item.column_values?.[0]?.text?.trim() || '';
      if (uuid) {
        withUUID.push({ id: item.id, name: item.name, uuid, normName: normalize(item.name) });
      } else {
        withoutUUID.push({ id: item.id, name: item.name, normName: normalize(item.name) });
      }
    }

    console.log(`   With UUID: ${withUUID.length} | Without UUID: ${withoutUUID.length}`);

    // ── 3. Build lookup: normName → original item (no UUID) ─────────────────
    const origByName = new Map();
    for (const item of withoutUUID) {
      // If multiple originals with same name, keep the first (oldest by array order)
      if (!origByName.has(item.normName)) {
        origByName.set(item.normName, item);
      }
    }

    // ── 4. Classify new items ────────────────────────────────────────────────
    const toMerge    = [];  // { newItem, origItem } — name match found
    const genuineNew = [];  // no original found — keep as-is

    for (const newItem of withUUID) {
      const orig = origByName.get(newItem.normName);
      if (orig) {
        toMerge.push({ newItem, origItem: orig });
      } else {
        genuineNew.push(newItem);
      }
    }

    console.log(`   To merge (duplicates): ${toMerge.length}`);
    console.log(`   Genuine new (keep):    ${genuineNew.length}`);

    // ── 5. Sample of what will be merged ────────────────────────────────────
    const mergeSample = toMerge.slice(0, 10).map(({ newItem, origItem }) => ({
      name:    newItem.name,
      keepId:  origItem.id,
      deleteId: newItem.id,
      uuid:    newItem.uuid,
    }));

    if (!execute) {
      // DRY RUN — report only
      return res.status(200).json({
        ok: true,
        mode: 'dry_run',
        totalItems:   allItems.length,
        withUUID:     withUUID.length,
        withoutUUID:  withoutUUID.length,
        toMerge:      toMerge.length,
        genuineNew:   genuineNew.length,
        mergeSample,
        message: 'No changes made. POST with ?execute=true to apply.',
      });
    }

    // ── 6. LIVE: merge each duplicate pair ───────────────────────────────────
    const results = { merged: 0, deleted: 0, flexUpdated: 0, errors: [] };

    for (const { newItem, origItem } of toMerge) {
      try {
        // a. Stamp UUID onto original
        await stampUuidOnItem(origItem.id, newItem.uuid);
        results.merged++;

        // b. Tell Flex that the original Monday item ID is the canonical one
        await writeExternalNumberToFlex(newItem.uuid, origItem.id);
        results.flexUpdated++;

        // c. Delete the new duplicate
        await deleteItem(newItem.id);
        results.deleted++;

        console.log(`✅ Merged "${newItem.name}" → kept ${origItem.id}, deleted ${newItem.id}, UUID ${newItem.uuid}`);
      } catch (e) {
        console.error(`❌ Merge failed for "${newItem.name}": ${e.message}`);
        results.errors.push({ name: newItem.name, newId: newItem.id, origId: origItem.id, error: e.message });
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    return res.status(200).json({
      ok: true,
      mode: 'executed',
      elapsed: `${elapsed}s`,
      totalItems:    allItems.length,
      toMerge:       toMerge.length,
      genuineNew:    genuineNew.length,
      merged:        results.merged,
      deleted:       results.deleted,
      flexUpdated:   results.flexUpdated,
      errors:        results.errors.length,
      errorDetails:  results.errors.slice(0, 20),
    });

  } catch (err) {
    console.error('❌ dedup fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
