/**
 * Flex Quote → monday.com Project Creator
 * 
 * This endpoint receives Flex quote data and automatically creates
 * a project in monday.com with all fields populated.
 * 
 * Handles:
 * - Client/venue lookup and creation
 * - Duplicate prevention
 * - PM assignment based on budget
 * - Notifications
 * - CORS for Vibe app access
 * 
 * Author: Matt James, Antic Studios
 * Date: June 6, 2026
 * Updated: Added CORS headers and support for both elementId and itemId parameters
 */

// Environment variables (set in Vercel)
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY || 'QjT1EKjjVkZoQmmUsIpRK3ggq94bqW34qNCt';
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Board IDs
const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';

// PM User IDs (configure these based on your team)
const PM_ASSIGNMENTS = {
  junior: null, // Set to user ID for junior PM
  mid: null,    // Set to user ID for mid-level PM
  senior: null, // Set to user ID for senior PM
  default: '102097223' // Matt James as default
};

/**
 * Main handler function
 */
export default async function handler(req, res) {
  // Add CORS headers to allow requests from Vibe app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('📥 Received Flex quote request');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    // Accept both elementId and itemId parameter names
    const quoteId = req.body.elementId || req.body.itemId;
    const eventType = req.body.eventType;
    
    if (!quoteId) {
      console.log('❌ Missing quote ID in request');
      return res.status(400).json({ 
        error: 'Missing quote ID',
        message: 'Please provide either elementId or itemId parameter with the Flex quote number'
      });
    }

    console.log(`🔍 Processing Flex quote: ${quoteId}`);

    // Step 1: Fetch full quote details from Flex
    const quoteData = await fetchFlexQuoteData(quoteId);
    console.log(`✅ Fetched quote data: ${quoteData.name}`);

    // Step 2: Check for duplicate project
    const existingProject = await checkForDuplicateProject(quoteData.elementNumber);
    
    if (existingProject) {
      console.log(`⚠️ Duplicate found: ${existingProject.id}`);
      // Update existing project instead of creating new
      await updateExistingProject(existingProject.id, quoteData);
      return res.status(200).json({
        success: true,
        action: 'updated',
        projectId: existingProject.id,
        message: `Updated existing project ${quoteData.elementNumber}`
      });
    }

    // Step 3: Find or create client
    const clientId = await findOrCreateContact(quoteData.customer.name, 'Client');
    console.log(`✅ Client ID: ${clientId}`);

    // Step 4: Find or create venue
    const venueId = await findOrCreateContact(quoteData.venue.name, 'Venue');
    console.log(`✅ Venue ID: ${venueId}`);

    // Step 5: Create project in monday.com
    const project = await createMondayProject(quoteData, clientId, venueId);
    console.log(`✅ Created project: ${project.id}`);

    // Step 6: Assign PM based on budget
    const assignedPM = await assignPM(project.id, quoteData.totalEstimate);
    console.log(`✅ Assigned PM: ${assignedPM || 'Manual assignment'}`);

    // Step 7: Send notification
    await sendNotification(project.id, quoteData, assignedPM);
    console.log(`✅ Notification sent`);

    // Success response
    return res.status(200).json({
      success: true,
      action: 'created',
      projectId: project.id,
      projectUrl: project.url,
      flexProjectNumber: quoteData.elementNumber,
      message: `Successfully created project from Flex quote ${quoteData.elementNumber}`
    });

  } catch (error) {
    console.error('❌ Error creating project:', error);
    
    // Log error to monday.com (optional - create error log board)
    await logError(error, req.body);

    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack
    });
  }
}

/**
 * Fetch quote data from Flex API
 */
