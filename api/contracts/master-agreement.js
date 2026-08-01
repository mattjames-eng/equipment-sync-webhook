import { google } from 'googleapis';

const MONDAY_API_URL = 'https://api.monday.com/v2';

// ── Board IDs ─────────────────────────────────────────────────
const CREW_DB_BOARD_ID = '18415879010';

// ── Crew Database column IDs ──────────────────────────────────
const CREW = {
  name:                 'name',
  email:                'email_mm3yfhmg',
  phone:                'phone_mm3yd44g',
  position:             'dropdown_mm3yd2n8',
  paymentSchedule:      'dropdown_mm5t2c73',
  masterContractStatus: 'color_mm5ts3cd',
  masterContractId:     'text_mm5t9pg5',
  masterContractLink:   'link_mm5tzqra',
  masterContractDate:   'date_mm5ty3hm',
  masterContractExpiry: 'date_mm5tc4yh',
};

// ── Static company info (override via env vars if needed) ─────
const COMPANY_SIGNATORY       = process.env.COMPANY_SIGNATORY       || 'Matt James';
const COMPANY_SIGNATORY_TITLE = process.env.COMPANY_SIGNATORY_TITLE || 'Owner';

// ── Helpers ───────────────────────────────────────────────────
async function mondayApiCall(query, variables) {
  const body = variables ? { query, variables } : { query };
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': process.env.MONDAY_API_KEY,
      'API-Version':   '2024-10',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data;
}

function toYMD(date) {
  return date.toISOString().split('T')[0];
}

// ── Fetch crew member data from Crew Database ─────────────────
async function fetchCrewData(itemId) {
  const q = 'query { items(ids: [' + itemId + ']) { id name column_values { id text } } }';
  const res = await mondayApiCall(q);
  const item = res.data?.items?.[0];
  if (!item) throw new Error('Crew member not found for item ID: ' + itemId);

  const cols = item.column_values || [];
  const get  = (id) => cols.find(c => c.id === id)?.text?.trim() || '';

  return {
    itemId,
    name:            item.name,
    email:           get(CREW.email)           || 'TBD',
    phone:           get(CREW.phone)           || 'TBD',
    position:        get(CREW.position)        || 'Production Technician',
    paymentSchedule: get(CREW.paymentSchedule) || 'per-show invoice',
  };
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event  = req.body?.event || req.body || {};
  const itemId = event.pulseId   || event.itemId;
  if (!itemId) return res.status(400).json({ success: false, error: 'Missing crew member item ID' });

  let newDocId = null;

  try {
    console.log('📥 [MasterAgreement] Generating for crew item:', itemId);

    // ── Auth ─────────────────────────────────────────────────
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive',
      ],
    });
    const docs  = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    // ── Fetch crew data ───────────────────────────────────────
    const crew = await fetchCrewData(itemId);
    console.log('✅ Crew data:', crew.name, '|', crew.position);

    // ── Generate contract metadata ────────────────────────────
    const now          = new Date();
    const year         = now.getFullYear();
    const contractId   = 'MICA-' + year + '-' + itemId;
    const effectiveDate = now.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    // Expiry = 12 months from today
    const expiryDate = new Date(now);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    // ── Validate required env vars ────────────────────────────
    if (!process.env.MASTER_AGREEMENT_TEMPLATE_ID) {
      throw new Error('MASTER_AGREEMENT_TEMPLATE_ID environment variable is not set');
    }
    if (!process.env.MASTER_AGREEMENTS_FOLDER_ID) {
      throw new Error('MASTER_AGREEMENTS_FOLDER_ID environment variable is not set');
    }

    // ── Copy the Google Doc template ──────────────────────────
    console.log('📋 Copying template', process.env.MASTER_AGREEMENT_TEMPLATE_ID, '→ folder', process.env.MASTER_AGREEMENTS_FOLDER_ID);
    const copyRes = await drive.files.copy({
      fileId:      process.env.MASTER_AGREEMENT_TEMPLATE_ID,
      requestBody: {
        name:    'Master Agreement - ' + crew.name + ' - ' + year,
        parents: [process.env.MASTER_AGREEMENTS_FOLDER_ID],
      },
      supportsAllDrives: true,
    });
    newDocId = copyRes.data.id;
    console.log('📄 Doc created:', newDocId);

    // ── Build placeholder replacements ────────────────────────
    const replacements = [
      { search: '{{date}}',                   replace: effectiveDate },
      { search: '{{contract_id}}',            replace: contractId },
      { search: '{{crew_member}}',            replace: crew.name },
      { search: '{{position}}',               replace: crew.position },
      { search: '{{crew_email}}',             replace: crew.email },
      { search: '{{crew_phone}}',             replace: crew.phone },
      { search: '{{payment_schedule}}',       replace: crew.paymentSchedule },
      { search: '{{company_signatory}}',      replace: COMPANY_SIGNATORY },
      { search: '{{company_signatory_title}}',replace: COMPANY_SIGNATORY_TITLE },
    ];

    // ── Apply replacements via Docs batchUpdate ───────────────
    const requests = replacements.map(({ search, replace }) => ({
      replaceAllText: {
        containsText: { text: search, matchCase: true },
        replaceText:  replace,
      },
    }));

    await docs.documents.batchUpdate({
      documentId:  newDocId,
      requestBody: { requests },
    });
    console.log('✅ Placeholders replaced');

    // ── Make doc accessible (anyone with link can view) ───────
    await drive.permissions.create({
      fileId:            newDocId,
      supportsAllDrives: true,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const docUrl = 'https://docs.google.com/document/d/' + newDocId + '/edit';
    console.log('🔗 Doc URL:', docUrl);

    // ── Update Crew Database record via GraphQL variables ────────
    const todayYMD  = toYMD(now);
    const expiryYMD = toYMD(expiryDate);

    const columnValues = {};
    columnValues[CREW.masterContractId]     = contractId;
    columnValues[CREW.masterContractStatus] = { label: 'Draft' };
    columnValues[CREW.masterContractDate]   = { date: todayYMD };
    columnValues[CREW.masterContractExpiry] = { date: expiryYMD };
    columnValues[CREW.masterContractLink]   = { url: docUrl, text: 'Master Agreement - ' + year };

    console.log('📝 Updating crew record columns...');
    const updateMutation = 'mutation UpdateCrewRecord($itemId: ID!, $boardId: ID!, $colVals: JSON!) { change_multiple_column_values(item_id: $itemId, board_id: $boardId, column_values: $colVals) { id } }';
    await mondayApiCall(updateMutation, {
      itemId:  String(itemId),
      boardId: CREW_DB_BOARD_ID,
      colVals: JSON.stringify(columnValues),
    });

    console.log('✅ Crew record updated — status: Draft, contract ID: ' + contractId);
    console.log('🏁 Master Agreement generated for:', crew.name);

    return res.status(200).json({
      success:    true,
      message:    'Master Agreement generated for ' + crew.name,
      contractId,
      docUrl,
    });

  } catch (error) {
    console.error('❌ Master Agreement generation failed:', error);

    // Best-effort: clean up orphaned doc
    if (newDocId) {
      try {
        await (google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({
          credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
          scopes: ['https://www.googleapis.com/auth/drive'],
        })})).files.delete({ fileId: newDocId, supportsAllDrives: true });
        console.warn('🗑️ Orphaned doc cleaned up:', newDocId);
      } catch (e) {
        console.warn('⚠️ Could not clean up orphaned doc:', e.message);
      }
    }

    return res.status(500).json({ success: false, error: error.message });
  }
}
