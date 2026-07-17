/**
 * ShowFlow PM Checklist Loader
 *
 * Copies all subitems from the master template project (see TEMPLATE_PROJECT_ID)
 * into a target project, one at a time in strict insertion order.
 *
 * ⚠️  Sequential execution is intentional — do NOT convert to Promise.all or batch.
 *     Parallel requests race each other; monday.com inserts tasks in arrival order,
 *     not submission order, which scrambles the checklist.
 *
 * Route:  POST /api/tasks/load-all
 * Author: Matt James, Antic Studios
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
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  try {
    console.log(`📥 Sequential Task Load starting for Project ID: ${projectId}`);

    // STEP 1: Fetch all subitems from the master template project
    const templateQuery = `query($templateId: [ID!]) { items(ids: $templateId) { subitems { id name column_values { id text } } } }`;
    const templateResponse = await mondayApiCall(templateQuery, { templateId: [TEMPLATE_PROJECT_ID] });
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    console.log(`🎯 Retrieved ${allTemplateSubitems.length} tasks from template`);

    const createSubitemMutation = `
      mutation($parentId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_subitem(parent_item_id: $parentId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;

    let totalCreated = 0;

    // SEQUENTIAL — one await per task preserves insertion order.
    // DO NOT convert this back to Promise.all — parallel requests race each
    // other and monday.com inserts them in an unpredictable order.
    for (const task of allTemplateSubitems) {
      try {
        const phaseText    = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
        const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;
        const assignedTier = task.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text || 'Basic';

        const subitemValues = {
          status: { label: "Not Started" },
          dropdown_mm3xhker: { labels: assignedTier.split(',').map(s => s.trim()) }
        };

        if (phaseText)    subitemValues.dropdown_mm3x2wmx = { labels: phaseText.split(',').map(s => s.trim()) };
        if (priorityText) subitemValues.color_mm3x885a    = { label: priorityText };

        // column_values must be JSON! type AND JSON.stringify()'d — monday expects a JSON string on the wire
        await mondayApiCall(createSubitemMutation, {
          parentId:     projectId.toString(),
          itemName:     task.name,
          columnValues: JSON.stringify(subitemValues)
        });

        totalCreated++;
      } catch (rowError) {
        console.error(`⚠️ Skipped "${task.name}":`, rowError.message);
      }
    }

    // STEP 3: Mark parent project tasks status as loaded
    const updateParentMutation = `
      mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) {
          id
        }
      }
    `;

    await mondayApiCall(updateParentMutation, {
      boardId: PROJECTS_BOARD_ID,
      itemId:  projectId.toString(),
      values:  JSON.stringify({ "color_mm3ycrm1": { "label": "Tasks Loaded" } })
    });

    console.log(`✅ Done — ${totalCreated} tasks created in order`);
    return res.status(200).json({ success: true, totalTasksLoaded: totalCreated });

  } catch (error) {
    console.error('❌ Task pipeline failed:', error);
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

  if (!response.ok) throw new Error(`monday HTTP error: ${response.status}`);
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);

  return data;
}
