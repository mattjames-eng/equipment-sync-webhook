import { google } from 'googleapis';

const MONDAY_API_URL = 'https://api.monday.com/v2';

export default async function handler(req, res) {
  // 1. Establish Cross-Origin Response Headers for monday.com Webhook Handshakes
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  // Instantly handle monday's challenge verification if triggered via custom integration panel
  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body?.event || req.body || {};
  const itemId = event.pulseId || event.itemId;
  if (!itemId) return res.status(400).json({ success: false, error: 'Missing target item ID variable' });

  try {
    console.log(`📥 Initializing Document Generation Pipeline for Contract Row: ${itemId}`);

    // 2. Authenticate Google APIs using Vercel Environment Variables
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    const docs = google.docs({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    // 3. Extract Live Project Columns from Monday Row
    const contractData = await fetchContractData(itemId);

    // 4. Duplicate the Master Google Doc Template inside Google Drive (With Quota & Shared Drive Support)
    if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
      throw new Error('CRITICAL: Missing GOOGLE_DRIVE_FOLDER_ID environment variable in configuration parameters matrix.');
    }

    const copyResponse = await drive.files.copy({
      fileId: process.env.CONTRACT_TEMPLATE_ID,
      supportsAllDrives: true, // <-- CRITICAL: Overrides default account boundary scopes for Shared Drives
      requestBody: {
        name: `Contract - ${contractData.crewMember || 'Crew'} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] 
      }
    });
    const newDocId = copyResponse.data.id;
    console.log(`📄 Transient processing document instance safely initialized in shared folder: ${newDocId}`);

    // 5. Format Variables & Execute Find & Replace (Matching actual layout map)
    const currentFormattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const replacements = [
      { search: '{{date}}', replace: currentFormattedDate },
      { search: '{{crew_member}}', replace: contractData.crewMember || 'Independent Contractor' },
      { search: '{{position}}', replace: contractData.position || 'Production Specialist' },
      { search: '{{final_agreed_rate}}', replace: contractData.finalAgreedRate || '0.00' }
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

    // 6. Compile Modified Document into an In-Memory PDF ArrayBuffer
    const pdfResponse = await drive.files.export({
      fileId: newDocId,
      mimeType: 'application/pdf',
      supportsAllDrives: true // <-- CRITICAL: Grants export asset pipeline visibility
    }, { responseType: 'arraybuffer' });
    
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // 7. Stream PDF Buffer via Native Multipart Form-Data to monday.com File Storage
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

    // 8. Update Monday Row Status Tracker to "Sent to Tech"
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

    // 9. Wipe out Temporary Scratchpad Document from Google Drive folder
    await drive.files.delete({ 
      fileId: newDocId,
      supportsAllDrives: true // <-- CRITICAL: Allows standard automated scratchpad cleanup in Shared Drives
    });
    console.log(`🏁 Pipeline execution cleanly terminated for record: ${itemId}`);

    return res.status(200).json({ success: true, message: 'Contract package saved successfully.' });

  } catch (error) {
    console.error('❌ Automation engine faulted:', error);
    
    // Safety Fallback: Reset status back to draft if the pipeline crashes
    try {
      await mondayApiCall(`mutation { change_column_value(item_id: ${itemId}, board_id: 18415879229, column_id: "color_mm3y7397", value: "{\\"label\\":\\"Draft\\"}") { id } }`);
    } catch (e) { console.error('Fallback update pipeline failure context:', e); }

    return res.status(500).json({ success: false, error: error.message });
  }
}

async function fetchContractData(itemId) {
  const query = `query { items(ids: [${itemId}]) { column_values { id text } } }`;
  const response = await mondayApiCall(query);
  const columns = response.data?.items?.[0]?.column_values || [];
  
  return {
    crewMember: columns.find(c => c.id === 'board_relation_mm3yckmg')?.text,
    position: columns.find(c => c.id === 'text_mm3y8w5b' || c.id === 'text')?.text || 'Technician', 
    finalAgreedRate: columns.find(c => c.id === 'formula_mm3yd43r' || c.id === 'numeric_mm3yae4w')?.text
  };
}

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
