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
      supportsAllDrives: true,
      requestBody: {
        name: `Contract - ${contractData.crewMember} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`,
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
      // Basic Info
      { search: '{{date}}', replace: currentFormattedDate },
      { search: '{{contract_id}}', replace: contractData.contractId },
      { search: '{{crew_member}}', replace: contractData.crewMember },
      { search: '{{position}}', replace: contractData.position },
      { search: '{{crew_email}}', replace: contractData.crewEmail },
      { search: '{{crew_phone}}', replace: contractData.crewPhone },
      
      // Project Info
      { search: '{{project_name}}', replace: contractData.projectName },
      { search: '{{client_name}}', replace: contractData.clientName },
      { search: '{{venue_name}}', replace: contractData.venueName },
      
      // Dates
      { search: '{{start_date}}', replace: contractData.startDate },
      { search: '{{end_date}}', replace: contractData.endDate },
      
      // Financial
      { search: '{{contract_type}}', replace: contractData.contractType },
      { search: '{{contract_amount}}', replace: contractData.contractAmount },
      { search: '{{agent_commission}}', replace: contractData.agentCommission },
      { search: '{{agent_commission_amount}}', replace: contractData.agentCommissionAmount },
      { search: '{{final_agreed_rate}}', replace: contractData.finalAgreedRate },
      { search: '{{payment_schedule}}', replace: contractData.paymentSchedule },
      
      // Details
      { search: '{{scope_of_work}}', replace: contractData.scopeOfWork },
      { search: '{{contract_notes}}', replace: contractData.contractNotes },
      { search: '{{per_diem}}', replace: contractData.perDiem },
      
      // Equipment & Insurance
      { search: '{{company_equipment}}', replace: contractData.companyEquipment },
      { search: '{{contractor_equipment}}', replace: contractData.contractorEquipment },
      { search: '{{insurance_requirement}}', replace: contractData.insuranceRequirement },
      
      // Company Info
      { search: '{{company_signatory}}', replace: contractData.companySignatory },
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

    // 6. Compile Modified Document into an In-Memory PDF ArrayBuffer
    const pdfResponse = await drive.files.export({
      fileId: newDocId,
      mimeType: 'application/pdf',
      supportsAllDrives: true
    }, { responseType: 'arraybuffer' });
   
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // 6.5. Clear any existing files in the Contract Document column (PREVENTS CELL LIMIT ERROR)
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

    // 9. Wipe out Temporary Scratchpad Document from Google Drive folder
    try {
      await drive.files.delete({ 
        fileId: newDocId,
        supportsAllDrives: true
      });
      console.log(`🗑️ Temporary document deleted: ${newDocId}`);
    } catch (cleanupError) {
      console.warn(`⚠️ Could not delete temporary document ${newDocId}: ${cleanupError.message}`);
      console.warn('This is non-fatal - contract generation succeeded.');
    }

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
  const query = `query { 
    items(ids: [${itemId}]) { 
      id
      name
      column_values { 
        id 
        text 
        value
      } 
    }
  }`;
  
  const response = await mondayApiCall(query);
  const item = response.data?.items?.[0];
  const columns = item?.column_values || [];
  
  // Helper to get column value
  const getCol = (id) => columns.find(c => c.id === id)?.text || '';
  const getColValue = (id) => {
    const col = columns.find(c => c.id === id);
    if (!col?.value) return '';
    try {
      return JSON.parse(col.value);
    } catch {
      return col.text || '';
    }
  };
  
  // Parse dates
  const startDate = getColValue('date_mm3y5whf');
  const endDate = getColValue('date_mm3yndhd');
  const formatDate = (dateObj) => {
    if (!dateObj?.date) return 'TBD';
    const d = new Date(dateObj.date);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };
  
  // Calculate commission
  const contractAmount = parseFloat(getCol('numeric_mm3yae4w')) || 0;
  const commissionPercent = parseFloat(getCol('numeric_mm3yywfk')) || 0;
  const commissionAmount = (contractAmount * commissionPercent / 100).toFixed(2);
  const netPayment = (contractAmount - commissionAmount).toFixed(2);
  
  return {
    // Basic Info
    contractId: item.id,
    crewMember: getCol('board_relation_mm3yckmg') || 'Independent Contractor',
    position: getCol('text_mm3y8w5b') || 'Production Technician',
    crewEmail: getCol('lookup_mm3ycr08') || 'TBD',
    crewPhone: getCol('lookup_mm3ygy4r') || 'TBD',
    
    // Project Info
    projectName: getCol('board_relation_mm3yxkvs') || item.name,
    clientName: getCol('lookup_mm3ygy4r') || 'TBD',
    venueName: getCol('board_relation_mm3y7kar') || 'TBD',
    
    // Dates
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    
    // Financial
    contractType: getCol('dropdown_mm3yt6p2') || 'Day Rate',
    contractAmount: contractAmount.toFixed(2),
    agentCommission: commissionPercent.toFixed(1),
    agentCommissionAmount: commissionAmount,
    finalAgreedRate: netPayment,
    paymentSchedule: getCol('long_text_mm3yypxx') || 'Net 30 upon completion',
    
    // Details
    scopeOfWork: getCol('long_text_mm3ypebd') || 'Production services as assigned',
    contractNotes: getCol('long_text_mm3y3094') || 'None',
    perDiem: '$50/day (if applicable)',
    
    // Equipment & Insurance
    companyEquipment: 'All production equipment as specified in production rider',
    contractorEquipment: 'Personal tools and safety equipment',
    insuranceRequirement: 'General liability insurance recommended but not required for day rates under $5,000',
    
    // Company Info
    companySignatory: 'Matt James',
    companySignatoryTitle: 'General Manager'
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