async function fetchFlexQuoteData(quoteId) {
  const url = `${FLEX_BASE_URL}/api/element/${quoteId}/header-data`;
  
  console.log(`Fetching from Flex: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Auth-Token': FLEX_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Flex API error: ${response.status} - ${errorText}`);
    throw new Error(`Flex API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  return {
    elementNumber: data.elementNumber || quoteId,
    name: data.name || 'Untitled Project',
    customer: {
      name: data.customer?.name || 'Unknown Client'
    },
    venue: {
      name: data.venue?.name || 'Unknown Venue'
    },
    eventDate: data.eventDate || null,
    loadInDate: data.loadInDate || null,
    strikeDate: data.strikeDate || null,
    totalEstimate: data.totalEstimate || 0,
    notes: data.notes || '',
    equipmentList: {
      count: data.equipmentList?.count || 0
    },
    status: data.status || 'Quote',
    salesRep: {
      name: data.salesRep?.name || 'Unknown'
    }
  };
}

/**
 * Check if project already exists with this Flex number
 */
async function checkForDuplicateProject(flexProjectNumber) {
  const query = `
    query {
      boards(ids: [${PROJECTS_BOARD_ID}]) {
        items_page(limit: 1, query_params: {
          rules: [{
            column_id: "text_mm3x2yr6",
            compare_value: ["${flexProjectNumber}"]
          }]
        }) {
          items {
            id
            name
          }
        }
      }
    }
  `;

  const response = await mondayApiCall(query);
  const items = response.data.boards[0]?.items_page?.items || [];
  
  return items.length > 0 ? items[0] : null;
}

/**
 * Find or create contact (client or venue) in Contacts & Companies board
 */
async function findOrCreateContact(name, type) {
  // First, search for existing contact
  const searchQuery = `
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: 1, query_params: {
          rules: [{
            column_id: "name",
            compare_value: ["${name.replace(/"/g, '\\"')}"],
            operator: contains_text
          }]
        }) {
          items {
            id
            name
          }
        }
      }
    }
  `;

  const searchResponse = await mondayApiCall(searchQuery);
  const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];

  if (existingItems.length > 0) {
    console.log(`Found existing ${type}: ${name}`);
    return existingItems[0].id;
  }

  // Not found, create new contact
  console.log(`Creating new ${type}: ${name}`);
  
  const createMutation = `
    mutation {
      create_item(
        board_id: ${CONTACTS_BOARD_ID},
        group_id: "topics",
        item_name: "${name.replace(/"/g, '\\"')}",
        column_values: "{\\"dropdown_mm3vqxqh\\":\\"${type}\\",\\"color_mm3vqxqh\\":{\\"label\\":\\"Active\\"}}"
      ) {
        id
      }
    }
  `;

  const createResponse = await mondayApiCall(createMutation);
  return createResponse.data.create_item.id;
}

/**
 * Create project in monday.com Projects board
 */
async function createMondayProject(quoteData, clientId, venueId) {
  const columnValues = {
    text_mm3x2yr6: quoteData.elementNumber, // Flex Project #
    board_relation_mm3x8evw: { item_ids: [parseInt(clientId)] }, // Client
    board_relation_mm3xrm02: { item_ids: [parseInt(venueId)] }, // Venue
    date_mm3xca9r: quoteData.eventDate ? { date: quoteData.eventDate } : null, // Event Date
    numeric_mm3xzncg: quoteData.totalEstimate, // Estimated Budget
    numeric_mm3zsgna: quoteData.equipmentList.count, // Equipment Count
    long_text_mm3xfve1: quoteData.notes, // Notes
    color_mm3x4534: { label: "Design" }, // Project Phase
    color_mm3xhnjc: { label: "Medium" }, // Priority
    date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] }, // Last Equipment Sync
    color_mm3y3bxj: { label: "Synced" } // Pullsheet Sync Status
  };

  // Remove null values
  Object.keys(columnValues).forEach(key => {
    if (columnValues[key] === null) delete columnValues[key];
  });

  const mutation = `
    mutation {
      create_item(
        board_id: ${PROJECTS_BOARD_ID},
        group_id: "group_mm3x407x",
        item_name: "${quoteData.name.replace(/"/g, '\\"')}",
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
        name
        url
      }
    }
  `;

  const response = await mondayApiCall(mutation);
  return response.data.create_item;
}

/**
 * Update existing project with latest Flex data
 */
async function updateExistingProject(projectId, quoteData) {
  const columnValues = {
    numeric_mm3xzncg: quoteData.totalEstimate,
    numeric_mm3zsgna: quoteData.equipmentList.count,
    long_text_mm3xfve1: quoteData.notes,
    date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] }
  };

  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${PROJECTS_BOARD_ID},
        item_id: ${projectId},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
      }
    }
  `;

  await mondayApiCall(mutation);
}

/**
 * Assign PM based on budget
 */
async function assignPM(projectId, budget) {
  let pmUserId;

  // Budget-based assignment rules
  if (budget < 50000) {
    pmUserId = PM_ASSIGNMENTS.junior || PM_ASSIGNMENTS.default;
  } else if (budget < 150000) {
    pmUserId = PM_ASSIGNMENTS.mid || PM_ASSIGNMENTS.default;
  } else {
    pmUserId = PM_ASSIGNMENTS.senior || PM_ASSIGNMENTS.default;
  }

  // If no PM assigned, return null (manual assignment)
  if (!pmUserId) {
    return null;
  }

  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${PROJECTS_BOARD_ID},
        item_id: ${projectId},
        column_values: "{\\"multiple_person_mm3xmbb2\\":{\\"personsAndTeams\\":[{\\"id\\":${pmUserId},\\"kind\\":\\"person\\"}]}}"
      ) {
        id
      }
    }
  `;

  await mondayApiCall(mutation);
  return pmUserId;
}

/**
 * Send notification to PM
 */
async function sendNotification(projectId, quoteData, pmUserId) {
  const userId = pmUserId || PM_ASSIGNMENTS.default;
  
  const mutation = `
    mutation {
      create_notification(
        user_id: ${userId},
        target_id: ${projectId},
        target_type: Project,
        text: "New project created from Flex: ${quoteData.name.replace(/"/g, '\\"')} (${quoteData.elementNumber})",
        payload: ${JSON.stringify(JSON.stringify({
          client: quoteData.customer.name,
          venue: quoteData.venue.name,
          eventDate: quoteData.eventDate,
          budget: `${quoteData.totalEstimate.toLocaleString()}`
        }))}
      ) {
        text
      }
    }
  `;

  await mondayApiCall(mutation);
}

/**
 * Log error to console (could extend to log to monday.com board)
 */
async function logError(error, payload) {
  console.error('Error details:', {
    message: error.message,
    stack: error.stack,
    payload: payload,
    timestamp: new Date().toISOString()
  });
}

/**
 * Helper function to make monday.com API calls
 */
async function mondayApiCall(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  if (!response.ok) {
    throw new Error(`monday.com API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.errors) {
    throw new Error(`monday.com GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data;
}
