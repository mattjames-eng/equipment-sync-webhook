// /api/advance-package/generate.js

import { google } from 'googleapis';

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const TEMPLATE_DOC_ID = '1nu2TOyAuIWj9uNVXbGUkgSOwLN5VXEWrm9vnv8676LE';

const ADVANCE_PACKAGES_BOARD_ID = '18416589368';

// ── Advance Packages column IDs ──────────────────────────────
const AP = {
  eventDate:          'date_mm41b64p',
  callTime:           'text_mm41e8w1',
  venueDetails:       'long_text_mm41gm07',
  travelDetails:      'long_text_mm41hh7m',
  specialRequirements:'long_text_mm41rp3w',
  showOverview:       'long_text_mm4j3yp',
  audioDetails:       'long_text_mm4jzzew',
  lightingDetails:    'long_text_mm4jrw3m',
  videoDetails:       'long_text_mm4j4bk2',
  stagingDetails:     'long_text_mm4jfd7c',
  riggingDetails:     'long_text_mm4jfr1r',
  laserDetails:       'long_text_mm4jn45s',
  sfxDetails:         'long_text_mm4jj18d',
  packagePDF:         'file_mm41ky95',
  crewAssignment:     'board_relation_mm41t8fy',
  dailySchedule:      'board_relation_mm4j9t0s',
};

// ── Daily Show Schedules column IDs ─────────────────────────
const DS = {
  dayNum:    'numeric_mm4jmdr8',
  date:      'date_mm4jqqqc',
  dayType:   'color_mm4jz51h',
  callTime:  'hour_mm4jppaz',
  wrapTime:  'hour_mm4j1kp0',
  dayNotes:  'long_text_mm4jtwxy',
};

// ── Crew Assignments column IDs ──────────────────────────────
const CA = {
  role:       'dropdown_mm3ymhp1',
  pm:         'lookup_mm3y9f9t',
  crewMember: 'board_relation_mm3y1w67',
};

// ── Role → Department mapping ────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function colText(columns, colId) {
  const col = columns.find(c => c.id === colId);
  return col?.text?.trim() || '—';
}

function linkedIds(columns, colId) {
  const col = columns.find(c => c.id === colId);
  if (!col?.value) return [];
  try {
    const val = JSON.parse(col.value);
    return val?.linkedPulseIds?.map(p => String(p.linkedPulseId)) || [];
  } catch { return []; }
}

function formatHour(text) {
  return text && text !== '—' ? text : '—';
}

