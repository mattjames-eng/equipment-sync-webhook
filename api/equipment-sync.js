// ================================================================
// Flex → monday.com Equipment Sync Webhook
// Vercel Serverless Function
//
// COLUMN MAP (Projects board — see PROJECTS_BOARD_ID):
//   text_mm466djv  → Event Folder UUID   (top-level parent in Flex)
//   text_mm4cwasc  → Quote UUID          (financial document / quote)
//   text_mm3y7xwa  → Equipment List UUID (pullsheet child document)
//   text_mm3x2yr6  → Flex Project #
//   text_mm435rt8  → Client Name (from Flex)
//   text_mm43r22q  → Venue Name (from Flex)
// ================================================================

// ===== ENVIRONMENT VARIABLES =====
const FLEX_API_KEY      = process.env.FLEX_API_KEY;
const FLEX_BASE_URL     = process.env.FLEX_BASE_URL     || 'https://anticstudios.flexrentalsolutions.com/f5';
const MONDAY_API_KEY    = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = process.env.PROJECTS_BOARD_ID || '18415679761';
const CONTACTS_BOARD_ID = process.env.CONTACTS_BOARD_ID || '18415573401';

// ================================================================
// HELPER: Safely extract a value from a nested Flex response object
// ================================================================
function getValue(obj, key) {
  if (!obj) return null;
  const val = obj[key];
  if (val !== undefined && val !== null) {
    if (typeof val === 'object') return val.preferredDisplayString || val.id || null;
    return val;
  }
  if (obj.data)   return getValue(obj.data,   key);
  if (obj.result) return getValue(obj.result, key);
  return null;
}

// ================================================================
// HELPER: Post a GraphQL mutation/query to monday.com
// ================================================================
async function mondayMutation(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  return res.json();
}

// ================================================================
// HELPER: Write optional error text on the item (Portal Status column removed)
// ================================================================
async function updateMondayStatus(itemId, boardId, statusLabel, errorText = '') {
  const cols = {};
  if (errorText) cols.text_mm3zvvqk = errorText.substring(0, 500);
  try {
    await mondayMutation(`
      mutation {
        change_multiple_column_values(
          board_id: ${boardId},
          item_id: ${itemId},
          column_values: ${JSON.stringify(JSON.stringify(cols))}
        ) { id }
      }
    `);
  } catch (e) {
    console.error('⚠️ Failed to update monday status:', e.message);
  }
}

