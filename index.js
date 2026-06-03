// Flex Sync Webhook - Full Project Sync with AUTO UUID LOOKUP
// PMs can now just enter the quote number (26-0112) and it auto-finds the UUID!

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;

    // ===== MONDAY.COM CHALLENGE VERIFICATION =====
    if (body.challenge) {
      console.log('Received monday.com challenge:', body.challenge);
      return res.status(200).json({ challenge: body.challenge });
    }

    // ===== NORMAL WEBHOOK PROCESSING =====
    console.log('Received webhook payload:', JSON.stringify(body, null, 2));

    // Extract itemId and boardId from the payload
    const itemId = body.itemId || body.event?.pulseId;
    const boardId = body.boardId || '18415679761';

    if (!itemId) {
      console.error('No itemId found in payload');
      return res.status(400).json({ error: 'Missing itemId' });
    }

    console.log(`Processing full sync for item ${itemId} on board ${boardId}`);

    // Get environment variables
    const FLEX_API_KEY = process.env.FLEX_API_KEY;
    const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
    const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://your-flex-instance.com/f5';

    if (!FLEX_API_KEY || !MONDAY_API_KEY) {
      console.error('Missing API keys in environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Step 1: Get the Flex Project # from monday.com item
    const mondayQuery = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          column_values(ids: ["text_mm3x2yr6"]) {
            id
            text
          }
        }
      }
    `;

    const mondayResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-10'
      },
      body: JSON.stringify({ query: mondayQuery })
    });

    const mondayData = await mondayResponse.json();
    
    if (mondayData.errors) {
      console.error('Monday.com API error:', mondayData.errors);
      throw new Error('Failed to fetch item from monday.com');
    }

    const item = mondayData.data.items[0];
    const flexQuoteNumber = item.column_values.find(col => col.id === 'text_mm3x2yr6')?.text;

    if (!flexQuoteNumber) {
      console.error('No Flex Project # found on item');
      await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', 'No Flex Project # found');
      return res.status(400).json({ error: 'No Flex Project # found on item' });
    }

    console.log(`Found Flex Quote #: ${flexQuoteNumber}`);

    // ===== STEP 1.5: AUTO-LOOKUP UUID FROM QUOTE NUMBER =====
    let flexElementId = flexQuoteNumber;

    // If it looks like a quote number (contains hyphen like "26-0112"), search for the UUID
    if (flexQuoteNumber.includes('-') && flexQuoteNumber.length < 20) {
      console.log(`Looking up internal UUID for quote: ${flexQuoteNumber}`);
      
      // Use the global search endpoint that searches all elements (quotes, invoices, etc.)
      const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(flexQuoteNumber)}&searchTypes=all&maxResults=25&includeDeleted=false&includeClosed=true`;
      console.log(`Searching Flex: ${searchUrl}`);

      const searchResponse = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-Auth-Token': FLEX_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!searchResponse.ok) {
        console.error(`Search API error: ${searchResponse.status} ${searchResponse.statusText}`);
        await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', `Failed to search Flex: ${searchResponse.status}`);
        return res.status(500).json({ error: 'Search lookup failed' });
      }

      const searchData = await searchResponse.json();
      console.log('Search results:', JSON.stringify(searchData, null, 2));

      // Flex search returns results in different possible structures
      let results = [];
      if (Array.isArray(searchData)) {
        results = searchData;
      } else if (searchData.results) {
        results = searchData.results;
      } else if (searchData.data) {
        results = Array.isArray(searchData.data) ? searchData.data : [searchData.data];
      }

      if (!results || results.length === 0) {
        console.error('Quote number not found in Flex');
        await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', `Quote ${flexQuoteNumber} not found in Flex`);
        return res.status(404).json({ error: 'Quote not found' });
      }

      // Extract the internal UUID from the first search result
      // Try different possible field names
      const firstResult = results[0];
      flexElementId = firstResult.id || firstResult.elementId || firstResult.uuid || firstResult.element_id || firstResult.elementUuid;

      if (!flexElementId) {
        console.error('Could not extract UUID from search results:', firstResult);
        await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', 'Could not find element ID in search results');
        return res.status(500).json({ error: 'UUID extraction failed' });
      }

      console.log(`✅ Successfully mapped ${flexQuoteNumber} to UUID: ${flexElementId}`);
    } else {
      console.log(`Using provided UUID directly: ${flexElementId}`);
    }

    // Step 2: Fetch FULL project data from Flex API using Header Data endpoint
    // Build the codeList query parameters for all fields we want
    const fieldsToFetch = [
      'name',
      'eventDate',
      'plannedStartDate',
      'plannedEndDate',
      'totalPrice',
      'budgetedRevenue',
      'actualCost',
      'actualRevenue',
      'clientCompany',
      'clientId',
      'venueCompany',
      'venueId',
      'statusId',
      'statusColor'
    ];

    const codeListParams = fieldsToFetch.map(field => `codeList=${field}`).join('&');
    const flexHeaderUrl = `${FLEX_BASE_URL}/api/element/${flexElementId}/header-data?${codeListParams}`;

    console.log(`Fetching from Flex: ${flexHeaderUrl}`);

    const flexHeaderResponse = await fetch(flexHeaderUrl, {
      method: 'GET',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!flexHeaderResponse.ok) {
      console.error(`Flex API error: ${flexHeaderResponse.status} ${flexHeaderResponse.statusText}`);
      await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', `Flex API error: ${flexHeaderResponse.status}`);
      return res.status(500).json({ error: 'Failed to fetch from Flex API' });
    }

    const flexHeaderData = await flexHeaderResponse.json();
    console.log('Flex header data received:', JSON.stringify(flexHeaderData, null, 2));

    // Step 3: Fetch equipment list count (using financial document endpoint for quotes!)
    const flexEquipmentUrl = `${FLEX_BASE_URL}/api/financial-document-line-item/${flexElementId}/row-data/`;
    
    let equipmentCount = 0;
    try {
      const flexEquipmentResponse = await fetch(flexEquipmentUrl, {
        method: 'GET',
        headers: {
          'X-Auth-Token': FLEX_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (flexEquipmentResponse.ok) {
        const flexEquipmentData = await flexEquipmentResponse.json();
        equipmentCount = Array.isArray(flexEquipmentData) ? flexEquipmentData.length : 0;
        console.log(`Fetched ${equipmentCount} equipment items from Flex`);
      } else {
        console.warn('Equipment fetch failed, continuing with 0 count');
      }
    } catch (equipError) {
      console.warn('Equipment fetch error:', equipError.message);
    }

    // Step 4: Transform Flex data to monday.com format
    const columnValues = buildColumnValues(flexHeaderData, equipmentCount);

    console.log('Updating monday.com with values:', JSON.stringify(columnValues, null, 2));

    // Step 5: Update ALL monday.com columns at once
    await updateMondayColumns(itemId, boardId, MONDAY_API_KEY, columnValues);

    // Step 6: Update status to Synced (with no error message!)
    await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Synced', null);

    return res.status(200).json({
      success: true,
      itemId,
      flexQuoteNumber,
      flexElementId,
      syncedFields: Object.keys(columnValues),
      equipmentCount,
      message: 'Full project sync completed successfully'
    });

  } catch (error) {
    console.error('Webhook error:', error);
    
    // Try to update monday.com status to error
    try {
      const itemId = req.body.itemId || req.body.event?.pulseId;
      if (itemId) {
        await updateMondayStatus(
          itemId,
          '18415679761',
          process.env.MONDAY_API_KEY,
          'Sync Error',
          error.message
        );
      }
    } catch (updateError) {
      console.error('Failed to update error status:', updateError);
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

// Helper function to transform Flex header data to monday.com column values
function buildColumnValues(flexHeaderData, equipmentCount) {
  const columnValues = {};

  // Helper to safely extract data value from Flex response
  // Flex returns data directly in the "data" field, not nested in "payloadValue"
  const getValue = (fieldName) => {
    const field = flexHeaderData[fieldName];
    if (!field || !field.data) return null;
    
    // If data is an object with a "name" property, return the name
    if (typeof field.data === 'object' && field.data.name) {
      return field.data.name;
    }
    
    // Otherwise return data directly
    return field.data;
  };

  // Event Date (date_mm3xca9r)
  const eventDate = getValue('eventDate');
  if (eventDate) {
    // Flex returns ISO format like "2026-07-27T05:00:00", monday.com needs YYYY-MM-DD
    const dateOnly = eventDate.split('T')[0];
    columnValues.date_mm3xca9r = { date: dateOnly };
  }

  // Estimated Budget (numeric_mm3xzncg)
  const totalPrice = getValue('totalPrice') || getValue('budgetedRevenue');
  if (totalPrice && totalPrice > 0) {
    columnValues.numeric_mm3xzncg = parseFloat(totalPrice);
  }

  // Actual Spend (numeric_mm3xrd3e)
  const actualCost = getValue('actualCost');
  if (actualCost && actualCost > 0) {
    columnValues.numeric_mm3xrd3e = parseFloat(actualCost);
  }

  // Equipment Count (numeric_mm3zsgna)
  columnValues.numeric_mm3zsgna = equipmentCount;

  // Last Equipment Sync (date_mm3z1vqz)
  columnValues.date_mm3z1vqz = { date: new Date().toISOString().split('T')[0] };

  // Client & Venue in Budget Notes (long_text_mm3x7d7)
  const clientCompany = getValue('clientCompany');
  const venueCompany = getValue('venueCompany');
  
  let notesText = '';
  if (clientCompany) {
    notesText += `Client: ${clientCompany}\n`;
  }
  if (venueCompany) {
    notesText += `Venue: ${venueCompany}`;
  }
  
  if (notesText) {
    columnValues.long_text_mm3x7d7 = notesText;
  }

  return columnValues;
}

// Helper function to update monday.com columns
async function updateMondayColumns(itemId, boardId, apiKey, columnValues) {
  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${itemId},
        board_id: ${boardId},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  if (data.errors) {
    console.error('Error updating columns:', data.errors);
    throw new Error('Failed to update monday.com columns');
  }
  
  return data;
}

// Helper function to update sync status
async function updateMondayStatus(itemId, boardId, apiKey, status, errorMessage) {
  const columnValues = {
    color_mm3y3bxj: { label: status }
  };

  // If there's an error, write it. If not, clear the column!
  if (errorMessage) {
    columnValues.text_mm3zvvqk = errorMessage;
  } else {
    columnValues.text_mm3zvvqk = "";
  }

  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${itemId},
        board_id: ${boardId},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
      }
    }
  `;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  if (data.errors) {
    console.error('Error updating status:', data.errors);
    throw new Error('Failed to update monday.com status');
  }
  
  return data;
}
