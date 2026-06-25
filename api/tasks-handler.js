/**
 * monday.com Status Controller → Tiered Task Template Injector
 *
 * Listens to changes on the "Tasks Status" column (color_mm3ycrm1).
 * Bypasses duplicate button clicks, enforces progression dependencies,
 * and populates tiered subitems in parallel with type-safe dropdown arrays.
 *
 * Author: Matt James, Antic Studios
 */

export const config = { api: { bodyParser: true } };

const MONDAY_API_URL      = 'https://api.monday.com/v2';
const MONDAY_API_KEY      = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID   = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

// Master routing table for the execution states
const STATUS_ROUTER = {
    'Loading Basic...':    { tierName: 'Basic',    requiredState: null,           successLabel: 'Basic Added'    },
    'Loading Standard...': { tierName: 'Standard', requiredState: 'Basic Added',  successLabel: 'Standard Added' },
    'Loading Complex...':  { tierName: 'Complex',  requiredState: 'Standard Added', successLabel: 'Complex Added' },
    'Loading Festival...': { tierName: 'Festival', requiredState: 'Complex Added', successLabel: 'Festival Added' }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });

    const event         = req.body?.event || {};
    const projectId     = event.pulseId || event.itemId;
    const incomingLabel = event.value?.label?.text;

    if (!projectId || !incomingLabel) {
        return res.status(200).json({ success: false, message: 'Missing parameters, skipping.' });
    }

    // Ignore completion-state echoes to prevent feedback loops
    if (incomingLabel.includes('Added')) {
        return res.status(200).json({ success: true, message: 'Completion state loop ignored.' });
    }

    const route = STATUS_ROUTER[incomingLabel];
    if (!route) {
        return res.status(200).json({ success: false, message: `Unmapped status label ignored: ${incomingLabel}` });
    }

    console.log(`📥 Task injection triggered — Project: ${projectId} | Tier: ${route.tierName}`);

    try {
        // Fetch project state + template in parallel — no reason to wait for one before the other
        const [projectResponse, templateResponse] = await Promise.all([
            mondayApiCall(`query {
                items(ids: [${projectId}]) {
                    column_values(ids: ["color_mm3ycrm1"]) { text }
                    subitems { column_values(ids: ["dropdown_mm3xhker"]) { id text } }
                }
            }`),
            mondayApiCall(`query {
                items(ids: [${TEMPLATE_PROJECT_ID}]) {
                    subitems { name column_values { id text } }
                }
            }`)
        ]);

        const projectNode           = projectResponse.data?.items?.[0];
        const currentTrackingStatus = projectNode?.column_values?.[0]?.text;
        const currentSubitems       = projectNode?.subitems || [];
        const templateSubitems      = templateResponse.data?.items?.[0]?.subitems || [];

        // Guard: tier already injected → flip status and bail cleanly
        const tierAlreadyExists = currentSubitems.some(subitem =>
            subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text === route.tierName
        );
        if (tierAlreadyExists) {
            console.log(`⚠️ [${route.tierName}] tasks already exist — reverting to success state`);
            await updateParentTrackingStatus(projectId, route.successLabel);
            return res.status(200).json({ success: true, message: 'Duplicate addition blocked cleanly.' });
        }

        // Guard: prerequisite tier not yet added
        if (route.requiredState && currentTrackingStatus !== route.requiredState) {
            console.log(`❌ Prerequisite '${route.requiredState}' not met (current: '${currentTrackingStatus}')`);
            await updateParentTrackingStatus(projectId, currentTrackingStatus || 'No Tasks');
            return res.status(200).json({ success: false, error: 'Sequence block handled.' });
        }

        // Filter template to matching tier
        const tasksToInject = templateSubitems.filter(subitem =>
            subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text === route.tierName
        );
        console.log(`🎯 Injecting ${tasksToInject.length} tasks for tier: ${route.tierName}`);

        // Create all subitems in parallel — serial creation at 141 tasks would time out
        await Promise.all(tasksToInject.map(task => {
            const phaseText    = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
            const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;

            const subitemValues = {
                status:            { label: 'Not Started' },
                dropdown_mm3xhker: { labels: [route.tierName] }
            };
            if (phaseText)    subitemValues.dropdown_mm3x2wmx = { labels: [phaseText] };
            if (priorityText) subitemValues.color_mm3x885a    = { label: priorityText };

            return mondayApiCall(`mutation {
                create_subitem(
                    parent_item_id: ${projectId},
                    item_name: "${task.name.replace(/"/g, '\\"')}",
                    column_values: ${JSON.stringify(JSON.stringify(subitemValues))}
                ) { id }
            }`);
        }));

        await updateParentTrackingStatus(projectId, route.successLabel);
        console.log(`✅ ${tasksToInject.length} tasks injected — status: ${route.successLabel}`);

        return res.status(200).json({ success: true, injected: tasksToInject.length });

    } catch (error) {
        console.error('❌ Task injection error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function updateParentTrackingStatus(projectId, labelText) {
    const mutation = `mutation { change_column_value(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_id: "color_mm3ycrm1", value: "{\\"label\\":\\"${labelText}\\"}") { id } }`;
    await mondayApiCall(mutation);
}

async function mondayApiCall(query) {
    const response = await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-10' },
        body: JSON.stringify({ query })
    });
    const data = await response.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors));
    return data;
}
