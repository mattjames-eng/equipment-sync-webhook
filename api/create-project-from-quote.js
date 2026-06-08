// ============================================================================
// QUOTEFLOW: FLEX → MONDAY.COM PROJECT CREATION WEBHOOK (WITH AUTO-LINKING)
// ============================================================================
// Vercel Serverless Function
// Endpoint: /api/create-project-from-quote
// Trigger: Flex webhook on Quote Approved
// 
// UPDATED: Now includes automatic client/venue linking from Contacts & Companies board
// ============================================================================

const MONDAY_API_URL = 'https://api.monday.com/v2';
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://flex.anticstudios.com/f5';
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES;
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';
const PM_DEFAULT_ID = process.env.PM_DEFAULT_ID || '102097223';

// ============================================================================
// HELPER: SEARCH CONTACTS & COMPANIES BOARD
// ============================================================================
async function findContactByName(searchText, type = 'client') {
  console.log(`🔍 Searching for ${type}: "${searchText}"`);
  
  if (!searchText || searchText.trim() === '') {
    console.log(`⚠️ Empty search text for ${type}, skipping lookup`);
    return null;
  }

  const query = `
    query ($boardId: ID!, $limit: Int!) {
      boards(ids: [$boardId]) {
        items_page(limit: $limit) {
          items {
            id
            name
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-10'
      },
      body: JSON.stringify({
        query,
        variables: {
          boardId: CONTACTS_BOARD_ID,
          limit: 500
        }
      })
    });

    const result = await response.json();
    
    if (result.errors) {
      console.error(`❌ GraphQL errors searching contacts:`, result.errors);
      return null;
    }

    const items = result.data?.boards?.[0]?.items_page?.items || [];
    console.log(`📊 Found ${items.length} total contacts in registry`);

    // Normalize search text for comparison
    const normalizedSearch = searchText.toLowerCase().trim();
    
    // Try exact match first
    let match = items.find(item => 
      item.name.toLowerCase().trim() === normalizedSearch
    );

    // If no exact match, try fuzzy match (contains)
    if (!match) {
      match = items.find(item => 
        item.name.toLowerCase().includes(normalizedSearch) ||
        normalizedSearch.includes(item.name.toLowerCase())
      );
    }

    if (match) {
      console.log(`✅ Found ${type} match: "${match.name}" (ID: ${match.id})`);
      return match.id;
    } else {
      console.log(`⚠️ No match found for ${type}: "${searchText}"`);
      return null;
    }

  } catch (error) {
    console.error(`❌ Error searching for ${type}:`, error);
    return null;
  }
}

// ============================================================================
// HELPER: UPDATE BOARD RELATION COLUMNS
// ============================================================================
async function updateProjectConnections(projectId, clientId, venueId) {
  console.log(`🔗 Updating connections for project ${projectId}`);
  console.log(`   Client ID: ${clientId || 'none'}`);
  console.log(`   Venue ID: ${venueId || 'none'}`);

  const mutations = [];

  // Build client connection mutation
  if (clientId) {
    mutations.push({
      columnId: 'board_relation_mm3x8evw',
      value: JSON.stringify({ item_ids: [parseInt(clientId, 10)] })
    });
  }

  // Build venue connection mutation
  if (venueId) {
    mutations.push({
      columnId: 'board_relation_mm3xrm02',
      value: JSON.stringify({ item_ids: [parseInt(venueId, 10)] })
    });
  }

  if (mutations.length === 0) {
    console.log(`⚠️ No connections to update`);
    return;
  }

  // Execute all mutations in parallel
  const updatePromises = mutations.map(async ({ columnId, value }) => {
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `;

    try {
      const response = await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': MONDAY_API_KEY,
          'API-Version': '2024-10'
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            boardId: PROJECTS_BOARD_ID,
            itemId: projectId,
            columnId,
            value
          }
        })
      });

      const result = await response.json();
      
      if (result.errors) {
        console.error(`❌ Error updating column ${columnId}:`, result.errors);
      } else {
        console.log(`✅ Successfully updated column ${columnId}`);
      }
    } catch (error) {
      console.error(`❌ Exception updating column ${columnId}:`, error);
    }
  });

  await Promise.all(updatePromises);
}

