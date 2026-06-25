import { google } from 'googleapis';

// Vercel body parser configuration
export const config = {
  api: {
    bodyParser: true,
  },
};

// Monday.com API configuration
const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_FILE_URL = 'https://api.monday.com/v2/file';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

// Google API configuration
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SCOPES = ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive'];

// Board IDs
const ROUTE_STOPS_BOARD_ID = '18415570592';
const PROJECTS_BOARD_ID = '18415679761';
const CREW_DATABASE_BOARD_ID = '18415879010';
const CONTACTS_COMPANIES_BOARD_ID = '18415573401';

// Column IDs
const BOL_STATUS_COLUMN = 'color_mm4dx241';

// Google Docs BOL Template ID
const BOL_TEMPLATE_ID = '1queGcWsRgc8b8cBBlwdNnEDE-MVpSFIZ0iMPD33JLJE';

// Google Drive folder for generated BOLs (Shared Drive)
const BOL_FOLDER_ID = '1tHeg8lfNY2mv-1rhLHLen5AFGugmzYaN';

/**
 * Main handler for BOL generation webhook
 */
export default async function handler(req, res) {
  console.log('BOL Generation webhook triggered');
  console.log('Method:', req.method);
  console.log('Query params:', req.query);
  console.log('Body:', req.body);
  
  // Handle Monday webhook challenge validation
  if (req.method === 'POST' && req.body && req.body.challenge) {
    console.log('Responding to Monday challenge:', req.body.challenge);
    return res.status(200).json({ challenge: req.body.challenge });
  }
  
  // Handle GET requests for basic validation
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }
  
  // Parse body if it's not already parsed
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
  }
  
  try {
    // Extract data from Monday's webhook format
    const event = body.event;
    
    if (!event) {
      return res.status(400).json({ error: 'Missing event data in webhook payload' });
    }
    
    const itemId = event.pulseId;
    const boardId = event.boardId;
    const columnId = event.columnId;
    const statusLabel = event.value?.label?.text || event.value?.label;
    
    console.log(`Item ID: ${itemId}, Status: ${statusLabel}`);
    
    // Only process if status changed to "Generate"
    if (statusLabel !== 'Generate') {
      console.log(`Status is "${statusLabel}", not "Generate". Skipping.`);
      return res.status(200).json({ 
        message: 'Status not "Generate", skipping',
        status: statusLabel
      });
    }

    if (!itemId) {
      return res.status(400).json({ error: 'Missing itemId in webhook payload' });
    }

    console.log(`Processing BOL for Route Stop item: ${itemId}`);

    // Step 1: Fetch full route stop data from Monday
    const routeStopData = await fetchRouteStopData(itemId);
    console.log('Route stop data fetched:', routeStopData);

    // Step 2: Fetch related data (driver, carrier, location, project/Flex #)
    const enrichedData = await enrichRouteStopData(routeStopData);
    console.log('Enriched data:', enrichedData);

    // Step 3: Generate BOL from Google Docs template
    const pdfData = await generateBOLFromTemplate(enrichedData);
    console.log('BOL PDF generated:', pdfData);

    // Step 4: Update status to "Complete" FIRST to prevent looping
    await updateBOLStatus(itemId, 'Complete');

    // Step 5: Upload PDF to Monday.com file column
    try {
      await uploadBOLToMonday(itemId, pdfData, enrichedData.routeStopName);
    } catch (uploadError) {
      console.error('Failed to upload PDF to Monday:', uploadError.message);
      // Don't throw - we already generated the doc successfully and marked complete
    }

    return res.status(200).json({ 
      success: true, 
      message: 'BOL generated successfully',
      itemId,
      docId: pdfData.docId
    });

  } catch (error) {
    console.error('Error generating BOL:', error);
    return res.status(500).json({ 
      error: 'Failed to generate BOL', 
      details: error.message 
    });
  }
}

/**
 * Fetch route stop data from Monday.com
 */
async function fetchRouteStopData(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        id
        name
        column_values {
          id
          value
          text
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }

  const item = data.data.items[0];
  
  // Parse column values into a usable object
  const columnData = {};
  item.column_values.forEach(col => {
    columnData[col.id] = {
      value: col.value ? JSON.parse(col.value) : null,
      text: col.text
    };
  });

  return {
    itemId: item.id,
    routeStopName: item.name,
    columns: columnData
  };
}

/**
 * Enrich route stop data with related information from other boards
 */
