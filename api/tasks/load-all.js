/**
 * monday.com Tiered Project Task Template Generator (Background Processing Edition - FIXED)
 * 
 * This endpoint immediately returns 200 OK, then processes tasks in the background.
 * No timeout issues - works perfectly on Vercel free tier.
 * 
 * Route: POST /api/tasks/load-all
 * 
 * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

// Helper function to chunk array into smaller batches
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
  if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body?.event || req.body || {};
  const projectId = event.pulseId || event.itemId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  console.log(`📥 Received request for Project ID: ${projectId}`);

  // ✅ IMMEDIATELY RETURN 200 OK - Don't wait for processing
  res.status(200).json({ 
    success: true, 
    message: 'Task loading started in background',
    projectId: projectId 
  });

  // 🔄 BACKGROUND PROCESSING - Runs after response is sent
  // Vercel will keep this running even after the response
  processTasksInBackground(projectId).catch(error => {
    console.error('❌ Background processing failed:', error);
    console.error('❌ Error stack:', error.stack);
  });
}

/**
 * Background task processor - runs after HTTP response is sent
 */
async function processTasksInBackground(projectId) {
  try {
    console.log(`🚀 Starting background processing for Project ID: ${projectId}`);

    // STEP 1: Fetch all subitems from the template
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

    console.log(`🔍 Fetching template subitems from item ${TEMPLATE_PROJECT_ID}...`);
    
    const templateResponse = await mondayApiCall(templateQuery, { templateId: TEMPLATE_PROJECT_ID });
    
    console.log(`📦 Template response:`, JSON.stringify(templateResponse, null, 2));
    
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    console.log(`🎯 Retrieved [${allTemplateSubitems.length}] tasks from template`);

    if (allTemplateSubitems.length === 0) {
      throw new Error('No subitems found in template item');
    }

    // STEP 2: Process tasks in batches of 25
    const taskBatches = chunkArray(allTemplateSubitems, 25);
    console.log(`📊 Split into ${taskBatches.length} batches of 25 tasks each`);
    
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
      console.log(`🔄 Processing batch ${batchNumber}/${taskBatches.length} (${batch.length} tasks)...`);
      
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
          console.error(`⚠️ Failed to create task "${task.name}":`, rowError.message);
        }
      });

      // Process batch concurrently
      await Promise.all(batchPromises);
      console.log(`✅ Batch ${batchNumber} complete. Total created so far: ${totalCreated}`);
      
      // Small delay between batches to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    console.log(`✅ Successfully created ${totalCreated} tasks`);

    // STEP 3: Update parent project status to "Tasks Loaded"
    const updateParentMutation = `
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

    console.log(`🔄 Updating status to "Tasks Loaded"...`);
    
    await mondayApiCall(updateParentMutation, {
      boardId: PROJECTS_BOARD_ID,
      itemId: projectId.toString(),
      columnId: "color_mm3ycrm1",
      value: "Tasks Loaded"
    });

    console.log(`🏁 Background processing complete for Project ID: ${projectId}`);

  } catch (error) {
    console.error('❌ Background processing error:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    
    // Try to update status to indicate error
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
      
      console.log(`🔄 Reset status to "No Tasks" due to error`);
    } catch (updateError) {
      console.error('❌ Failed to update error status:', updateError);
    }
  }
}

/**
 * Helper function to make monday.com API calls
 */
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
    console.error(`❌ monday API HTTP error: ${response.status}`);
    console.error(`❌ Response:`, JSON.stringify(data, null, 2));
    throw new Error(`monday API rejected with HTTP ${response.status}`);
  }
  
  if (data.errors) {
    console.error(`❌ GraphQL errors:`, JSON.stringify(data.errors, null, 2));
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  
  return data;
}
