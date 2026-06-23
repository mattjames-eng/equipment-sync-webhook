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
  dayNum:        'numeric_mm4jmdr8',
  date:          'date_mm4jqqqc',
  dayType:       'color_mm4jz51h',
  callTime:      'hour_mm4jppaz',
  wrapTime:      'hour_mm4j1kp0',
  dayNotes:      'long_text_mm4jtwxy',
  breakSchedule: 'long_text_mm4kv6g7',
  dailyTasks:    'long_text_mm4kbyhe',
  reportTo:      'text_mm4kqzf',
};

// ── Crew Assignment travel column IDs ────────────────────────
const CA_TRAVEL = {
  travelRequired:   'boolean_mm3yr7bn',
  travelNotes:      'long_text_mm3y6myf',
  bookingDetails:   'long_text_mm3yzrf0',
  specialReqs:      'long_text_mm3ynq0',
  // ✈️ Outbound flight
  depAirport:       'text_mm43916d',
  arrAirport:       'text_mm43vmsd',
  depDate:          'date_mm43db27',
  depTime:          'hour_mm49krhd',
  arrDate:          'date_mm43ctmh',
  arrTime:          'hour_mm499g4j',
  flightNumOut:     'text_mm43px9p',
  airline:          'text_mm43k10m',
  confirmOut:       'text_mm43x848',
  // ✈️ Return flight
  retDepAirport:    'text_mm494548',
  retArrAirport:    'text_mm49tdzy',
  retDepDate:       'date_mm43x5w0',
  retDepTime:       'hour_mm49xn0p',
  retArrDate:       'date_mm43t4pw',
  retArrTime:       'hour_mm492d1m',
  flightNumRet:     'text_mm435t6s',
  // 🏨 Hotel
  hotelName:        'text_mm43y099',
  hotelAddress:     'long_text_mm43mq97',
  hotelCheckIn:     'date_mm43en7b',
  hotelCheckInTime: 'hour_mm49afzj',
  hotelCheckOut:    'date_mm43zmaj',
  hotelCheckOutTime:'hour_mm49xtr5',
  hotelConfirm:     'text_mm436s33',
  hotelPhone:       'phone_mm43519t',
  // 🚗 Car rental
  carCompany:       'text_mm43fve1',
  carType:          'text_mm43a8tw',
  carPickupLoc:     'text_mm43296r',
  carPickupDate:    'date_mm43dtbe',
  carPickupTime:    'hour_mm49secw',
  carReturnDate:    'date_mm434e7x',
  carReturnTime:    'hour_mm49mdz',
  carConfirm:       'text_mm43p3np',
  // 💵 Per diem
  perDiemRate:      'numeric_mm43dk5h',
  perDiemStart:     'date_mm43hxpj',
  perDiemEnd:       'date_mm43804x',
  perDiemTotal:     'formula_mm43fd1b',
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
  // Prefer typed linked_items (populated when BoardRelationValue fragment is in the query)
  if (col?.linked_items?.length) return col.linked_items.map(i => String(i.id));
  // Fallback: parse raw JSON value (older API responses)
  if (!col?.value) return [];
  try {
    const val = JSON.parse(col.value);
    return val?.linkedPulseIds?.map(p => String(p.linkedPulseId)) || [];
  } catch { return []; }
}