async function enrichRouteStopData(routeStopData) {
  const enriched = {
    routeStopName: routeStopData.routeStopName,
    itemId: routeStopData.itemId,
    date: routeStopData.columns.date_mm3v2kz1?.text || '',
    time: routeStopData.columns.hour_mm3ws9gq?.text || '',
    weight: routeStopData.columns.numeric_mm3v2r3c?.text || '',
    truckSpace: routeStopData.columns.dropdown_mm3wk0ey?.text || '',
    driver: null,
    carrier: null,
    location: null,
    flexNumber: null,
    projectName: null
  };

  // Fetch Driver info (from Crew Database)
  const driverRelation = routeStopData.columns.board_relation_mm3va52r?.value;
  if (driverRelation && driverRelation.linkedPulseIds && driverRelation.linkedPulseIds.length > 0) {
    enriched.driver = await fetchCrewMemberData(driverRelation.linkedPulseIds[0].linkedPulseId);
  }

  // Fetch Carrier info (from Contacts & Companies)
  const carrierRelation = routeStopData.columns.board_relation_mm49kxqr?.value;
  if (carrierRelation && carrierRelation.linkedPulseIds && carrierRelation.linkedPulseIds.length > 0) {
    enriched.carrier = await fetchContactData(carrierRelation.linkedPulseIds[0].linkedPulseId);
  }

  // Fetch Location info (from Contacts & Companies)
  const locationRelation = routeStopData.columns.board_relation_mm3vn6yb?.value;
  if (locationRelation && locationRelation.linkedPulseIds && locationRelation.linkedPulseIds.length > 0) {
    enriched.location = await fetchContactData(locationRelation.linkedPulseIds[0].linkedPulseId);
  }

  // Fetch Project and Flex # (from Projects board)
  const projectRelation = routeStopData.columns.board_relation_mm46qc4d?.value;
  if (projectRelation && projectRelation.linkedPulseIds && projectRelation.linkedPulseIds.length > 0) {
    const projectData = await fetchProjectData(projectRelation.linkedPulseIds[0].linkedPulseId);
    enriched.flexNumber = projectData.flexNumber;
    enriched.projectName = projectData.projectName;
  }

  return enriched;
}

/**
 * Fetch crew member data from Crew Database
 */
