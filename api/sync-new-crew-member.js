export const config = {
  api: { bodyParser: true },
};

const MONDAY_API_URL   = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_KEY;

// Board IDs
const CREW_DB_BOARD_ID          = '18415879010';
const CONTACTS_BOARD_ID         = '18415573401';
const CREW_ASSIGNMENTS_BOARD_ID = '18415879040';

// New contact lands in "🤝 NEW ADDITIONS" group on Contacts & Companies board
const CONTACTS_DEFAULT_GROUP = 'group_mm3y3xvh';

// Crew Assignments: People column for Vibe app gating
const CREW_LOGIN_COLUMN = 'multiple_person_mm3yfksh';

// Crew Database source column ID → Contacts & Companies destination column
const COLUMN_MAP = {
  email_mm3yfhmg:     { id: 'email_mm3vezw3',     type: 'email'     }, // Email
  phone_mm3yd44g:     { id: 'phone_mm3vwfvj',     type: 'phone'     }, // Phone
  text_mm4cmcr2:      { id: 'text_mm4f57rc',      type: 'text'      }, // Drivers License #
  long_text_mm3yj0b2: { id: 'long_text_mm3y8wh4', type: 'long_text' }, // Notes → Account Notes
};

// Fixed values stamped on every contact created from a crew member
const FIXED_COLUMN_VALUES = {
  dropdown_mm3vm6jh: { ids: [19] }, // Company Type = "Freelance Contractor"
};

// ================================================================
// MAIN HANDLER — routes on ?route= query param
// ================================================================
export default async function handler(req, res) {
  if (req.method === 'POST' && req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });

  const route = req.query?.route;

  if (route === 'sync-login') {
    return handleSyncLogin(req, res);
  }

  return handleSyncNewCrewMember(req, res);
}