async function getGoogleClients() {
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_SERVICE_ACCOUNT,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const authClient = await auth.getClient();
  return {
    docs:  google.docs({ version: 'v1', auth: authClient }),
    drive: google.drive({ version: 'v3', auth: authClient }),
  };
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {

  // Monday.com challenge verification
  if (req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let newDocId = null;

  try {
    const itemId = String(req.body?.event?.pulseId || req.body?.pulseId);
    if (!itemId || itemId === 'undefined') {
      return res.status(400).json({ error: 'No item ID in webhook payload' });
    }

    console.log(`[AdvancePackage] Generating PDF for item ${itemId}`);

    // ── Step 1: Fetch Advance Package item ───────────────────
    const itemData = await mondayQuery(`
      query ($ids: [ID!]) {
        items(ids: $ids) {
          id
          name
          column_values { id value text }
        }
      }
    `, { ids: [itemId] });

    const item = itemData.items[0];
    if (!item) throw new Error(`Item ${itemId} not found on Advance Packages board`);

    const cols = item.column_values;
    const showName           = item.name;
    const eventDate          = colText(cols, AP.eventDate);
    const callTime           = colText(cols, AP.callTime);
    const venueDetails       = colText(cols, AP.venueDetails);
    const travelDetails      = colText(cols, AP.travelDetails);
    const specialRequirements= colText(cols, AP.specialRequirements);
    const showOverview       = colText(cols, AP.showOverview);

    const deptValues = {
      audioDetails:    colText(cols, AP.audioDetails),
      lightingDetails: colText(cols, AP.lightingDetails),
      videoDetails:    colText(cols, AP.videoDetails),
      stagingDetails:  colText(cols, AP.stagingDetails),
      riggingDetails:  colText(cols, AP.riggingDetails),
      laserDetails:    colText(cols, AP.laserDetails),
      sfxDetails:      colText(cols, AP.sfxDetails),
    };

    // ── Step 2: Crew Assignment → role, PM, crew name ────────
    let crewName         = '—';
    let role             = '—';
    let pmName           = '—';
    let department       = '—';
    let departmentLabel  = 'Department Details';
    let departmentDetails= '—';

    const assignmentIds = linkedIds(cols, AP.crewAssignment);
    if (assignmentIds.length > 0) {
      const assignData = await mondayQuery(`
        query ($ids: [ID!]) {
          items(ids: $ids) {
            column_values { id value text }
          }
        }
      `, { ids: assignmentIds });

      const aCols = assignData.items[0]?.column_values || [];

      role   = colText(aCols, CA.role);
      pmName = colText(aCols, CA.pm);

      // Get crew member name from Crew Database relation
      const crewMemberIds = linkedIds(aCols, CA.crewMember);
      if (crewMemberIds.length > 0) {
        const crewData = await mondayQuery(`
          query ($ids: [ID!]) { items(ids: $ids) { name } }
        `, { ids: crewMemberIds });
        crewName = crewData.items[0]?.name || '—';
      }

      // Map role → department details
      const deptInfo = ROLE_TO_DEPT[role];
      if (deptInfo) {
        department        = deptInfo.dept;
        departmentLabel   = deptInfo.label;
        departmentDetails = deptValues[deptInfo.key] || '—';
      }
    }

    // ── Step 3: Daily Schedule items ─────────────────────────
    let dailyScheduleText = 'Single day event — see call time above.';
    const scheduleIds = linkedIds(cols, AP.dailySchedule);

    if (scheduleIds.length > 0) {
      const schedData = await mondayQuery(`
        query ($ids: [ID!]) {
          items(ids: $ids) {
            name
            column_values { id value text }
          }
        }
      `, { ids: scheduleIds });

      const days = schedData.items.map(d => {
        const dc = d.column_values;
        return {
          name:     d.name,
          dayNum:   colText(dc, DS.dayNum),
          date:     colText(dc, DS.date),
          dayType:  colText(dc, DS.dayType),
          callTime: formatHour(colText(dc, DS.callTime)),
          wrapTime: formatHour(colText(dc, DS.wrapTime)),
          notes:    colText(dc, DS.dayNotes),
        };
      });

      // Sort by date ascending
      days.sort((a, b) => new Date(a.date) - new Date(b.date));

      dailyScheduleText = days.map(d => {
        const header = `Day ${d.dayNum} — ${d.date}  |  ${d.dayType}  |  Call: ${d.callTime}  |  Wrap: ${d.wrapTime}`;
        return d.notes !== '—' ? `${header}\n${d.notes}` : header;
      }).join('\n\n');
    }

    // ── Step 4: Clone Google Docs template ───────────────────
    const { docs, drive } = await getGoogleClients();

    const copy = await drive.files.copy({
      fileId: TEMPLATE_DOC_ID,
      requestBody: { name: `Advance — ${showName} — ${crewName}` },
      fields: 'id',
    });
    newDocId = copy.data.id;
    console.log(`[AdvancePackage] Cloned template → ${newDocId}`);

    // ── Step 5: Replace all placeholders ─────────────────────
    const dateGenerated = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const replacements = [
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
    ];

    await docs.documents.batchUpdate({
      documentId: newDocId,
      requestBody: {
        requests: replacements.map(([text, replaceText]) => ({
          replaceAllText: {
            containsText: { text, matchCase: true },
            replaceText: replaceText || '—',
          },
        })),
      },
    });

    // ── Step 6: Export as PDF ─────────────────────────────────
    const pdfRes = await drive.files.export(
      { fileId: newDocId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(pdfRes.data);
    console.log(`[AdvancePackage] PDF exported — ${pdfBuffer.length} bytes`);

    // ── Step 7: Clear existing file column ───────────────────
    await mondayQuery(`
      mutation {
        change_column_value(
          board_id: "${ADVANCE_PACKAGES_BOARD_ID}",
          item_id: "${itemId}",
          column_id: "${AP.packagePDF}",
          value: "{\\"clear_all\\": true}"
        ) { id }
      }
    `);

    // ── Step 8: Upload PDF to monday.com ─────────────────────
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
    formData.append(
      'variables[file]',
      new Blob([pdfBuffer], { type: 'application/pdf' }),
      fileName
    );

    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: { 'Authorization': MONDAY_API_KEY },
      body: formData,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`PDF upload failed: ${errText}`);
    }
    console.log(`[AdvancePackage] PDF uploaded → ${fileName}`);

    // ── Step 9: Delete temp Google Doc ───────────────────────
    await drive.files.delete({ fileId: newDocId });
    newDocId = null;
    console.log(`[AdvancePackage] Temp doc deleted. Done!`);

    return res.status(200).json({
      success: true,
      message: `Advance package PDF generated for ${crewName} — ${showName}`,
    });

  } catch (err) {
    console.error('[AdvancePackage] Error:', err.message);

    // Non-fatal cleanup
    if (newDocId) {
      try {
        const { drive } = await getGoogleClients();
        await drive.files.delete({ fileId: newDocId });
        console.log('[AdvancePackage] Cleaned up temp doc after error');
      } catch (cleanupErr) {
        console.error('[AdvancePackage] Cleanup error (non-fatal):', cleanupErr.message);
      }
    }

    return res.status(500).json({ error: err.message });
  }
}
