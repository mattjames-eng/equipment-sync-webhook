/**
 * monday.com Tiered Project Task Template Generator
 * * This unified dynamic endpoint handles task generation for all 4 event complexity tiers.
 * * Routes:
 * - POST /api/tasks/add-basic
 * - POST /api/tasks/add-standard
 * - POST /api/tasks/add-complex
 * - POST /api/tasks/add-festival
 * * Aligns perfectly with the template project matrix on Subitems Board 18415691596
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

// Dynamic execution router map based on Sidekick parameter criteria
const TIER_CONFIGS = {
  'add-basic': { tierName: 'Basic', requiredStatus: null, nextStatus: 'Basic Added' },
  'add-standard': { tierName: 'Standard', requiredStatus: 'Basic Added', nextStatus: 'Standard Added' },
  'add-complex': { tierName: 'Complex', requiredStatus: 'Standard Added', nextStatus: 'Complex Added' },
  'add-festival': { tierName: 'Festival', requiredStatus: 'Complex Added', nextStatus: 'Festival Added' }
};

export default async function handler(req, res) {
  // Rigid CORS framework to ensure app handshakes validate instantly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Handle initial monday connection handshake tests gracefully
  if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const { action } = req.query; // Captures "add-basic", "add-standard", etc. from the filename route parameter
  const config = TIER_CONFIGS[action];

  if (!config) {
    return res.status(400).json({ success: false, error: `Invalid action endpoint specified: ${action}` });
  }

  const event = req.body?.event || req.body || {};
  const projectId = event.pulseId || event.itemId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing active parent project target ID variable' });
  }

  try {
    console.log(`📥 Initializing Atomic Task Pass [${config.tierName}] for Project ID: ${projectId}`);

    // STEP 1: Query Parent Project to ensure checklist progression dependencies match
    if (config.requiredStatus) {
      const parentCheckQuery = `query($ids: [ID!]) { items(ids: $ids) { column_values(ids: ["color_mm3ycrm1"]) { text } } }`;
      const parentResponse = await mondayApiCall(parentCheckQuery, { ids: [projectId.toString()] });
      const currentStatus = parentResponse.data?.items?.[0]?.column_values?.[0]?.text || '';
      
      // Allow progression if it matches the prerequisite OR its own active loading trigger state
      const allowedLoadingStatus = `Loading ${config.tierName}...`;
      
      if (
        currentStatus !== config.requiredStatus && 
        currentStatus !== allowedLoadingStatus && 
        !currentStatus.toLowerCase().includes(config.tierName.toLowerCase())
      ) {
        return res.status(400).json({
          success: false,
          error: `Sequence Block: Must load '${config.requiredStatus}' tasks before escalation to ${config.tierName}. Current state: ${currentStatus || 'None'}`
        });
      }
    }

    // STEP 2: Query the Subitems board matrix configuration matching our Master Template Project
    console.log(`🔍 Fetching blueprint template subitems from parent record: ${TEMPLATE_PROJECT_ID}`);
    const templateQuery = `query($ids: [ID!]) { items(ids: $ids) { subitems { id name column_values { id text } } } }`;
    const templateResponse = await mondayApiCall(templateQuery, { ids: [TEMPLATE_PROJECT_ID] });
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    // STEP 3: Filter using case-insensitive partial match to catch multi-selected tiers flawlessly
    const targetTierTasks = allTemplateSubitems.filter(subitem => {
      const tierValue = subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text || '';
      return tierValue.toLowerCase().includes(config.tierName.toLowerCase());
    });

    console.log(`🎯 Filtered out [${targetTierTasks.length}] tasks matching the [${config.tierName}] index flag.`);

    // Reusable mutation structure for updating the parent status safely via variables
    const updateParentMutation = `
      mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
          id
        }
      }
    `;

    // If no tasks match, clear the UI loading state safely instead of freezing it
    if (targetTierTasks.length === 0) {
      await mondayApiCall(updateParentMutation, {
        boardId: PROJECTS_BOARD_ID,
        itemId: projectId.toString(),
        columnId: "color_mm3ycrm1",
        value: JSON.stringify({ label: config.nextStatus })
      });
      return res.status(200).json({ success: true, tasksAdded: 0, message: `No remaining standalone tasks found for tier context. Advanced state.` });
    }

    // STEP 4: Programmatically generate subitems and carry over matching parameters asynchronously
    const createSubitemMutation = `
      mutation($parentId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_subitem(parent_item_id: $parentId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;

    let operationsLogged = 0;
    for (const task of targetTierTasks) {
      // Isolate Phase, Priority, and baseline settings
      const phaseText = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
      const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;
      
      const subitemValues = {
        status: { label: "Not Started" },
        dropdown_mm3xhker: { labels: [config.tierName] }
      };

      if (phaseText) subitemValues.dropdown_mm3x2wmx = { labels: [phaseText] }; 
      if (priorityText) subitemValues.color_mm3x885a = { label: priorityText }; 

      await mondayApiCall(createSubitemMutation, {
        parentId: projectId.toString(),
        itemName: task.name,
        columnValues: JSON.stringify(subitemValues)
      });
      operationsLogged++;
    }

    // STEP 5: Flash-update parent tracking state checkpoint
    console.log(`🏁 Escalating parent checklist status coordinate label directly to: "${config.nextStatus}"`);
    await mondayApiCall(updateParentMutation, {
      boardId: PROJECTS_BOARD_ID,
      itemId: projectId.toString(),
      columnId: "color_mm3ycrm1",
      value: JSON.stringify({ label: config.nextStatus })
    });

    return res.status(200).json({ success: true, tasksAdded: operationsLogged, tier: config.tierName });

  } catch (error) {
    console.error('❌ Atomic Task Sync Pipeline Dropout:', error);
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

  if (!response.ok) throw new Error(`monday.com HTTP channel rejected request with code: ${response.status}`);
  
  const data = await response.json();
  if (data.errors) throw new Error(`monday.com GraphQL validation fallout: ${JSON.stringify(data.errors)}`);
  return data;
}