// ================================================================
// HANDLER: New crew member → create Contact on Contacts & Companies board
// ================================================================
async function handleSyncNewCrewMember(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  try {
    const event = body.event;
    if (!event) return res.status(400).json({ error: 'Missing event data' });

    const crewItemId = event.pulseId;
    if (!crewItemId) return res.status(400).json({ error: 'Missing pulseId' });

    const crewMember = await fetchCrewMember(crewItemId);

    // Guard: skip test/placeholder items
    const nameCheck = (crewMember.name || '').trim().toLowerCase();
    if (!crewMember.name || nameCheck === 'test' || nameCheck.startsWith('test ') || nameCheck.startsWith('test-')) {
      console.log('[sync-new-crew-member] Skipping test item: "' + crewMember.name + '"');
      return res.status(200).json({ success: true, message: 'Skipped test item' });
    }

    // De-dupe: check if a contact with this name or email already exists
    const email = crewMember.columns['email_mm3yfhmg']?.text || null;
    const existingId = await findExistingContact(crewMember.name, email);
    if (existingId) {
      console.log(`[sync-new-crew-member] Contact already exists: "${crewMember.name}" (ID: ${existingId}) — skipping`);
      return res.status(200).json({ success: true, message: 'Contact already exists', existingContactId: existingId });
    }

    // Create contact on Contacts & Companies board
    const newContactId = await createContactItem(crewMember.name);
    const columnValues = buildColumnValues(crewMember.columns);
    const finalValues  = { ...columnValues, ...FIXED_COLUMN_VALUES };

    if (Object.keys(finalValues).length > 0) {
      await updateContactColumns(newContactId, finalValues);
    }

    console.log(`[sync-new-crew-member] Created contact "${crewMember.name}" (ID: ${newContactId})`);
    return res.status(200).json({ success: true, crewItemId, newContactId });

  } catch (error) {
    console.error('[sync-new-crew-member] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ================================================================
// HANDLER: Sync crew login — populate People column on Crew Assignment
// Triggered when Crew Member relation is set on a Crew Assignment item.
// Finds the crew member's monday.com user account by email and writes
// it to the Crew Log In (multiple_person_mm3yfksh) People column so
// Vibe apps can use it as an identity credential for gating content.
// ================================================================
async function handleSyncLogin(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  try {
    const event = body.event;
    if (!event) return res.status(400).json({ error: 'Missing event data' });

    const assignmentItemId = event.pulseId;
    if (!assignmentItemId) return res.status(400).json({ error: 'Missing pulseId' });

    console.log(`[sync-login] Processing Crew Assignment: ${assignmentItemId}`);

    // Step 1: Fetch the Crew Assignment item to get linked Crew Member ID
    const assignmentData = await mondayRequest(`
      query {
        items(ids: [${assignmentItemId}]) {
          id name
          column_values(ids: ["board_relation_mm3y1w67"]) {
            id
            ... on BoardRelationValue { linked_items { id name } }
          }
        }
      }
    `);

    const assignment = assignmentData.items?.[0];
    if (!assignment) throw new Error(`Assignment ${assignmentItemId} not found`);

    const crewRelCol     = assignment.column_values.find(c => c.id === 'board_relation_mm3y1w67');
    const crewMemberId   = crewRelCol?.linked_items?.[0]?.id;
    const crewMemberName = crewRelCol?.linked_items?.[0]?.name || 'Unknown';

    if (!crewMemberId) {
      console.log('[sync-login] No crew member linked yet — skipping');
      return res.status(200).json({ success: true, message: 'No crew member linked — skipping' });
    }

    console.log(`[sync-login] Crew Member: ${crewMemberName} (ID: ${crewMemberId})`);

    // Step 2: Fetch crew member's email from Crew Database
    const crewData = await mondayRequest(`
      query {
        items(ids: [${crewMemberId}]) {
          column_values(ids: ["email_mm3yfhmg"]) { id text }
        }
      }
    `);

    const emailText = crewData.items?.[0]?.column_values?.find(c => c.id === 'email_mm3yfhmg')?.text?.trim();

    if (!emailText) {
      console.log(`[sync-login] No email on crew member ${crewMemberId} — cannot match monday user`);
      return res.status(200).json({ success: true, message: 'No email found on crew member — cannot match monday user' });
    }

    console.log(`[sync-login] Looking up monday user by email: ${emailText}`);

    // Step 3: Find monday.com user account by email
    const usersData = await mondayRequest(`
      query { users(emails: ["${emailText}"]) { id name email } }
    `);

    const mondayUser = usersData.users?.[0];

    if (!mondayUser) {
      console.log(`[sync-login] No monday user found for email: ${emailText}`);
      return res.status(200).json({ success: true, message: `No monday account found for ${emailText}` });
    }

    console.log(`[sync-login] Matched monday user: ${mondayUser.name} (ID: ${mondayUser.id})`);

    // Step 4: Write the user to the Crew Log In People column on the Crew Assignment
    await mondayRequest(`
      mutation {
        change_column_value(
          item_id: ${assignmentItemId},
          board_id: ${CREW_ASSIGNMENTS_BOARD_ID},
          column_id: "${CREW_LOGIN_COLUMN}",
          value: "{\\"personsAndTeams\\": [{\\"id\\": ${mondayUser.id}, \\"kind\\": \\"person\\"}]}"
        ) { id }
      }
    `);

    console.log(`[sync-login] Crew Log In populated for ${crewMemberName}`);

    return res.status(200).json({
      success: true,
      assignmentItemId,
      crewMemberName,
      mondayUser: { id: mondayUser.id, name: mondayUser.name, email: mondayUser.email }
    });

  } catch (error) {
    console.error('[sync-login] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ================================================================
// HELPERS
// ================================================================

async function fetchCrewMember(itemId) {
  const query = `query { items(ids: [${itemId}]) { id name column_values { id value text type } } }`;
  const data = await mondayRequest(query);
  const item = data.items[0];
  const columns = {};
  item.column_values.forEach(col => { columns[col.id] = { value: col.value, text: col.text }; });
  return { id: item.id, name: item.name, columns };
}

async function findExistingContact(name, email) {
  // Check by name
  const nameData = await mondayRequest(`
    query {
      items_page_by_column_values(
        board_id: ${CONTACTS_BOARD_ID},
        limit: 5,
        columns: [{ column_id: "name", column_values: [${JSON.stringify(name)}] }]
      ) { items { id name } }
    }
  `);
  const byName = nameData.items_page_by_column_values?.items || [];
  if (byName.length > 0) return byName[0].id;

  // Check by email if available
  if (email) {
    const emailData = await mondayRequest(`
      query {
        items_page_by_column_values(
          board_id: ${CONTACTS_BOARD_ID},
          limit: 5,
          columns: [{ column_id: "email_mm3vezw3", column_values: [${JSON.stringify(email)}] }]
        ) { items { id name } }
      }
    `);
    const byEmail = emailData.items_page_by_column_values?.items || [];
    if (byEmail.length > 0) return byEmail[0].id;
  }

  return null;
}

async function createContactItem(name) {
  const mutation = `mutation { create_item(board_id: ${CONTACTS_BOARD_ID}, group_id: "${CONTACTS_DEFAULT_GROUP}", item_name: ${JSON.stringify(name)}) { id } }`;
  const data = await mondayRequest(mutation);
  return data.create_item.id;
}

function buildColumnValues(sourceColumns) {
  const result = {};
  for (const [srcId, mapping] of Object.entries(COLUMN_MAP)) {
    const source = sourceColumns[srcId];
    if (!source || (!source.value && !source.text)) continue;
    let val = null;
    switch (mapping.type) {
      case 'email':     if (source.text) val = { email: source.text, text: source.text }; break;
      case 'phone':     if (source.text) val = { phone: source.text.replace(/\D/g, ''), countryShortName: 'US' }; break;
      case 'text':      if (source.text) val = source.text; break;
      case 'long_text': if (source.text) val = { text: source.text }; break;
    }
    if (val !== null) result[mapping.id] = val;
  }
  return result;
}

async function updateContactColumns(itemId, columnValues) {
  const mutation = `mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${CONTACTS_BOARD_ID}, column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
  await mondayRequest(mutation);
}

// ================================================================
// SHARED: Monday API request
// ================================================================
async function mondayRequest(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query })
  });
  const data = await response.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}
