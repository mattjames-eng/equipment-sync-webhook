import { google } from 'googleapis';

const MONDAY_API_URL = 'https://api.monday.com/v2';

// ── Advance Package Constants ────────────────────────────────
const ADVANCE_TEMPLATE_ID       = '1nu2TOyAuIWj9uNVXbGUkgSOwLN5VXEWrm9vnv8676LE';
const ADVANCE_PACKAGES_BOARD_ID = '18416589368';

const AP = {
  eventDate:           'date_mm41b64p',
  callTime:            'text_mm41e8w1',
  venueDetails:        'long_text_mm41gm07',
  travelDetails:       'long_text_mm41hh7m',
  specialRequirements: 'long_text_mm41rp3w',
  showOverview:        'long_text_mm4j3yp',
  audioDetails:        'long_text_mm4jzzew',
  lightingDetails:     'long_text_mm4jrw3m',
  videoDetails:        'long_text_mm4j4bk2',
  stagingDetails:      'long_text_mm4jfd7c',
  riggingDetails:      'long_text_mm4jfr1r',
  laserDetails:        'long_text_mm4jn45s',
  sfxDetails:          'long_text_mm4jj18d',
  packagePDF:          'file_mm41ky95',
  crewAssignment:      'board_relation_mm41t8fy',
  dailySchedule:       'board_relation_mm4j9t0s',
};

const DS = {
  dayNum:   'numeric_mm4jmdr8',
  date:     'date_mm4jqqqc',
  dayType:  'color_mm4jz51h',
  callTime: 'hour_mm4jppaz',
  wrapTime: 'hour_mm4j1kp0',
  dayNotes: 'long_text_mm4jtwxy',
};

const CA = {
  role:       'dropdown_mm3ymhp1',
  pm:         'lookup_mm3y9f9t',
  crewMember: 'board_relation_mm3y1w67',
};

const ROLE_TO_DEPT = {
  'Audio Engineer':    { dept: '🎵 Audio',      label: '🎵 Audio Details',      key: 'audioDetails' },
  'Lighting Director': { dept: '💡 Lighting',   label: '💡 Lighting Details',   key: 'lightingDetails' },
  'Lighting Tech':     { dept: '💡 Lighting',   label: '💡 Lighting Details',   key: 'lightingDetails' },
  'Lighting Engineer': { dept: '💡 Lighting',   label: '💡 Lighting Details',   key: 'lightingDetails' },
  'Video Director':    { dept: '📺 Video',      label: '📺 Video Details',      key: 'videoDetails' },
  'Video Engineer':    { dept: '📺 Video',      label: '📺 Video Details',      key: 'videoDetails' },
  'Video Tech':        { dept: '📺 Video',      label: '📺 Video Details',      key: 'videoDetails' },
  'Stagehand':         { dept: '🎪 Staging',    label: '🎪 Staging Details',    key: 'stagingDetails' },
  'Rigger':            { dept: '🔩 Rigging',    label: '🔩 Rigging Details',    key: 'riggingDetails' },
  'Up Rigger':         { dept: '🔩 Rigging',    label: '🔩 Rigging Details',    key: 'riggingDetails' },
  'Down Rigger':       { dept: '🔩 Rigging',    label: '🔩 Rigging Details',    key: 'riggingDetails' },
  'Laser Operator':    { dept: '🔴 Laser',      label: '🔴 Laser Details',      key: 'laserDetails' },
  'Laser Tech':        { dept: '🔴 Laser',      label: '🔴 Laser Details',      key: 'laserDetails' },
  'SFX Operator':      { dept: '🎆 Special FX', label: '🎆 Special FX Details', key: 'sfxDetails' },
  'SFX Tech':          { dept: '🎆 Special FX', label: '🎆 Special FX Details', key: 'sfxDetails' },
};

// ── Shared helpers ───────────────────────────────────────────
function apColText(columns, colId) {
  const col = columns.find(c => c.id === colId);
  return col?.text?.trim() || '—';
}

