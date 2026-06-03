// Equipment Pullsheet Sync Webhook - Fixed with monday.com Challenge Verification
// Deploy this to Vercel to replace the existing webhook

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
    // When monday.com sets up a webhook, it sends a challenge that must be echoed back
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

    console.log(`Processing sync for item ${itemId} on board ${boardId}`);

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
    const flexProjectNumber = item.column_values.find(col => col.id === 'text_mm3x2yr6')?.text;

    if (!flexProjectNumber) {
      console.error('No Flex Project # found on item');
      // Update status to error
      await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', 'No Flex Project # found');
      return res.status(400).json({ error: 'No Flex Project # found on item' });
    }

    console.log(`Found Flex Project #: ${flexProjectNumber}`);

    // Step 2: Fetch equipment list from Flex API
    const flexResponse = await fetch(`${FLEX_BASE_URL}/api/projects/${flexProjectNumber}/equipment`, {
      method: 'GET',
      headers: {
        'X-Auth-Token': FLEX_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!flexResponse.ok) {
      console.error(`Flex API error: ${flexResponse.status} ${flexResponse.statusText}`);
      await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Sync Error', `Flex API error: ${flexResponse.status}`);
      return res.status(500).json({ error: 'Failed to fetch from Flex API' });
    }

    const flexData = await flexResponse.json();
    const equipmentList = flexData.equipment || flexData.items || [];

    console.log(`Fetched ${equipmentList.length} equipment items from Flex`);

    // Step 3: Update monday.com with equipment count and sync timestamp
    await updateMondayColumns(itemId, boardId, MONDAY_API_KEY, equipmentList.length);

    // Step 4: Update status to Synced
    await updateMondayStatus(itemId, boardId, MONDAY_API_KEY, 'Synced', null);

    return res.status(200).json({
      success: true,
      itemId,
      flexProjectNumber,
      equipmentCount: equipmentList.length,
      message: 'Equipment sync completed successfully'
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

// Helper function to update monday.com columns
async function updateMondayColumns(itemId, boardId, apiKey, equipmentCount) {
  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${itemId},
        board_id: ${boardId},
        column_values: ${JSON.stringify(JSON.stringify({
          numeric_mm3zsgna: equipmentCount,
          date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] }
        }))}
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
  const statusMap = {
    'Not Synced': 10,
    'Syncing': 0,
    'Synced': 1,
    'Sync Error': 2
  };

  const columnValues = {
    color_mm3y3bxj: { label: status }
  };

  // If there's an error message, update the error column
  if (errorMessage) {
    columnValues.text_mm3zvvqk = errorMessage;
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
