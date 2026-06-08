/**
 * monday.com Tiered Project Task Template Generator (Unconditional Edition)
 * * This unified dynamic endpoint handles task generation for all 4 event complexity tiers.
 * * Routes:
 * - POST /api/tasks/add-basic
 * - POST /api/tasks/add-standard
 * - POST /api/tasks/add-complex
 * - POST /api/tasks/add-festival
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

// Dynamic execution router map explicitly matching literal monday label strings
const TIER_CONFIGS = {
  'add-basic': { tierName: 'Basic', nextStatus: 'Basic Added' },
  'add-standard': { tierName: 'Standard', nextStatus: 'Standard Added' },
  'add-complex': { tierName: 'Complex', nextStatus: 'Complex Added' },
  'add-festival': { tierName: 'Festival', nextStatus: 'Festival Add' }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const { action } = req.query; 
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

    // STEP 1: Query the Subitems board matrix configuration matching our Master Template Project
    console.log(`🔍 Fetching blueprint template subitems from parent record: ${TEMPLATE_PROJECT_ID}`);
    const templateQuery = `query { items(ids: [${TEMPLATE_PROJECT_ID}]) { subitems { id name column_values { id text } } } }`;
    const templateResponse = await mondayApiCall(templateQuery);
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    // STEP 2: Filter using case-insensitive partial match to catch multi-selected tiers flawlessly
    const targetTierTasks = allTemplateSubitems.filter(subitem => {
      const tierValue = subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text || '';
      return tierValue.toLowerCase().includes(config.tierName.toLowerCase());
    });

    console.log(`🎯 Filtered out [${targetTierTasks.length}] tasks matching the [${config.tierName}] index flag.`);

    // Reusable update block to clear loading filters
    const finalParentValues = { "color_mm3ycrm1": { "label": config.nextStatus } };
    const updateParentMutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(finalParentValues))}) { id } }`;

    if (targetTierTasks.length === 0) {
      await mondayApiCall(updateParentMutation);
      return res.status(200).json({ success: true, tasksAdded: 0, message: `No remaining standalone tasks found for tier context. Advanced state.` });
    }

    // STEP 3: Programmatically generate subitems with comprehensive try/catch isolation per row
    let operationsLogged = 0;
    for (const task of targetTierTasks) {
      try {
        const phaseText = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
        const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;
        
        const subitemValues = {
          status: { label: "Not Started" },
          dropdown_mm3xhker: { labels: [config.tierName] }
        };

        // Multi-select safe parsing for dropdown mapping strings
        if (phaseText) {
          subitemValues.dropdown_mm3x2wmx = { labels: phaseText.split(',').map(s => s.trim()) };
        }
        if (priorityText) {
          subitemValues.color_mm3x885a = { label: priorityText };
        }

        const createSubitemMutation = `mutation { create_subitem(parent_item_id: ${projectId}, item_name: ${JSON.stringify(task.name)}, column_values: ${JSON.stringify(JSON.stringify(subitemValues))}) { id } }`;
        await mondayApiCall(createSubitemMutation);
        operationsLogged++;
      } catch (rowError) {
        console.error(`⚠️ Non-fatal exception encountered creating item "${task.name}":`, rowError.message);
      }
    }

    // STEP 4: Force flash-update parent tracking state checkpoint
    console.log(`🏁 Escalating parent checklist status coordinate label directly to: "${config.nextStatus}"`);
    await mondayApiCall(updateParentMutation);

    return res.status(200).json({ success: true, tasksAdded: operationsLogged, tier: config.tierName });

  } catch (error) {
    console.error('❌ Atomic Task Sync Pipeline Dropout:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function mondayApiCall(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version': '2024-10'
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`monday.com HTTP channel rejected request with code: ${response.status}`);
  if (data.errors) throw new Error(`monday.com GraphQL validation fallout: ${JSON.stringify(data.errors)}`);
  return data;
}