function apLinkedIds(columns, colId) {
  const col = columns.find(c => c.id === colId);
  if (!col?.value) return [];
  try {
    const val = JSON.parse(col.value);
    return val?.linkedPulseIds?.map(p => String(p.linkedPulseId)) || [];
  } catch { return []; }
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // ── Route: advance-package vs default contract ───────────
  const route = req.query?.route;
  if (route === 'advance-package') {
    return handleAdvancePackage(req, res);
  }

  // ── DEFAULT: Original Contract Generation ────────────────
  const event = req.body?.event || req.body || {};
  const itemId = event.pulseId || event.itemId;
  if (!itemId) return res.status(400).json({ success: false, error: 'Missing target item ID variable' });

  try {
    console.log(`📥 Initializing Document Generation Pipeline for Contract Row: ${itemId}`);

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    const docs = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const contractData = await fetchContractData(itemId);

    if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
      throw new Error('CRITICAL: Missing GOOGLE_DRIVE_FOLDER_ID environment variable in configuration parameters matrix.');
    }

    const copyResponse = await drive.files.copy({
      fileId: process.env.CONTRACT_TEMPLATE_ID,
      supportsAllDrives: true,
      requestBody: {
        name: `Contract - ${contractData.crewMember} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
      }
    });
    const newDocId = copyResponse.data.id;
    console.log(`📄 Transient processing document instance safely initialized in shared folder: ${newDocId}`);

    const currentFormattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const replacements = [
      { search: '{{date}}',                    replace: currentFormattedDate },
      { search: '{{contract_id}}',             replace: contractData.contractId },
      { search: '{{crew_member}}',             replace: contractData.crewMember },
      { search: '{{position}}',                replace: contractData.position },
      { search: '{{crew_email}}',              replace: contractData.crewEmail },
      { search: '{{crew_phone}}',              replace: contractData.crewPhone },
      { search: '{{project_name}}',            replace: contractData.projectName },
      { search: '{{client_name}}',             replace: contractData.clientName },
      { search: '{{venue_name}}',              replace: contractData.venueName },
      { search: '{{start_date}}',              replace: contractData.startDate },
      { search: '{{end_date}}',                replace: contractData.endDate },
      { search: '{{contract_type}}',           replace: contractData.contractType },
      { search: '{{contract_amount}}',         replace: contractData.contractAmount },
      { search: '{{agent_commission}}',        replace: contractData.agentCommission },
      { search: '{{agent_commission_amount}}', replace: contractData.agentCommissionAmount },
      { search: '{{final_agreed_rate}}',       replace: contractData.finalAgreedRate },
      { search: '{{payment_schedule}}',        replace: contractData.paymentSchedule },
      { search: '{{scope_of_work}}',           replace: contractData.scopeOfWork },
      { search: '{{contract_notes}}',          replace: contractData.contractNotes },
      { search: '{{per_diem}}',                replace: contractData.perDiem },
      { search: '{{company_equipment}}',       replace: contractData.companyEquipment },
      { search: '{{contractor_equipment}}',    replace: contractData.contractorEquipment },
      { search: '{{insurance_requirement}}',   replace: contractData.insuranceRequirement },
      { search: '{{company_signatory}}',       replace: contractData.companySignatory },
      { search: '{{company_signatory_title}}', replace: contractData.companySignatoryTitle }
    ];

    await docs.documents.batchUpdate({
      documentId: newDocId,
      requestBody: {
        requests: replacements.map(r => ({
          replaceAllText: {
            containsText: { text: r.search, matchCase: true },
            replaceText: r.replace
          }
        }))
      }
    });

    const pdfResponse = await drive.files.export({
      fileId: newDocId,
      mimeType: 'application/pdf',
      supportsAllDrives: true
    }, { responseType: 'arraybuffer' });

    const pdfBuffer = Buffer.from(pdfResponse.data);

    console.log('🧹 Clearing existing contract documents...');
    await mondayApiCall(`
      mutation {
        change_column_value(
          item_id: ${itemId},
          board_id: 18415879229,
          column_id: "doc_mm3y4td1",
          value: "{}"
        ) { id }
      }
    `);

    console.log('📦 Streaming binary contract parameters to asset storage matrix...');
    const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const uploadForm = new FormData();

    uploadForm.append('query', `
      mutation ($file: File!) {
        add_file_to_column(
          item_id: ${itemId},
          column_id: "doc_mm3y4td1",
          file: $file
        ) { id }
      }
    `);

    const uniformFileName = `Contract_${(contractData.crewMember || 'Crew').replace(/\s+/g, '_')}.pdf`;
    uploadForm.append('variables[file]', pdfBlob, uniformFileName);

    const uploadResponse = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: { 'Authorization': process.env.MONDAY_API_KEY },
      body: uploadForm
    });

    const uploadResult = await uploadResponse.json();
    if (uploadResult.errors) throw new Error(JSON.stringify(uploadResult.errors));

    console.log('🔄 Updating contract status...');
    await mondayApiCall(`
      mutation {
        change_column_value(
          item_id: ${itemId},
          board_id: 18415879229,
          column_id: "color_mm3y7397",
          value: "{\\"label\\":\\"Sent to Tech\\"}"
        ) { id }
      }
    `);
    console.log('✅ Status updated to "Sent to Tech"');

    try {
      await drive.files.delete({ fileId: newDocId, supportsAllDrives: true });
      console.log(`🗑️ Temporary document deleted: ${newDocId}`);
    } catch (cleanupError) {
      console.warn(`⚠️ Could not delete temporary document ${newDocId}: ${cleanupError.message}`);
      console.warn('This is non-fatal - contract generation succeeded.');
    }

    console.log(`🏁 Pipeline execution cleanly terminated for record: ${itemId}`);
    return res.status(200).json({ success: true, message: 'Contract package saved successfully.' });

  } catch (error) {
    console.error('❌ Automation engine faulted:', error);
    try {
      await mondayApiCall(`mutation { change_column_value(item_id: ${itemId}, board_id: 18415879229, column_id: "color_mm3y7397", value: "{\\"label\\":\\"Draft\\"}") { id } }`);
    } catch (e) { console.error('Fallback update pipeline failure context:', e); }
    return res.status(500).json({ success: false, error: error.message });
  }
}

// ── ADVANCE PACKAGE HANDLER ──────────────────────────────────
async function handleAdvancePackage(req, res) {
  let newDocId = null;

  const event = req.body?.event || req.body || {};
  const itemId = event.pulseId || event.itemId;
  if (!itemId) return res.status(400).json({ success: false, error: 'Missing item ID' });

  try {
    console.log(`📥 [AdvancePackage] Generating PDF for item ${itemId}`);

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    const docs  = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Step 1: Fetch Advance Package item
    const itemData = await mondayApiCall(`
      query {
        items(ids: [${itemId}]) {
          id name
          column_values { id value text }
        }
      }
    `);

    const item = itemData.data?.items?.[0];
    if (!item) throw new Error(`Item ${itemId} not found on Advance Packages board`);

    const cols = item.column_values;
    const showName            = item.name;
    const eventDate           = apColText(cols, AP.eventDate);
    const callTime            = apColText(cols, AP.callTime);
    const venueDetails        = apColText(cols, AP.venueDetails);
    const travelDetails       = apColText(cols, AP.travelDetails);
    const specialRequirements = apColText(cols, AP.specialRequirements);
    const showOverview        = apColText(cols, AP.showOverview);

    const deptValues = {
      audioDetails:    apColText(cols, AP.audioDetails),
      lightingDetails: apColText(cols, AP.lightingDetails),
      videoDetails:    apColText(cols, AP.videoDetails),
      stagingDetails:  apColText(cols, AP.stagingDetails),
      riggingDetails:  apColText(cols, AP.riggingDetails),
      laserDetails:    apColText(cols, AP.laserDetails),
      sfxDetails:      apColText(cols, AP.sfxDetails),
    };

    // Step 2: Crew Assignment → role, PM, crew name
    let crewName = '—', role = '—', pmName = '—';
    let department = '—', departmentLabel = 'Department Details', departmentDetails = '—';

    const assignmentIds = apLinkedIds(cols, AP.crewAssignment);
    if (assignmentIds.length > 0) {
      const assignData = await mondayApiCall(`
        query {
          items(ids: [${assignmentIds[0]}]) {
            column_values {
              id value text
              ... on BoardRelationValue { linked_items { id name } }
            }
          }
        }
      `);

      const aCols = assignData.data?.items?.[0]?.column_values || [];
      role   = apColText(aCols, CA.role);
      pmName = apColText(aCols, CA.pm);

      const crewRelCol   = aCols.find(c => c.id === CA.crewMember);
      const crewMemberId = crewRelCol?.linked_items?.[0]?.id;
      if (crewMemberId) {
        const crewData = await mondayApiCall(`
          query { items(ids: [${crewMemberId}]) { name } }
        `);
        crewName = crewData.data?.items?.[0]?.name || '—';
      }

      const deptInfo = ROLE_TO_DEPT[role];
      if (deptInfo) {
        department        = deptInfo.dept;
        departmentLabel   = deptInfo.label;
        departmentDetails = deptValues[deptInfo.key] || '—';
      }
    }

    // Step 3: Daily Schedule items
    let dailyScheduleText = 'Single day event — see call time above.';
    const scheduleIds = apLinkedIds(cols, AP.dailySchedule);

    if (scheduleIds.length > 0) {
      const schedData = await mondayApiCall(`
        query {
          items(ids: [${scheduleIds.join(',')}]) {
            name column_values { id value text }
          }
        }
      `);

      const days = (schedData.data?.items || []).map(d => ({
        dayNum:   apColText(d.column_values, DS.dayNum),
        date:     apColText(d.column_values, DS.date),
        dayType:  apColText(d.column_values, DS.dayType),
        callTime: apColText(d.column_values, DS.callTime),
        wrapTime: apColText(d.column_values, DS.wrapTime),
        notes:    apColText(d.column_values, DS.dayNotes),
      })).sort((a, b) => new Date(a.date) - new Date(b.date));

      dailyScheduleText = days.map(d => {
        const header = `Day ${d.dayNum} — ${d.date}  |  ${d.dayType}  |  Call: ${d.callTime}  |  Wrap: ${d.wrapTime}`;
        return d.notes !== '—' ? `${header}\n${d.notes}` : header;
      }).join('\n\n');
    }

    // Step 4: Clone template
    const copy = await drive.files.copy({
      fileId: ADVANCE_TEMPLATE_ID,
      supportsAllDrives: true,
      requestBody: { name: `Advance — ${showName} — ${crewName}` },
      fields: 'id',
    });
    newDocId = copy.data.id;
    console.log(`📄 [AdvancePackage] Cloned template → ${newDocId}`);

    // Step 5: Replace placeholders
    const dateGenerated = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    await docs.documents.batchUpdate({
      documentId: newDocId,
      requestBody: {
        requests: [
          ['{{SHOW_NAME}}',            showName],
          ['{{EVENT_DATE}}',           eventDate],
          ['{{CALL_TIME}}',            callTime],
          ['{{CREW_NAME}}',            crewName],
          ['{{ROLE}}',                 role],
          ['{{DEPARTMENT}}',           department],
          ['{{PM_NAME}}',              pmName],
          ['{{DATE_GENERATED}}',       dateGenerated],
          ['{{VENUE_DETAILS}}',        venueDetails],
          ['{{TRAVEL_DETAILS}}',       travelDetails],
          ['{{SPECIAL_REQUIREMENTS}}', specialRequirements],
          ['{{SHOW_OVERVIEW}}',        showOverview],
          ['{{DEPARTMENT_LABEL}}',     departmentLabel],
          ['{{DEPARTMENT_DETAILS}}',   departmentDetails],
          ['{{DAILY_SCHEDULE}}',       dailyScheduleText],
        ].map(([text, replaceText]) => ({
          replaceAllText: {
            containsText: { text, matchCase: true },
            replaceText: replaceText || '—',
          },
        })),
      },
    });

    // Step 6: Export as PDF
    const pdfResponse = await drive.files.export(
      { fileId: newDocId, mimeType: 'application/pdf', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(pdfResponse.data);
    console.log(`📦 [AdvancePackage] PDF exported — ${pdfBuffer.length} bytes`);

    // Step 7: Clear existing file column
    await mondayApiCall(`
      mutation {
        change_column_value(
          item_id: ${itemId},
          board_id: ${ADVANCE_PACKAGES_BOARD_ID},
          column_id: "${AP.packagePDF}",
          value: "{\\"clear_all\\": true}"
        ) { id }
      }
    `);

    // Step 8: Upload PDF
    const safeShow = showName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
    const safeCrew = crewName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const fileName = `Advance_${safeShow}_${safeCrew}.pdf`;

    const formData = new FormData();
    formData.append('query', `
      mutation ($file: File!) {
        add_file_to_column(
          item_id: ${itemId},
          column_id: "${AP.packagePDF}",
          file: $file
        ) { id }
      }
    `);
    formData.append('variables[file]', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: { 'Authorization': process.env.MONDAY_API_KEY },
      body: formData,
    });
    if (!uploadRes.ok) throw new Error(`PDF upload failed: ${await uploadRes.text()}`);
    console.log(`✅ [AdvancePackage] PDF uploaded → ${fileName}`);

    // Step 9: Delete temp doc
    try {
      await drive.files.delete({ fileId: newDocId, supportsAllDrives: true });
      console.log(`🗑️ [AdvancePackage] Temp doc deleted: ${newDocId}`);
      newDocId = null;
    } catch (cleanupError) {
      console.warn(`⚠️ Could not delete temp doc ${newDocId}: ${cleanupError.message} (non-fatal)`);
    }

    console.log(`🏁 [AdvancePackage] Done for item ${itemId}`);
    return res.status(200).json({ success: true, message: `Advance package PDF generated for ${crewName} — ${showName}` });

  } catch (err) {
    console.error('❌ [AdvancePackage] Error:', err.message);
    if (newDocId) {
      try {
        const auth = new google.auth.GoogleAuth({
          credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
          scopes: ['https://www.googleapis.com/auth/drive']
        });
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId: newDocId, supportsAllDrives: true });
        console.log('[AdvancePackage] Cleaned up temp doc after error');
      } catch (e) { console.error('[AdvancePackage] Cleanup error (non-fatal):', e.message); }
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ── fetchContractData ────────────────────────────────────────
async function fetchContractData(itemId) {
  const query = `query {
    items(ids: [${itemId}]) {
      id name
      column_values {
        id text value
        ... on BoardRelationValue { linked_items { id name } }
      }
    }
  }`;

  const response = await mondayApiCall(query);
  const item = response.data?.items?.[0];
  const columns = item?.column_values || [];

  const getCol = (id) => columns.find(c => c.id === id)?.text || '';
  const getColValue = (id) => {
    const col = columns.find(c => c.id === id);
    if (!col?.value) return '';
    try { return JSON.parse(col.value); } catch { return col.text || ''; }
  };

  const crewRelationCol = columns.find(c => c.id === 'board_relation_mm3yckmg');
  const crewMemberId = crewRelationCol?.linked_items?.[0]?.id;

  console.log('🔍 Crew Member ID:', crewMemberId);

  let crewData = {
    name: 'Independent Contractor',
    email: 'TBD',
    phone: 'TBD',
    position: 'Production Technician'
  };

  if (crewMemberId) {
    try {
      console.log('📞 Fetching crew data for ID:', crewMemberId);
      const crewQuery = `query {
        items(ids: [${crewMemberId}]) {
          name
          column_values { id text }
        }
      }`;
      const crewResponse = await mondayApiCall(crewQuery);
      const crewItem = crewResponse.data?.items?.[0];
      if (crewItem) {
        crewData.name     = crewItem.name;
        const crewCols    = crewItem.column_values || [];
        crewData.email    = crewCols.find(c => c.id === 'email_mm3yfhmg')?.text || 'TBD';
        crewData.phone    = crewCols.find(c => c.id === 'phone_mm3yd44g')?.text || 'TBD';
        crewData.position = crewCols.find(c => c.id === 'dropdown_mm3yd2n8')?.text || 'Production Technician';
        console.log('✅ Crew data fetched:', crewData);
      }
    } catch (error) {
      console.error('❌ Could not fetch crew member data:', error.message);
    }
  } else {
    console.warn('⚠️ No crew member ID found in board relation');
  }

  const startDate = getColValue('date_mm3y5whf');
  const endDate   = getColValue('date_mm3yndhd');
  const formatDate = (dateObj) => {
    if (!dateObj?.date) return 'TBD';
    const d = new Date(dateObj.date);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const contractAmount    = parseFloat(getCol('numeric_mm3yae4w')) || 0;
  const commissionPercent = parseFloat(getCol('numeric_mm3yywfk')) || 0;
  const commissionAmount  = (contractAmount * commissionPercent / 100).toFixed(2);
  const netPayment        = (contractAmount - commissionAmount).toFixed(2);

  return {
    contractId:             item.id,
    crewMember:             crewData.name,
    position:               crewData.position,
    crewEmail:              crewData.email,
    crewPhone:              crewData.phone,
    projectName:            getCol('board_relation_mm3yxkvs') || item.name,
    clientName:             'TBD',
    venueName:              getCol('board_relation_mm3y7kar') || 'TBD',
    startDate:              formatDate(startDate),
    endDate:                formatDate(endDate),
    contractType:           getCol('dropdown_mm3yt6p2') || 'Day Rate',
    contractAmount:         contractAmount.toFixed(2),
    agentCommission:        commissionPercent.toFixed(1),
    agentCommissionAmount:  commissionAmount,
    finalAgreedRate:        netPayment,
    paymentSchedule:        getCol('long_text_mm3yypxx') || 'Net 30 upon completion',
    scopeOfWork:            getCol('long_text_mm3ypebd') || 'Production services as assigned',
    contractNotes:          getCol('long_text_mm3y3094') || 'None',
    perDiem:                getCol('long_text_mm3yc7q7') || '$50/day (if applicable)',
    companyEquipment:       'All production equipment as specified in production rider',
    contractorEquipment:    getCol('long_text_mm3yrfaa') || 'Personal tools and safety equipment',
    insuranceRequirement:   'General liability insurance recommended but not required for day rates under $5,000',
    companySignatory:       'Matt James',
    companySignatoryTitle:  'General Manager'
  };
}

// ── mondayApiCall ────────────────────────────────────────────
async function mondayApiCall(query) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_KEY,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data;
}