// ── Travel block builder ─────────────────────────────────────
function buildTravelBlock(aCols) {
  const get = (id) => aCols.find(c => c.id === id)?.text?.trim() || '';

  const travelRequired = aCols.find(c => c.id === CA_TRAVEL.travelRequired)?.text;
  if (!travelRequired || travelRequired === 'false' || travelRequired === 'v' === false) {
    // checkbox: text is 'true' when checked
    const checked = aCols.find(c => c.id === CA_TRAVEL.travelRequired);
    if (!checked || checked.text !== 'true') {
      return 'No travel required for this assignment.';
    }
  }

  const lines = [];

  // ── Outbound flight ──
  const airline    = get(CA_TRAVEL.airline);
  const flightOut  = get(CA_TRAVEL.flightNumOut);
  const depAirport = get(CA_TRAVEL.depAirport);
  const arrAirport = get(CA_TRAVEL.arrAirport);
  const depDate    = get(CA_TRAVEL.depDate);
  const depTime    = get(CA_TRAVEL.depTime);
  const arrDate    = get(CA_TRAVEL.arrDate);
  const arrTime    = get(CA_TRAVEL.arrTime);
  const confirmOut = get(CA_TRAVEL.confirmOut);

  if (airline || flightOut || depAirport) {
    lines.push('✈️  OUTBOUND FLIGHT');
    if (airline && flightOut)  lines.push(`   ${airline} ${flightOut}`);
    else if (flightOut)        lines.push(`   Flight: ${flightOut}`);
    if (depAirport && arrAirport) lines.push(`   ${depAirport} → ${arrAirport}`);
    if (depDate && depTime)    lines.push(`   Departs: ${fmtDate(depDate)} at ${depTime}`);
    else if (depDate)          lines.push(`   Departs: ${fmtDate(depDate)}`);
    if (arrDate && arrTime)    lines.push(`   Arrives: ${fmtDate(arrDate)} at ${arrTime}`);
    else if (arrDate)          lines.push(`   Arrives: ${fmtDate(arrDate)}`);
    if (confirmOut)            lines.push(`   Confirmation: ${confirmOut}`);
    lines.push('');
  }

  // ── Return flight ──
  const flightRet    = get(CA_TRAVEL.flightNumRet);
  const retDepAirport = get(CA_TRAVEL.retDepAirport);
  const retArrAirport = get(CA_TRAVEL.retArrAirport);
  const retDepDate   = get(CA_TRAVEL.retDepDate);
  const retDepTime   = get(CA_TRAVEL.retDepTime);
  const retArrDate   = get(CA_TRAVEL.retArrDate);
  const retArrTime   = get(CA_TRAVEL.retArrTime);

  if (flightRet || retDepAirport) {
    lines.push('✈️  RETURN FLIGHT');
    if (airline && flightRet)      lines.push(`   ${airline} ${flightRet}`);
    else if (flightRet)            lines.push(`   Flight: ${flightRet}`);
    if (retDepAirport && retArrAirport) lines.push(`   ${retDepAirport} → ${retArrAirport}`);
    if (retDepDate && retDepTime)  lines.push(`   Departs: ${fmtDate(retDepDate)} at ${retDepTime}`);
    else if (retDepDate)           lines.push(`   Departs: ${fmtDate(retDepDate)}`);
    if (retArrDate && retArrTime)  lines.push(`   Arrives: ${fmtDate(retArrDate)} at ${retArrTime}`);
    else if (retArrDate)           lines.push(`   Arrives: ${fmtDate(retArrDate)}`);
    lines.push('');
  }

  // ── Hotel ──
  const hotelName     = get(CA_TRAVEL.hotelName);
  const hotelAddress  = get(CA_TRAVEL.hotelAddress);
  const hotelCheckIn  = get(CA_TRAVEL.hotelCheckIn);
  const hotelCITime   = get(CA_TRAVEL.hotelCheckInTime);
  const hotelCheckOut = get(CA_TRAVEL.hotelCheckOut);
  const hotelCOTime   = get(CA_TRAVEL.hotelCheckOutTime);
  const hotelConfirm  = get(CA_TRAVEL.hotelConfirm);
  const hotelPhone    = get(CA_TRAVEL.hotelPhone);

  if (hotelName || hotelAddress) {
    lines.push('🏨  HOTEL');
    if (hotelName)    lines.push(`   ${hotelName}`);
    if (hotelAddress) lines.push(`   ${hotelAddress}`);
    if (hotelCheckIn) lines.push(`   Check-In:  ${fmtDate(hotelCheckIn)}${hotelCITime ? ' at ' + hotelCITime : ''}`);
    if (hotelCheckOut) lines.push(`   Check-Out: ${fmtDate(hotelCheckOut)}${hotelCOTime ? ' at ' + hotelCOTime : ''}`);
    if (hotelConfirm) lines.push(`   Confirmation: ${hotelConfirm}`);
    if (hotelPhone)   lines.push(`   Phone: ${hotelPhone}`);
    lines.push('');
  }

  // ── Car rental ──
  const carCompany   = get(CA_TRAVEL.carCompany);
  const carType      = get(CA_TRAVEL.carType);
  const carPickupLoc = get(CA_TRAVEL.carPickupLoc);
  const carPickupDate = get(CA_TRAVEL.carPickupDate);
  const carPickupTime = get(CA_TRAVEL.carPickupTime);
  const carReturnDate = get(CA_TRAVEL.carReturnDate);
  const carReturnTime = get(CA_TRAVEL.carReturnTime);
  const carConfirm   = get(CA_TRAVEL.carConfirm);

  if (carCompany || carPickupLoc) {
    lines.push('🚗  CAR RENTAL');
    if (carCompany && carType) lines.push(`   ${carCompany} — ${carType}`);
    else if (carCompany)       lines.push(`   ${carCompany}`);
    if (carPickupLoc)          lines.push(`   Pickup: ${carPickupLoc}`);
    if (carPickupDate)         lines.push(`   Pick-Up: ${fmtDate(carPickupDate)}${carPickupTime ? ' at ' + carPickupTime : ''}`);
    if (carReturnDate)         lines.push(`   Return:  ${fmtDate(carReturnDate)}${carReturnTime ? ' at ' + carReturnTime : ''}`);
    if (carConfirm)            lines.push(`   Confirmation: ${carConfirm}`);
    lines.push('');
  }

  // ── Per diem ──
  const perDiemRate  = get(CA_TRAVEL.perDiemRate);
  const perDiemStart = get(CA_TRAVEL.perDiemStart);
  const perDiemEnd   = get(CA_TRAVEL.perDiemEnd);
  const perDiemTotal = get(CA_TRAVEL.perDiemTotal);

  if (perDiemRate) {
    lines.push('💵  PER DIEM');
    lines.push(`   Rate: $${perDiemRate}/day`);
    if (perDiemStart && perDiemEnd) lines.push(`   ${fmtDate(perDiemStart)} — ${fmtDate(perDiemEnd)}`);
    if (perDiemTotal) lines.push(`   Total: $${perDiemTotal}`);
    lines.push('');
  }

  // ── PM travel notes / booking details ──
  const travelNotes   = get(CA_TRAVEL.travelNotes);
  const bookingDetails = get(CA_TRAVEL.bookingDetails);
  if (travelNotes)    lines.push(`📝  Notes: ${travelNotes}`);
  if (bookingDetails) lines.push(`📝  Booking Details: ${bookingDetails}`);

  return lines.length > 0 ? lines.join('\n').trimEnd() : 'Travel details not yet entered.';
}