async function fetchCrewMemberData(crewId) {
  const query = `
    query {
      items(ids: [${crewId}]) {
        id
        name
        column_values {
          id
          value
          text
          type
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  const item = data.data.items[0];

  // Extract relevant crew data - look for phone, email, license columns
  const phoneCol = item.column_values.find(c => c.type === 'phone');
  const emailCol = item.column_values.find(c => c.type === 'email');
  const licenseCol = item.column_values.find(c => c.id.includes('license') || c.text?.toLowerCase().includes('license'));

  return {
    name: item.name,
    phone: phoneCol?.text || '',
    email: emailCol?.text || '',
    license: licenseCol?.text || ''
  };
}

/**
 * Fetch contact/company data from Contacts & Companies board
 */
async function fetchContactData(contactId) {
  const query = `
    query {
      items(ids: [${contactId}]) {
        id
        name
        column_values {
          id
          value
          text
          type
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  const item = data.data.items[0];

  // Extract address - column ID: long_text_mm3vkzc6
  const addressCol = item.column_values.find(c => c.id === 'long_text_mm3vkzc6');
  const phoneCol = item.column_values.find(c => c.type === 'phone');

  return {
    name: item.name,
    address: addressCol?.text || '',
    phone: phoneCol?.text || ''
  };
}

/**
 * Fetch project data and Flex # from Projects board
 */
async function fetchProjectData(projectId) {
  const query = `
    query {
      items(ids: [${projectId}]) {
        id
        name
        column_values {
          id
          value
          text
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  const item = data.data.items[0];

  // Extract Flex Project # - column ID: text_mm3x2yr6
  const flexCol = item.column_values.find(c => c.id === 'text_mm3x2yr6');

  return {
    projectName: item.name,
    flexNumber: flexCol?.text || 'N/A'
  };
}

/**
 * Generate BOL from Google Docs template
 */
async function generateBOLFromTemplate(data) {
  // Authenticate with Google
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDENTIALS,
    scopes: SCOPES
  });

  const authClient = await auth.getClient();
  const docs = google.docs({ version: 'v1', auth: authClient });
  const drive = google.drive({ version: 'v3', auth: authClient });

  // Copy the template into your Shared Drive folder
  const copyResponse = await drive.files.copy({
    fileId: BOL_TEMPLATE_ID,
    requestBody: {
      name: `BOL - ${data.routeStopName} - ${data.date}`,
      parents: [BOL_FOLDER_ID]
    },
    supportsAllDrives: true
  });

  const newDocId = copyResponse.data.id;
  console.log('Created BOL document copy:', newDocId);

  // Prepare replacement data
  const replacements = {
    '{{ROUTE_STOP_NAME}}': data.routeStopName || '',
    '{{DATE}}': data.date || '',
    '{{TIME}}': data.time || '',
    '{{FLEX_NUMBER}}': data.flexNumber || 'N/A',
    '{{PROJECT_NAME}}': data.projectName || '',
    '{{DRIVER_NAME}}': data.driver?.name || 'N/A',
    '{{DRIVER_PHONE}}': data.driver?.phone || '',
    '{{DRIVER_EMAIL}}': data.driver?.email || '',
    '{{DRIVER_LICENSE}}': data.driver?.license || '',
    '{{CARRIER_NAME}}': data.carrier?.name || 'N/A',
    '{{CARRIER_PHONE}}': data.carrier?.phone || '',
    '{{LOCATION_NAME}}': data.location?.name || '',
    '{{LOCATION_ADDRESS}}': data.location?.address || '',
    '{{WEIGHT}}': data.weight || '',
    '{{TRUCK_SPACE}}': data.truckSpace || ''
  };

  // Build batch update requests for all replacements
  const requests = [];
  for (const [placeholder, value] of Object.entries(replacements)) {
    requests.push({
      replaceAllText: {
        containsText: {
          text: placeholder,
          matchCase: true
        },
        replaceText: value
      }
    });
  }

  // Execute all replacements
  await docs.documents.batchUpdate({
    documentId: newDocId,
    requestBody: {
      requests: requests
    }
  });

  console.log('BOL document populated with data');

  // Export as PDF
  const pdfResponse = await drive.files.export({
    fileId: newDocId,
    mimeType: 'application/pdf'
  }, {
    responseType: 'arraybuffer'
  });

  // Convert to base64
  const pdfBuffer = Buffer.from(pdfResponse.data);
  const pdfBase64 = pdfBuffer.toString('base64');

  // Make the file publicly accessible temporarily for Monday upload
  await drive.permissions.create({
    fileId: newDocId,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    },
    supportsAllDrives: true
  });

  const fileUrl = `https://drive.google.com/uc?export=download&id=${newDocId}`;

  // Keep the doc for records - don't delete
  console.log('✅ BOL document saved to Shared Drive folder for records');

  return {
    url: fileUrl,
    base64: pdfBase64,
    buffer: pdfBuffer,
    docId: newDocId
  };
}

/**
 * Upload BOL PDF to Monday.com file column using multipart form data
 */
async function uploadBOLToMonday(itemId, pdfData, routeStopName) {
  const fileName = `BOL_${routeStopName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
  
  // Create form data with the PDF (native Node 18+ FormData + Blob)
  const form = new FormData();
  form.append('query', `mutation ($file: File!) {
    add_file_to_column(
      item_id: ${itemId},
      column_id: "file_mm4dpv3q",
      file: $file
    ) {
      id
    }
  }`);
  const blob = new Blob([pdfData.buffer], { type: 'application/pdf' });
  form.append('variables[file]', blob, fileName);

  const response = await fetch(MONDAY_API_FILE_URL, {
    method: 'POST',
    headers: {
      'Authorization': MONDAY_API_KEY
      // Content-Type is set automatically by fetch when body is FormData
    },
    body: form
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Failed to upload BOL to Monday: ${JSON.stringify(data.errors)}`);
  }

  console.log('✅ BOL PDF uploaded to Monday.com');
  return data;
}

/**
 * Update BOL Generation Status column
 */
async function updateBOLStatus(itemId, status) {
  // Use the label index directly as a number (not string)
  const statusIndex = status === 'Complete' ? 2 : 0;
  
  const mutation = `
    mutation {
      change_column_value(
        item_id: ${itemId},
        board_id: ${ROUTE_STOPS_BOARD_ID},
        column_id: "${BOL_STATUS_COLUMN}",
        value: "{\\"index\\": ${statusIndex}}"
      ) {
        id
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  
  if (data.errors) {
    console.error('Failed to update BOL status:', data.errors);
  } else {
    console.log(`✅ BOL status updated to: ${status}`);
  }

  return data;
}
