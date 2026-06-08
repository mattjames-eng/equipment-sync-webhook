/**
 * monday.com Tiered Project Task Template Generator (High-Speed Parallel Edition)
 * * This streamlined endpoint handles task generation for the new unified checklist workflow.
 * * Routes: POST /api/tasks/load-all (or any dynamic action fallback route)
 * * Fires all 142 creation mutations concurrently to stay well under Vercel's 10s timeout limit.
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

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
    return res.status(400).json({ success: false, error: 'Missing active parent project target ID variable' });
  }

  try {
    console.log(`📥 Initializing High-Speed Bulk Load for Project ID: ${projectId}`);

    // STEP 1: Fetch ALL subitems directly from the master blueprint template project
    const templateQuery = `query($templateId: [ID!]) { items(ids: $templateId) { subitems { id name column_values { id text } } } }`;
    const templateResponse = await mondayApiCall(templateQuery, { templateId: [TEMPLATE_PROJECT_ID] });
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    console.log(`🎯 Retreived [${allTemplateSubitems.length}] total tasks from the template repository.`);

    // STEP 2: Map tasks into a concurrent array of promises to bypass serverless timeouts
    const createSubitemMutation = `
      mutation($parentId: ID!, $itemName: String!, $columnValues: String!) {
        create_subitem(parent_item_id: $parentId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;

    const duplicatePromises = allTemplateSubitems.map(async (task) => {
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

        return await mondayApiCall(createSubitemMutation, {
          parentId: projectId.toString(),
          itemName: task.name,
          columnValues: JSON.stringify(subitemValues)
        });
      } catch (rowError) {
        console.error(`⚠️ Skipping layout error on item "${task.name}":`, rowError.message);
        return null;
      }
    });

    // Execute all mutations simultaneously in parallel
    await Promise.all(duplicatePromises);

    // STEP 3: Complete execution by setting parent status to advanced confirmation checkpoint
    const updateParentMutation = `
      mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) {
          id
        }
      }
    `;

    console.log(`🏁 Parallel bulk injection complete. Advancing status tracking directly to: "Tasks Loaded"`);
    await mondayApiCall(updateParentMutation, {
      boardId: PROJECTS_BOARD_ID,
      itemId: projectId.toString(),
      values: { "color_mm3ycrm1": { "label": "Tasks Loaded" } }
    });

    return res.status(200).json({ success: true, totalTasksLoaded: allTemplateSubitems.length });

  } catch (error) {
    console.error('❌ Master Task Pipeline Execution Interrupted:', error);
    return res.status(500).json({ success: false, error: error.message });
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
  if (!response.ok) throw new Error(`monday channel rejected with HTTP code: ${response.status}`);
  if (data.errors) throw new Error(`GraphQL validation fault: ${JSON.stringify(data.errors)}`);
  return data;
}