// ================================================================
// HELPER: Search Contacts & Companies board by name.
// Returns the monday.com item ID or null.
// ================================================================
async function findContactInMonday(name) {
  if (!name) return null;
  const cleanName = name.replace(/"/g, '\\"');
  try {
    const result = await mondayMutation(`
      query {
        items_page_by_column_values(
          limit: 5,
          board_id: ${CONTACTS_BOARD_ID},
          columns: [{ column_id: "name", column_values: ["${cleanName}"] }]
        ) { items { id name } }
      }
    `);
    return result?.data?.items_page_by_column_values?.items?.[0]?.id || null;
  } catch (e) {
    console.warn(`Contact lookup failed for "${name}":`, e.message);
    return null;
  }
}

// ================================================================
// HELPER: Build the column_values object for the monday.com update.
// Each UUID goes to its dedicated column — no mixing.
// ================================================================
function buildColumnValues(flexHeaderData, equipmentCount, clientItemId, venueItemId, quoteUUID, eventFolderUUID, equipmentListUUID) {
  const cols = {};

  // ----- Event Date -----
  const eventDate = getValue(flexHeaderData, 'eventDate') || getValue(flexHeaderData, 'showStartDate');
  if (eventDate) cols.date_mm3xca9r = { date: eventDate.split('T')[0] };

  // ----- Prep / Load-In Date -----
  const prepDate = getValue(flexHeaderData, 'prepDate') || getValue(flexHeaderData, 'loadInDate');
  if (prepDate) cols.date_mm4at0qc = { date: prepDate.split('T')[0] };

  // ----- Return Date -----
  const returnDate = getValue(flexHeaderData, 'returnDate') || getValue(flexHeaderData, 'loadOutDate');
  if (returnDate) cols.date_mm4a7fn6 = { date: returnDate.split('T')[0] };

  // ----- Estimated Budget -----
  const budget = getValue(flexHeaderData, 'budgetedRevenue') || getValue(flexHeaderData, 'resolvedBudgetedRevenue');
  if (budget && parseFloat(budget) > 0) cols.numeric_mm3xzncg = parseFloat(budget);

  // ----- Actual Spend -----
  const actual = getValue(flexHeaderData, 'actualRevenue') || getValue(flexHeaderData, 'resolvedActualRevenue');
  if (actual && parseFloat(actual) > 0) cols.numeric_mm3xrd3e = parseFloat(actual);

  // ======================================================
  //   THE THREE FLEX UUIDs — each goes to its own column
  // ======================================================

  // 1. Event Folder UUID — top-level parent project in Flex
  if (eventFolderUUID) {
    cols.text_mm466djv = eventFolderUUID;
    console.log(`✅ Event Folder UUID  → text_mm466djv : ${eventFolderUUID}`);
  } else {
    console.warn('⚠️ No Event Folder UUID — text_mm466djv not written');
  }

  // 2. Quote UUID — the financial document / quote element
  if (quoteUUID) {
    cols.text_mm4cwasc = quoteUUID;
    console.log(`✅ Quote UUID         → text_mm4cwasc  : ${quoteUUID}`);
  }

  // 3. Equipment List UUID — the pullsheet child document
  if (equipmentListUUID) {
    cols.text_mm3y7xwa = equipmentListUUID;
    console.log(`✅ Equip List UUID    → text_mm3y7xwa  : ${equipmentListUUID}`);
  } else {
    console.warn('⚠️ No Equipment List UUID — text_mm3y7xwa not written');
  }

  // ======================================================

  // ----- Equipment Count -----
  cols.numeric_mm3zsgna = equipmentCount || 0;

  // ----- Last Equipment Sync -----
  cols.date_mm3z1vqz = { date: new Date().toISOString().split('T')[0] };

  // ----- Client board relation -----
  if (clientItemId) cols.board_relation_mm3x8evw = { item_ids: [parseInt(clientItemId)] };

  // ----- Venue/Location board relation -----
  if (venueItemId)  cols.board_relation_mm3xrm02 = { item_ids: [parseInt(venueItemId)] };

  return cols;
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('\n======================================');
  console.log('📨 Flex Sync Webhook Received');
  console.log('Payload:', JSON.stringify(req.body, null, 2));
  console.log('======================================\n');

  const payload = req.body;

  // ===== STEP 1: Extract item ID, board ID, and quote number =====
  const itemId  = payload?.event?.pulseId   ||
                  payload?.event?.itemId     ||
                  payload?.pulseId           ||
                  payload?.itemId;

  const boardId = payload?.event?.boardId   ||
                  payload?.boardId           ||
                  PROJECTS_BOARD_ID;

  if (!itemId) {
    console.error('❌ No item ID in webhook payload');
    return res.status(400).json({ error: 'No item ID provided' });
  }

  // Extract quote number from payload first
  let flexQuoteNumber = (
    payload?.event?.value?.value         ||
    payload?.event?.columnValue?.value   ||
    payload?.columnValue                 ||
    payload?.flexQuoteNumber             ||
    ''
  ).trim();

  // If the payload didn't include the quote number (e.g. a status column triggered
  // the webhook instead of the Flex Quote # text column), fall back to querying
  // monday.com directly to get the current value of that column on this item.
  if (!flexQuoteNumber) {
    console.log('ℹ️  No quote number in payload — querying monday.com for item column value...');
    try {
      const itemQuery = await mondayMutation(`
        query {
          items(ids: [${itemId}]) {
            column_values(ids: ["text_mm3x2yr6"]) {
              id
              text
              value
            }
          }
        }
      `);
      const colVal = itemQuery?.data?.items?.[0]?.column_values?.[0];
      const fetched = (colVal?.text || colVal?.value || '').replace(/"/g, '').trim();
      if (fetched) {
        console.log(`✅ Quote number fetched from item: "${fetched}"`);
        flexQuoteNumber = fetched;
      } else {
        console.log('ℹ️  Item has no Flex Quote # — skipping sync');
        return res.status(200).json({ message: 'No quote number on item, nothing to sync' });
      }
    } catch (e) {
      console.error('❌ Failed to fetch quote number from monday.com:', e.message);
      return res.status(500).json({ error: 'Could not retrieve quote number from item' });
    }
  }

  console.log(`🔗 Quote: "${flexQuoteNumber}" | Item: ${itemId} | Board: ${boardId}`);

  // ===== STEP 1.5: LOOK UP ALL THREE UUIDs FROM FLEX =====
  let quoteUUID         = null;
  let eventFolderUUID   = null;
  let equipmentListUUID = null;

  const looksLikeQuoteNumber = flexQuoteNumber.includes('-') && flexQuoteNumber.length < 20;

  if (looksLikeQuoteNumber) {
    const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(flexQuoteNumber)}&searchTypes=all&maxResults=25&includeDeleted=false&includeClosed=true`;
    console.log(`🔍 Searching Flex: ${searchUrl}`);

    const searchRes = await fetch(searchUrl, {
      headers: { 'X-Auth-Token': FLEX_API_KEY, 'Content-Type': 'application/json' }
    });

    if (!searchRes.ok) {
      const msg = `Flex search HTTP ${searchRes.status}`;
      console.error(`❌ ${msg}`);
      await updateMondayStatus(itemId, boardId, 'Failed', msg);
      return res.status(500).json({ error: msg });
    }

    const searchData = await searchRes.json();
    console.log('🔍 Raw Flex search response:', JSON.stringify(searchData, null, 2));

    // Normalize to flat array regardless of response shape
    let results = [];
    if (Array.isArray(searchData))            results = searchData;
    else if (searchData.results)              results = searchData.results;
    else if (Array.isArray(searchData.data))  results = searchData.data;
    else if (searchData.data)                 results = [searchData.data];

    if (results.length === 0) {
      const msg = `Quote "${flexQuoteNumber}" not found in Flex`;
      console.error(`❌ ${msg}`);
      await updateMondayStatus(itemId, boardId, 'Failed', msg);
      return res.status(404).json({ error: msg });
    }

    // Classify each result by domainId
    for (const result of results) {
      const domain = (result.domainId || result.domain || result.type || '').toLowerCase();
      const id     = result.id || result.elementId || result.uuid;
      const name   = result.name || result.displayName || '(no name)';
      console.log(`  📦 domain="${domain}" | id=${id} | name="${name}"`);

      if (['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain)) {
        equipmentListUUID = id;
        console.log(`  📋 → Equipment List UUID: ${id}`);

      } else if (['project', 'event-folder', 'event_folder', 'folder'].includes(domain)) {
        eventFolderUUID = id;
        console.log(`  📁 → Event Folder UUID: ${id}`);

      } else if (['quote', 'financial-document', 'financial_document', 'financialdocument'].includes(domain)) {
        quoteUUID = id;
        console.log(`  📄 → Quote UUID: ${id}`);

      } else {
        console.log(`  ❓ → Unrecognized domain "${domain}"`);
        if (!quoteUUID) {
          quoteUUID = id;
          console.log(`  📄 → Quote UUID (fallback): ${id}`);
        }
      }
    }

    if (!quoteUUID) {
      const msg = 'Could not extract any UUID from Flex search results';
      console.error(`❌ ${msg}`);
      await updateMondayStatus(itemId, boardId, 'Failed', msg);
      return res.status(500).json({ error: msg });
    }

  } else {
    // Already looks like a UUID — use it directly
    quoteUUID = flexQuoteNumber;
    console.log(`Using value directly as Quote UUID: ${quoteUUID}`);
  }

  // ===== STEP 2: Fetch header data from Flex =====
  const headerUrl = `${FLEX_BASE_URL}/api/element/${quoteUUID}/header-data`;
  console.log(`\n📡 Fetching header data: ${headerUrl}`);

  const headerRes = await fetch(headerUrl, {
    headers: { 'X-Auth-Token': FLEX_API_KEY, 'Content-Type': 'application/json' }
  });

  if (!headerRes.ok) {
    const msg = `Flex header-data HTTP ${headerRes.status}`;
    console.error(`❌ ${msg}`);
    await updateMondayStatus(itemId, boardId, 'Failed', msg);
    return res.status(500).json({ error: msg });
  }

  const flexHeaderData = await headerRes.json();
  console.log('📋 Flex header data:', JSON.stringify(flexHeaderData, null, 2));

  // ===== STEP 2.5: FALLBACK UUID LOOKUPS =====

  // Fallback A: Event Folder UUID — try header data first, then fetch element directly
  if (!eventFolderUUID) {
    eventFolderUUID = flexHeaderData.parentElementId ||
                      flexHeaderData?.data?.parentElementId ||
                      null;
    if (eventFolderUUID) {
      console.log(`✅ Event Folder UUID from header data: ${eventFolderUUID}`);
    } else {
      try {
        console.log(`🔍 Fetching element to get parentElementId...`);
        const elemRes = await fetch(`${FLEX_BASE_URL}/api/element/${quoteUUID}`, {
          headers: { 'X-Auth-Token': FLEX_API_KEY }
        });
        if (elemRes.ok) {
          const elemData = await elemRes.json();
          console.log('Element data:', JSON.stringify(elemData, null, 2));
          eventFolderUUID = elemData.parentElementId || elemData?.data?.parentElementId || null;
          if (eventFolderUUID) {
            console.log(`✅ Event Folder UUID from element fetch: ${eventFolderUUID}`);
          } else {
            console.warn('⚠️ No parentElementId — quote may be top-level');
          }
        } else {
          console.warn(`⚠️ Element fetch returned ${elemRes.status}`);
        }
      } catch (e) {
        console.warn('⚠️ Element fallback fetch failed:', e.message);
      }
    }
  }

  // Fallback B: Equipment List UUID — query Flex equipment-list endpoint by parentElementId
  if (!equipmentListUUID) {
    try {
      const eqUrl = `${FLEX_BASE_URL}/api/equipment-list?parentElementId=${quoteUUID}&page=0&size=10`;
      console.log(`🔍 Searching for equipment list: ${eqUrl}`);
      const eqRes = await fetch(eqUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY } });
      if (eqRes.ok) {
        const eqData = await eqRes.json();
        console.log('Equipment list response:', JSON.stringify(eqData, null, 2));
        const items = Array.isArray(eqData) ? eqData : (eqData.content || []);
        if (items.length > 0) {
          equipmentListUUID = items[0].id;
          console.log(`✅ Equipment List UUID from filter: ${equipmentListUUID}`);
        } else {
          console.warn('⚠️ No equipment lists found as children of this quote');
        }
      } else {
        console.warn(`⚠️ Equipment list filter returned ${eqRes.status}`);
      }
    } catch (e) {
      console.warn('⚠️ Equipment list fallback fetch failed:', e.message);
    }
  }

  // Summary log
  console.log('\n📊 FINAL UUID SUMMARY:');
  console.log(`  📁 Event Folder : ${eventFolderUUID   || '❌ NOT FOUND'}`);
  console.log(`  📄 Quote        : ${quoteUUID}`);
  console.log(`  📋 Equip List   : ${equipmentListUUID  || '❌ NOT FOUND'}`);

  // ===== STEP 3: Extract client and venue names from Flex =====
  const clientName =
    flexHeaderData?.data?.client?.preferredDisplayString ||
    getValue(flexHeaderData, 'clientName')               ||
    getValue(flexHeaderData, 'clientId')                 ||
    null;

  const venueName =
    flexHeaderData?.data?.venue?.preferredDisplayString  ||
    getValue(flexHeaderData, 'venueName')                ||
    getValue(flexHeaderData, 'venueId')                  ||
    null;

  console.log(`\n👤 Client: ${clientName || '(none)'}`);
  console.log(`📍 Venue:  ${venueName  || '(none)'}`);

  // Write raw text names to monday.com immediately (for display and PM manual linking)
  if (clientName || venueName) {
    const nameVals = {};
    if (clientName) nameVals.text_mm435rt8 = clientName;
    if (venueName)  nameVals.text_mm43r22q = venueName;
    try {
      await mondayMutation(`
        mutation {
          change_multiple_column_values(
            board_id: ${boardId},
            item_id: ${itemId},
            column_values: ${JSON.stringify(JSON.stringify(nameVals))}
          ) { id }
        }
      `);
      console.log('✅ Client/Venue text fields written');
    } catch (e) {
      console.warn('⚠️ Could not write client/venue text fields:', e.message);
    }
  }

  // ===== STEP 4: Resolve Client and Venue to monday.com item IDs =====
  const [clientItemId, venueItemId] = await Promise.all([
    findContactInMonday(clientName),
    findContactInMonday(venueName)
  ]);
  console.log(`🔗 Client monday ID: ${clientItemId || 'NOT FOUND'}`);
  console.log(`🔗 Venue monday ID:  ${venueItemId  || 'NOT FOUND'}`);

  // ===== STEP 5: Count equipment line items from Flex =====
  let equipmentCount = 0;
  if (equipmentListUUID) {
    try {
      const countUrl = `${FLEX_BASE_URL}/api/eqlist-line-item/nodes-by-ids?equipmentListId=${equipmentListUUID}`;
      const countRes = await fetch(countUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY } });
      if (countRes.ok) {
        const countData  = await countRes.json();
        const allNodes   = Array.isArray(countData) ? countData : [];
        // Count only leaf nodes (actual items, not group headers)
        equipmentCount = allNodes.filter(node => node.leaf === true || node.group === false).length;
        console.log(`📦 Equipment items: ${equipmentCount}`);
      } else {
        console.warn(`⚠️ Equipment count returned ${countRes.status}`);
      }
    } catch (e) {
      console.warn('⚠️ Equipment count fetch failed:', e.message);
    }
  }

  // ===== STEP 6: Build column values =====
  const columnValues = buildColumnValues(
    flexHeaderData,
    equipmentCount,
    clientItemId,
    venueItemId,
    quoteUUID,
    eventFolderUUID,
    equipmentListUUID
  );
  console.log('\n📝 Writing to monday.com:', JSON.stringify(columnValues, null, 2));

  // ===== STEP 7: Write all columns to monday.com =====
  const updateResult = await mondayMutation(`
    mutation {
      change_multiple_column_values(
        board_id: ${boardId},
        item_id: ${itemId},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) { id name }
    }
  `);

  console.log('monday.com result:', JSON.stringify(updateResult, null, 2));

  if (updateResult.errors) {
    const errMsg = updateResult.errors[0]?.message || 'Unknown monday error';
    console.error('❌ monday.com update failed:', errMsg);
    await updateMondayStatus(itemId, boardId, 'Failed', errMsg);
    return res.status(500).json({ error: 'monday.com update failed', details: updateResult.errors });
  }

  // ===== STEP 8: Mark success =====
  await updateMondayStatus(itemId, boardId, 'Success');
  console.log('\n✅ Sync complete!\n');

  // ===== RETURN FULL DEBUG RESPONSE =====
  return res.status(200).json({
    success: true,
    message: 'Flex → monday.com sync complete',
    itemId,
    boardId,
    flexQuoteNumber,
    uuids: {
      eventFolder:   { column: 'text_mm466djv',  value: eventFolderUUID   || null },
      quote:         { column: 'text_mm4cwasc',   value: quoteUUID },
      equipmentList: { column: 'text_mm3y7xwa',   value: equipmentListUUID || null }
    },
    contacts: {
      client: { name: clientName, mondayItemId: clientItemId || null },
      venue:  { name: venueName,  mondayItemId: venueItemId  || null }
    },
    equipment:      { count: equipmentCount },
    columnsWritten: Object.keys(columnValues)
  });
}