// ============================================================================
// HELPER: FETCH FLEX QUOTE DATA
// ============================================================================
async function fetchFlexQuoteData(quoteNumber) {
  console.log(`🔍 Fetching Flex data for quote: ${quoteNumber}`);

  // Step 1: Search for the quote to get its UUID
  const searchUrl = `${FLEX_BASE_URL}/api/search`;
  const searchResponse = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': FLEX_API_KEY
    },
    body: JSON.stringify({
      searchText: quoteNumber,
      searchType: 'QUOTE'
    })
  });

  if (!searchResponse.ok) {
    throw new Error(`Flex search failed: ${searchResponse.status} ${searchResponse.statusText}`);
  }

  const searchData = await searchResponse.json();
  
  if (!searchData.results || searchData.results.length === 0) {
    throw new Error(`Quote ${quoteNumber} not found in Flex`);
  }

  const quoteUuid = searchData.results[0].uuid;
  console.log(`✅ Found quote UUID: ${quoteUuid}`);

  // Step 2: Fetch full quote data
  const dataUrl = `${FLEX_BASE_URL}/api/element/${quoteUuid}/header-data?codeList=QUOTE`;
  const dataResponse = await fetch(dataUrl, {
    method: 'GET',
    headers: {
      'X-Auth-Token': FLEX_API_KEY
    }
  });

  if (!dataResponse.ok) {
    throw new Error(`Flex data fetch failed: ${dataResponse.status} ${dataResponse.statusText}`);
  }

  const quoteData = await dataResponse.json();
  return quoteData;
}

// ============================================================================
// HELPER: EXTRACT NESTED NAME VALUES
// ============================================================================
function deepExtractName(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  if (obj.name) return obj.name;
  if (obj.value && typeof obj.value === 'object') return deepExtractName(obj.value);
  return null;
}

// ============================================================================
// HELPER: CREATE MONDAY.COM PROJECT
// ============================================================================
async function createMondayProject(quoteData, quoteNumber) {
  const projectName = deepExtractName(quoteData.name) || `Project ${quoteNumber}`;
  const clientText = deepExtractName(quoteData.clientId) || '';
  const venueText = deepExtractName(quoteData.venueId) || '';
  const eventDate = quoteData.eventDate?.value || null;
  const estimatedBudget = quoteData.estimatedTotal?.value || 0;

  console.log(`🎯 PROJECT NAME EXTRACTED: [${projectName}]`);
  console.log(`👥 CLIENT TEXT: [${clientText}] | 📍 VENUE TEXT: [${venueText}]`);

  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  const columnValues = {
    text_mm3x2yr6: quoteNumber,
    text_mm435rt8: clientText,
    text_mm43r22q: venueText,
    multiple_person_mm3xmbb2: { personsAndTeams: [{ id: parseInt(PM_DEFAULT_ID, 10), kind: 'person' }] },
    color_mm43yjp9: { label: 'New' },
    color_mm43kvp3: { label: 'Success' }
  };

  if (eventDate) {
    columnValues.date_mm3xca9r = { date: eventDate };
  }

  if (estimatedBudget > 0) {
    columnValues.numeric_mm3xzncg = estimatedBudget;
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        boardId: PROJECTS_BOARD_ID,
        itemName: projectName,
        columnValues: JSON.stringify(columnValues)
      }
    })
  });

  const result = await response.json();

  if (result.errors) {
    console.error('❌ GraphQL errors:', result.errors);
    throw new Error('Failed to create project in monday.com');
  }

  const projectId = result.data.create_item.id;
  console.log(`✅ Project successfully initialized! ID: ${projectId}`);

  return {
    projectId,
    clientText,
    venueText
  };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type')
      .end();
  }

  // Add CORS headers to all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('📥 Received request payload');

  try {
    const { quoteNumber } = req.body;

    if (!quoteNumber) {
      return res.status(400).json({ error: 'Missing quoteNumber in request body' });
    }

    // Step 1: Fetch quote data from Flex
    const quoteData = await fetchFlexQuoteData(quoteNumber);

    // Step 2: Create project in monday.com with text fields
    const { projectId, clientText, venueText } = await createMondayProject(quoteData, quoteNumber);

    // Step 3: Search for matching contacts
    const clientId = await findContactByName(clientText, 'client');
    const venueId = await findContactByName(venueText, 'venue');

    // Step 4: Update connection columns
    await updateProjectConnections(projectId, clientId, venueId);

    console.log('🎉 COMPLETE: Project created and linked successfully');

    return res.status(200).json({
      success: true,
      projectId,
      clientLinked: !!clientId,
      venueLinked: !!venueId,
      message: 'Project created and contacts linked successfully'
    });

  } catch (error) {
    console.error('❌ Error processing request:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
