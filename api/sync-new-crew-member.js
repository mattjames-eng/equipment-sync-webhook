const fetch = require('node-fetch');

export const config = {
  api: { bodyParser: true },
};

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

const CREW_DB_BOARD_ID = '18415879010';
const CONTACTS_BOARD_ID = '18415573401';
const CONTACTS_INDIVIDUALS_GROUP = 'group_mm49j4jx';

const COLUMN_MAP = {
  email_mm3yfhmg:     { id: 'email_mm3vezw3',    type: 'email'     },
  phone_mm3yd44g:     { id: 'phone_mm3vwfvj',    type: 'phone'     },
  text_mm4cmcr2:      { id: 'text_mm4f57rc',     type: 'text'      }, // Drivers License #
  text_mm3yy0pk:      { id: 'text_mm4fb3vm',     type: 'text'      }, // Emergency Contact
  long_text_mm3yj0b2: { id: 'long_text_mm4fc8h7',type: 'long_text' }, // Notes
  dropdown_mm3y41ay:  { id: 'dropdown_mm4fb5a2', type: 'dropdown'  }, // Preferred Department
  dropdown_mm3yd2n8:  { id: 'dropdown_mm4f2wwk', type: 'dropdown'  }, // Role/Position
  dropdown_mm3yexty:  { id: 'dropdown_mm4f5748', type: 'dropdown'  }, // Certifications
  dropdown_mm3ygwvc:  { id: 'dropdown_mm4fgn2w', type: 'dropdown'  }, // Compensation Type
  numeric_mm3ytmkt:   { id: 'numeric_mm4frczz',  type: 'number'    }, // Shop Prep Rate
  numeric_mm3ytc86:   { id: 'numeric_mm4ff2a6',  type: 'number'    }, // Hourly Rate
  boolean_mm3ywe31:   { id: 'boolean_mm4f3cpf',  type: 'checkbox'  }, // OT Eligible
  numeric_mm3yny33:   { id: 'numeric_mm4fzb53',  type: 'number'    }, // PTO Balance
  numeric_mm3y14jk:   { id: 'numeric_mm4f2cqq',  type: 'number'    }, // Per-Project Rate
  numeric_mm3y6ps9:   { id: 'numeric_mm4f7hmq',  type: 'number'    }, // Standard Day Rate
  numeric_mm3yhyg9:   { id: 'numeric_mm4fvb7h',  type: 'number'    }, // Commission Rate
  numeric_mm3yzv3r:   { id: 'numeric_mm4fv558',  type: 'number'    }, // Weekly Rate
  numeric_mm3yhbcs:   { id: 'numeric_mm4f2wt1',  type: 'number'    }, // Current Year Hours
  numeric_mm3ymc1r:   { id: 'numeric_mm4fs05y',  type: 'number'    }, // Weekly Hours Target
  numeric_mm3yb7h9:   { id: 'numeric_mm4fefza',  type: 'number'    }, // Annual Hour Target
  numeric_mm49tmm2:   { id: 'numeric_mm4f1prf',  type: 'number'    }, // Hours This Week
  numeric_mm49pf3k:   { id: 'numeric_mm4fa563',  type: 'number'    }, // Hours Last Week
  numeric_mm49mp0s:   { id: 'numeric_mm4f3vsh',  type: 'number'    }, // Avg Hours Per Week
  numeric_mm49vv1s:   { id: 'numeric_mm4fcy36',  type: 'number'    }, // Hours This Month
  color_mm3yqky6:     { id: 'color_mm4fhana',    type: 'status'    }, // Flex Status
  color_mm3ycyqg:     { id: 'color_mm4f2zz3',    type: 'status'    }, // Availability Status
};

module.exports = async (req, res) => {
  if (req.method === 'POST' && req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });

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
    const contactItemId = await createContactItem(crewMember.name);
    const columnValues = buildColumnValues(crewMember.columns);

    if (Object.keys(columnValues).length > 0) {
      await updateContactColumns(contactItemId, columnValues);
    }

    return res.status(200).json({ success: true, crewItemId, contactItemId });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

async function fetchCrewMember(itemId) {
  const query = `query { items(ids: [${itemId}]) { id name column_values { id value text type } } }`;
  const data = await mondayRequest(query);
  const item = data.items[0];
  const columns = {};
  item.column_values.forEach(col => { columns[col.id] = { value: col.value, text: col.text }; });
  return { id: item.id, name: item.name, columns };
}

async function createContactItem(name) {
  const mutation = `mutation { create_item(board_id: ${CONTACTS_BOARD_ID}, group_id: "${CONTACTS_INDIVIDUALS_GROUP}", item_name: ${JSON.stringify(name)}) { id } }`;
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
      case 'email':    if (source.text) val = { email: source.text, text: source.text }; break;
      case 'phone':    if (source.text) val = { phone: source.text.replace(/\D/g,''), countryShortName: 'US' }; break;
      case 'text':     if (source.text) val = source.text; break;
      case 'long_text':if (source.text) val = { text: source.text }; break;
      case 'number':   if (source.text && source.text !== '0') val = source.text; break;
      case 'checkbox':
        try { const p = JSON.parse(source.value || '{}'); if (p.checked) val = { checked: 'true' }; } catch(e) {}
        break;
      case 'dropdown':
        try { const p = JSON.parse(source.value || '{}'); if (p.ids?.length) val = { ids: p.ids }; } catch(e) {}
        break;
      case 'status':   if (source.text) val = { label: source.text }; break;
    }
    if (val !== null) result[mapping.id] = val;
  }
  return result;
}

async function updateContactColumns(itemId, columnValues) {
  const mutation = `mutation { change_multiple_column_values(item_id: ${itemId}, board_id: ${CONTACTS_BOARD_ID}, column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
  await mondayRequest(mutation);
}

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
