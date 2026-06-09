/**
 * Webhook 2: Background Worker
 * Processes all 141 tasks without timeout pressure
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

// Helper function to chunk array
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
    // STEP 1: Fetch template subitems
    const templateQuery = `query($templateId: ID!) { 
      items(ids: [$templateId]) { 
        subitems { 
          id 
          name 
          column_values { 
            id 
            text 
          } 
        } 
      } 
    }`;

    console.log(`🔍 Fetching template subitems...`);
    const templateResponse = await mondayApiCall(templateQuery, { templateId: TEMPLATE_PROJECT_ID });
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    console.log(`🎯 Retrieved [${allTemplateSubitems.length}] tasks from template`);

    if (allTemplateSubitems.length === 0) {
      throw new Error('No subitems found in template');
    }

    // STEP 2: Create subitems in batches
    const taskBatches = chunkArray(allTemplateSubitems, 25);
    console.log(`📊 Processing ${taskBatches.length} batches...`);

    const createSubitemMutation = `
      mutation($parentId: ID!, $itemName: String!, $columnValues: String!) {
        create_subitem(parent_item_id: $parentId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;

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

          await mondayApiCall(createSubitemMutation, {
            parentId: projectId.toString(),
            itemName: task.name,
            columnValues: JSON.stringify(subitemValues)
          });
          
          totalCreated++;
        } catch (rowError) {
          console.error(`⚠️ Failed: "${task.name}" - ${rowError.message}`);
        }
      });

      await Promise.all(batchPromises);
      console.log(`✅ Batch ${batchNumber} done. Total: ${totalCreated}`);
      
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    console.log(`✅ Created ${totalCreated} tasks`);

    // STEP 3: Update status to "Tasks Loaded"
    const updateMutation = `
      mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId, 
          item_id: $itemId, 
          column_id: $columnId, 
          value: $value
        ) {
          id
        }
      }
    `;

    await mondayApiCall(updateMutation, {
      boardId: PROJECTS_BOARD_ID,
      itemId: projectId.toString(),
      columnId: "color_mm3ycrm1",
      value: "Tasks Loaded"
    });

    console.log(`🏁 Worker complete for Project ID: ${projectId}`);

    return res.status(200).json({ 
      success: true, 
      tasksCreated: totalCreated 
    });

  } catch (error) {
    console.error('❌ Worker error:', error.message);
    console.error('❌ Stack:', error.stack);

    // Reset status on error
    try {
      const errorMutation = `
        mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
          change_simple_column_value(
            board_id: $boardId, 
            item_id: $itemId, 
            column_id: $columnId, 
            value: $value
          ) {
            id
          }
        }
      `;
      
      await mondayApiCall(errorMutation, {
        boardId: PROJECTS_BOARD_ID,
        itemId: projectId.toString(),
        columnId: "color_mm3ycrm1",
        value: "No Tasks"
      });
    } catch (updateError) {
      console.error('❌ Failed to reset status:', updateError.message);
    }

    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

async function mondayApiCall(query, variables = null) {
  const payload = { query };
  if (variables) payload.variables = variables;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version': '2024-10'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  
  if (!response.ok) {
    console.error(`❌ HTTP ${response.status}:`, JSON.stringify(data, null, 2));
    throw new Error(`monday API error: ${response.status}`);
  }
  
  if (data.errors) {
    console.error(`❌ GraphQL errors:`, JSON.stringify(data.errors, null, 2));
    throw new Error(`GraphQL error: ${data.errors[0].message}`);
  }
  
  return data;
}
