export const config = {
  api: { bodyParser: true },
};

const MONDAY_API_URL   = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_KEY;

// Board IDs
const CREW_DB_BOARD_ID          = '18415879010';
const CONTACTS_BOARD_ID         = '18415573401';
const CREW_ASSIGNMENTS_BOARD_ID = '18415879040';

const CREW_DEFAULT_GROUP = 'group_mm3y15k9'; // Freelance Crew — default group for new crew members

// Crew Assignments: People column for Vibe app gating
const CREW_LOGIN_COLUMN = 'multiple_person_mm3yfksh';

// Source → Crew Database column map (source col IDs match Crew DB col IDs — identity mapping)
const COLUMN_MAP = {
  email_mm3yfhmg:     { id: 'email_mm3yfhmg',     type: 'email'     }, // Email
  phone_mm3yd44g:     { id: 'phone_mm3yd44g',     type: 'phone'     }, // Phone
  text_mm4cmcr2:      { id: 'text_mm4cmcr2',      type: 'text'      }, // Drivers License #
  text_mm3yy0pk:      { id: 'text_mm3yy0pk',      type: 'text'      }, // Emergency Contact
  long_text_mm3yj0b2: { id: 'long_text_mm3yj0b2', type: 'long_text' }, // Notes
  dropdown_mm3y41ay:  { id: 'dropdown_mm3y41ay',  type: 'dropdown'  }, // Preferred Department
  dropdown_mm3yd2n8:  { id: 'dropdown_mm3yd2n8',  type: 'dropdown'  }, // Role/Position
  dropdown_mm3yexty:  { id: 'dropdown_mm3yexty',  type: 'dropdown'  }, // Certifications
  dropdown_mm3ygwvc:  { id: 'dropdown_mm3ygwvc',  type: 'dropdown'  }, // Compensation Type
  numeric_mm3ytmkt:   { id: 'numeric_mm3ytmkt',   type: 'number'    }, // Shop Prep Rate
  numeric_mm3ytc86:   { id: 'numeric_mm3ytc86',   type: 'number'    }, // Hourly Rate
  boolean_mm3ywe31:   { id: 'boolean_mm3ywe31',   type: 'checkbox'  }, // OT Eligible
  numeric_mm3yny33:   { id: 'numeric_mm3yny33',   type: 'number'    }, // PTO Balance
  numeric_mm3y14jk:   { id: 'numeric_mm3y14jk',   type: 'number'    }, // Per-Project Rate
  numeric_mm3y6ps9:   { id: 'numeric_mm3y6ps9',   type: 'number'    }, // Standard Day Rate
  numeric_mm3yhyg9:   { id: 'numeric_mm3yhyg9',   type: 'number'    }, // Commission Rate
  numeric_mm3yzv3r:   { id: 'numeric_mm3yzv3r',   type: 'number'    }, // Weekly Rate
  numeric_mm3yhbcs:   { id: 'numeric_mm3yhbcs',   type: 'number'    }, // Current Year Hours
  numeric_mm3ymc1r:   { id: 'numeric_mm3ymc1r',   type: 'number'    }, // Weekly Hours Target
  numeric_mm3yb7h9:   { id: 'numeric_mm3yb7h9',   type: 'number'    }, // Annual Hour Target
  numeric_mm49tmm2:   { id: 'numeric_mm49tmm2',   type: 'number'    }, // Hours This Week
  numeric_mm49pf3k:   { id: 'numeric_mm49pf3k',   type: 'number'    }, // Hours Last Week
  numeric_mm49mp0s:   { id: 'numeric_mm49mp0s',   type: 'number'    }, // Avg Hours Per Week
  numeric_mm49vv1s:   { id: 'numeric_mm49vv1s',   type: 'number'    }, // Hours This Month
  color_mm3yqky6:     { id: 'color_mm3yqky6',     type: 'status'    }, // Flex Status
  color_mm3ycyqg:     { id: 'color_mm3ycyqg',     type: 'status'    }, // Availability Status
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

  // ── Route: sync crew login credential ──────────────────────
  if (route === 'sync-login') {
    return handleSyncLogin(req, res);
  }

  // ── Default: sync new crew member to Crew Database ──────────
  return handleSyncNewCrewMember(req, res);
}

// ================================================================
// HANDLER: Sync new crew member → Crew Database
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

    const crewMember    = await fetchCrewMember(crewItemId);
    const newItemId     = await createCrewMemberItem(crewMember.name);
    const columnValues  = buildColumnValues(crewMember.columns);

    if (Object.keys(columnValues).length > 0) {
      await updateCrewMemberColumns(newItemId, columnValues);
    }

    return res.status(200).json({ success: true, crewItemId, newItemId });
  } catch (error) {
    console.error('Error syncing crew member:', error);
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

    const crewRelCol   = assignment.column_values.find(c => c.id === 'board_relation_mm3y1w67');
    const crewMemberId = crewRelCol?.linked_items?.[0]?.id;
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
// HELPERS — Sync New Crew Member
// ================================================================
async function fetchCrewMember(itemId) {
  const query = `query { items(ids: [${itemId}]) { id name column_values { id value text type } } }`;
  const data = await mondayRequest(query);
  const item = data.items[0];
  const columns = {};
  item.column_values.forEach(col => { columns[col.id] = { value: col.value, text: col.text }; });
  return { id: item.id, name: item.name, columns };
}

async function createCrewMemberItem(name) {
  const mutation = `mutation { create_item(board_id: ${CREW_DB_BOARD_ID}, group_id: "${CREW_DEFAULT_GROUP}", item_name: ${JSON.stringify(name)}) { id } }`;
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
      case 'phone':     if (source.text) val = { phone: source.text.replace(/\D/g,''), countryShortName: 'US' }; break;
      case 'text':      if (source.text) val = source.text; break;
      case 'long_text': if (source.text) val = { text: source.text }; break;
      case 'number':    if (source.text && source.text !== '0') val = source.text; break;
      case 'checkbox':
        try { const p = JSON.parse(source.value || '{}'); if (p.checked) val = { checked: 'true' }; } catch(e) {}
        break;
      case 'dropdown':
        try { const p = JSON.parse(source.value || '{}'); if (p.ids?.length) val = { ids: p.ids }; } catch(e) {}
        break;
      case 'status':    if (source.text) val = { label: source.text }; break;
    }
    if (val !== null) result[mapping.id] = val;
  }
  return result;
}

async function updateCrewMemberColumns(itemId, columnValues) {
  const mutation = `mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${CREW_DB_BOARD_ID}, column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
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
