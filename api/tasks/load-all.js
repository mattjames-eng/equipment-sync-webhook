/**
 * PM Task Template Duplicator - WORKING VERSION
 * Based on the tiered system that successfully created subitems
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  // Handle monday.com challenge
  if (req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body?.event || req.body || {};
  const projectId = event.pulseId || event.itemId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  console.log(`📥 Starting task duplication for Project ID: ${projectId}`);

  try {
    // STEP 1: Fetch template subitems
    const fetchQuery = {
      query: `{
        items(ids: [${TEMPLATE_PROJECT_ID}]) {
          subitems {
            id
            name
            column_values {
              id
              text
            }
          }
        }
      }`
    };

    const fetchResponse = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY
      },
      body: JSON.stringify(fetchQuery)
    });

    const fetchData = await fetchResponse.json();
    
    if (fetchData.errors) {
      console.error('GraphQL errors:', fetchData.errors);
      throw new Error(fetchData.errors[0].message);
    }

    const templateSubitems = fetchData.data?.items?.[0]?.subitems || [];
    console.log(`Found ${templateSubitems.length} template tasks`);

    if (templateSubitems.length === 0) {
      throw new Error('No template tasks found');
    }

    // STEP 2: Duplicate each subitem
    let created = 0;
    
    for (const task of templateSubitems) {
      try {
        // Extract column values
        const tierCol = task.column_values.find(c => c.id === 'dropdown_mm3xhker');
        const phaseCol = task.column_values.find(c => c.id === 'dropdown_mm3x2wmx');
        
        const tier = tierCol?.text || 'Basic';
        const phase = phaseCol?.text || '';
        
        // Build column values
        const columnValues = {
          status: { label: "Not Started" },
          dropdown_mm3xhker: { labels: [tier] }
        };
        
        if (phase) {
          columnValues.dropdown_mm3x2wmx = { labels: [phase] };
        }

        // Create subitem
        const createQuery = {
          query: `mutation {
            create_subitem(
              parent_item_id: ${projectId},
              item_name: "${task.name.replace(/"/g, '\\"')}",
              column_values: ${JSON.stringify(JSON.stringify(columnValues))}
            ) {
              id
            }
          }`
        };

        const createResponse = await fetch(MONDAY_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': MONDAY_API_KEY
          },
          body: JSON.stringify(createQuery)
        });

        const createData = await createResponse.json();
        
        if (createData.errors) {
          console.error(`Failed to create "${task.name}":`, createData.errors[0].message);
        } else {
          created++;
        }
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (taskError) {
        console.error(`Error creating task "${task.name}":`, taskError.message);
      }
    }

    console.log(`✅ Created ${created} tasks`);

    // STEP 3: Update status to "Tasks Loaded"
    const updateQuery = {
      query: `mutation {
        change_simple_column_value(
          board_id: ${PROJECTS_BOARD_ID},
          item_id: ${projectId},
          column_id: "color_mm3ycrm1",
          value: "Tasks Loaded"
        ) {
          id
        }
      }`
    };

    await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY
      },
      body: JSON.stringify(updateQuery)
    });

    return res.status(200).json({ 
      success: true, 
      tasksCreated: created 
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    
    // Reset status on error
    try {
      const errorQuery = {
        query: `mutation {
          change_simple_column_value(
            board_id: ${PROJECTS_BOARD_ID},
            item_id: ${projectId},
            column_id: "color_mm3ycrm1",
            value: "No Tasks"
          ) {
            id
          }
        }`
      };

      await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': MONDAY_API_KEY
        },
        body: JSON.stringify(errorQuery)
      });
    } catch (e) {
      // Ignore
    }

    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