// ── Date formatter (used by travel block) ────────────────────
function fmtDate(dateStr) {
  if (!dateStr) return '';
  // dateStr may be "2026-06-25" or already formatted
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T12:00:00'));
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Full date formatter with day of week (for schedule) ──────
function fmtFullDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T12:00:00'));
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
          column_values {
            id value text
            ... on BoardRelationValue { linked_items { id name } }
          }
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
    // AP-level travel notes (PM override/supplement to Crew Assignment travel columns)
    const apTravelNotes       = apColText(cols, AP.travelDetails);
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
    let travelBlock = 'No travel required for this assignment.';

    if (assignmentIds.length > 0) {
      const assignData = await mondayApiCall(`
        query {
          items(ids: [${assignmentIds[0]}]) {
            column_values {
              id value text
              ... on BoardRelationValue { linked_items { id name } }
              ... on MirrorValue { display_value }
            }
          }
        }
      `);

      const aCols = assignData.data?.items?.[0]?.column_values || [];
      role = apColText(aCols, CA.role);
      // PM is a mirror/lookup column — display_value is the only reliable field
      const pmCol = aCols.find(c => c.id === CA.pm);
      pmName = pmCol?.display_value?.trim() || pmCol?.text?.trim() || '—';

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

      // Build travel block from Crew Assignment travel columns
      travelBlock = buildTravelBlock(aCols);
    }

    // Step 3: Daily Schedule — fetch from Daily Show Schedules board via board_relation
    let dailyScheduleText = 'Single day event — see call time above.';
    const scheduleIds = apLinkedIds(cols, AP.dailySchedule);

    if (scheduleIds.length > 0) {
      const schedData = await mondayApiCall(`
        query {
          items(ids: [${scheduleIds.join(',')}]) {
            name
            column_values {
              id value text
            }
          }
        }
      `);

      const days = (schedData.data?.items || []).map(d => {
        const cv = d.column_values;
        return {
          dayNum:        apColText(cv, DS.dayNum),
          date:          apColText(cv, DS.date),
          dayType:       apColText(cv, DS.dayType),
          callTime:      apColText(cv, DS.callTime),
          wrapTime:      apColText(cv, DS.wrapTime),
          reportTo:      apColText(cv, DS.reportTo),
          breakSchedule: apColText(cv, DS.breakSchedule),
          dailyTasks:    apColText(cv, DS.dailyTasks),
          notes:         apColText(cv, DS.dayNotes),
        };
      }).sort((a, b) => {
        // Sort by date string; fall back to dayNum
        if (a.date !== '—' && b.date !== '—') return new Date(a.date) - new Date(b.date);
        return parseInt(a.dayNum) - parseInt(b.dayNum);
      });

      dailyScheduleText = days.map(d => {
        const fullDate = d.date !== '—' ? fmtFullDate(d.date) : '';
        const header = [
          `── DAY ${d.dayNum}${d.dayType !== '—' ? ' · ' + d.dayType : ''}${fullDate ? ' · ' + fullDate : ''} ──`,
          `Call: ${d.callTime}  |  Wrap: ${d.wrapTime}${d.reportTo !== '—' ? '  |  Report to: ' + d.reportTo : ''}`,
        ];
        if (d.dailyTasks !== '—')    header.push(`\nTasks:\n${d.dailyTasks}`);
        if (d.breakSchedule !== '—') header.push(`\nBreaks & Meals:\n${d.breakSchedule}`);
        if (d.notes !== '—')         header.push(`\nNotes:\n${d.notes}`);
        return header.join('\n');
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
          ['{{TRAVEL_DETAILS}}',       travelBlock],
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

    // Step 7: Clear existing file column (non-fatal — column may already be empty)
    try {
      await mondayApiCall(`
        mutation {
          change_column_value(
            item_id: ${itemId},
            board_id: ${ADVANCE_PACKAGES_BOARD_ID},
            column_id: "${AP.packagePDF}",
            value: "{}"
          ) { id }
        }
      `);
    } catch (clearErr) {
      console.warn('[AdvancePackage] Could not clear file column (non-fatal):', clearErr.message);
    }

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
