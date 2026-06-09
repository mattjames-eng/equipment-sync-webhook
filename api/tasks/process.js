/**
 * Webhook 2: Background Worker - FIXED
 * Processes all 141 tasks without timeout pressure
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const projectId = req.body?.projectId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  console.log(`🔧 Worker started for Project ID: ${projectId}`);

  try {
    // STEP 1: Fetch template subitems - FIXED QUERY
    console.log(`🔍 Fetching template subitems...`);
    
    const templateResponse = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-10'
      },
      body: JSON.stringify({
        query: `query {
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
      })
    });

    const templateData = await templateResponse.json();
    
    if (templateData.errors) {
      console.error(`❌ GraphQL errors:`, JSON.stringify(templateData.errors, null, 2));
      throw new Error(`GraphQL error: ${templateData.errors[0].message}`);
    }
    
    const allTemplateSubitems = templateData.data?.items?.[0]?.subitems || [];
    console.log(`🎯 Retrieved [${allTemplateSubitems.length}] tasks from template`);

    if (allTemplateSubitems.length === 0) {
      throw new Error('No subitems found in template');
    }

    // STEP 2: Create subitems in batches
    const taskBatches = chunkArray(allTemplateSubitems, 25);
    console.log(`📊 Processing ${taskBatches.length} batches...`);

    let totalCreated = 0;
    let batchNumber = 0;

    for (const batch of taskBatches) {
      batchNumber++;
      console.log(`🔄 Batch ${batchNumber}/${taskBatches.length}...`);

      const batchPromises = batch.map(async (task) => {
        try {
          const phaseText = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
          const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;
          const assignedTier = task.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text || 'Basic';
          
          const subitemValues = {
            status: { label: "Not Started" },
            dropdown_mm3xhker: { labels: assignedTier.split(',').map(s => s.trim()) }
          };

          if (phaseText) subitemValues.dropdown_mm3x2wmx = { labels: phaseText.split(',').map(s => s.trim()) };
          if (priorityText) subitemValues.color_mm3x885a = { label: priorityText };

          const createResponse = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': MONDAY_API_KEY,
              'API-Version': '2024-10'
            },
            body: JSON.stringify({
              query: `mutation {
                create_subitem(
                  parent_item_id: ${projectId},
                  item_name: "${task.name.replace(/"/g, '\\"')}",
                  column_values: ${JSON.stringify(JSON.stringify(subitemValues))}
                ) {
                  id
                }
              }`
            })
          });

          const createData = await createResponse.json();
          
          if (createData.errors) {
            console.error(`⚠️ Failed "${task.name}":`, createData.errors[0].message);
          } else {
            totalCreated++;
          }
        } catch (rowError) {
          console.error(`⚠️ Failed "${task.name}":`, rowError.message);
        }
      });

      await Promise.all(batchPromises);
      console.log(`✅ Batch ${batchNumber} done. Total: ${totalCreated}`);
      
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    console.log(`✅ Created ${totalCreated} tasks`);

    // STEP 3: Update status
    console.log(`🔄 Updating status...`);
    
    await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-10'
      },
      body: JSON.stringify({
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
      })
    });

    console.log(`🏁 Worker complete!`);

    return res.status(200).json({ 
      success: true, 
      tasksCreated: totalCreated 
    });

  } catch (error) {
    console.error('❌ Worker error:', error.message);
    console.error('❌ Stack:', error.stack);

    // Reset status on error
    try {
      await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': MONDAY_API_KEY,
          'API-Version': '2024-10'
        },
        body: JSON.stringify({
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
        })
      });
    } catch (updateError) {
      console.error('❌ Failed to reset status');
    }

    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
