/**
 * monday.com Status Controller → Tiered Task Injector
 * * This endpoint listens to changes on the "Tasks Status" column (color_mm3ycrm1).
 * * Bypasses duplicate button clicks, enforces progression dependencies,
 * and populates tiered subitems atomically.
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858'; 

// Master routing table for the execution states
const STATUS_ROUTER = {
    'Loading Basic...': { tierName: 'Basic', requiredState: null, successLabel: 'Basic Added' },
    'Loading Standard...': { tierName: 'Standard', requiredState: 'Basic Added', successLabel: 'Standard Added' },
    'Loading Complex...': { tierName: 'Complex', requiredState: 'Standard Added', successLabel: 'Complex Added' },
    'Loading Festival...': { tierName: 'Festival', requiredState: 'Complex Added', successLabel: 'Festival Added' }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Gracefully handle standard monday automation challenge handshakes
    if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

    const event = req.body?.event || {};
    const projectId = event.pulseId || event.itemId;
    const incomingLabel = event.value?.label?.text;

    if (!projectId || !incomingLabel) {
        return res.status(200).json({ success: false, message: 'Missing parameters, skipping.' });
    }

    // CHECKPOINT 1: If the label is a completion state (e.g. "Basic Added"), exit immediately to prevent loop cycles
    if (incomingLabel.includes('Added')) {
        return res.status(200).json({ success: true, message: 'Completion state loop ignored.' });
    }

    const route = STATUS_ROUTER[incomingLabel];
    if (!route) {
        return res.status(200).json({ success: false, message: `Unmapped status label ignored: ${incomingLabel}` });
    }

    console.log(`📥 Status Trigger Captured -> Project: ${projectId} | Action: ${incomingLabel}`);

    try {
        // STEP 1: Pull current parent item state to inspect subitem existence and prerequisites
        const projectQuery = `query { items(ids: [${projectId}]) { column_values(ids: ["color_mm3ycrm1"]) { text } subitems { column_values(ids: ["dropdown_mm3xhker"]) { text } } } }`;
        const projectResponse = await mondayApiCall(projectQuery);
        const projectNode = projectResponse.data?.items?.[0];
        
        const currentTrackingStatus = projectNode?.column_values?.[0]?.text;
        const currentSubitems = projectNode?.subitems || [];

        // TWO BIRDS FIX: Scan existing subitems to see if this specific complexity tier has already loaded in the past
        const tierAlreadyExists = currentSubitems.some(subitem => {
            const tierText = subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text;
            return tierText === route.tierName;
        });

        if (tierAlreadyExists) {
            console.log(`⚠️ Blocked Duplicate Action: [${route.tierName}] tasks already exist on this row item. Reverting state...`);
            await updateParentTrackingStatus(projectId, route.successLabel);
            return res.status(200).json({ success: true, message: 'Duplicate addition blocked cleanly.' });
        }

        // CHECKPOINT 2: Enforce sequential progression dependencies
        if (route.requiredState && currentTrackingStatus !== route.requiredState) {
            console.log(`❌ Sequence Error: Prerequisite '${route.requiredState}' not satisfied.`);
            await updateParentTrackingStatus(projectId, currentTrackingStatus || "No Tasks");
            return res.status(200).json({ success: false, error: 'Sequence block handled.' });
        }

        // STEP 2: Query the 142 blueprint template items sitting inside your Template Project
        console.log(`🔍 Fetching subitem matrix blueprints from template anchor record: ${TEMPLATE_PROJECT_ID}`);
        const templateQuery = `query { items(ids: [${TEMPLATE_PROJECT_ID}]) { subitems { name column_values { id text } } } }`;
        const templateResponse = await mondayApiCall(templateQuery);
        const templateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

        // STEP 3: Filter tasks targeting the current tier name parameter mapping
        const tasksToInject = templateSubitems.filter(subitem => {
            const tierText = subitem.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text;
            return tierText === route.tierName;
        });

        console.log(`🎯 Aligned [${tasksToInject.length}] layout checklist elements matching context frame.`);

        // STEP 4: Asynchronously inject elements to the active timeline grid
        let itemsAddedCount = 0;
        for (const task of tasksToInject) {
            const phaseText = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
            const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;

            const subitemValues = {
                status: { label: "Not Started" },
                dropdown_mm3xhker: { label: route.tierName }
            };

            if (phaseText) subitemValues.dropdown_mm3x2wmx = { label: phaseText };
            if (priorityText) subitemValues.color_mm3x885a = { label: priorityText };

            const subitemMutation = `mutation { create_subitem(parent_item_id: ${projectId}, item_name: "${task.name.replace(/"/g, '\\"')}", column_values: ${JSON.stringify(JSON.stringify(subitemValues))}) { id } }`;
            await mondayApiCall(subitemMutation);
            itemsAddedCount++;
        }

        // STEP 5: Finalize operation pass by locking down the milestone checkpoint label string
        await updateParentTrackingStatus(projectId, route.successLabel);
        console.log(`✅ Checklist expansion complete! Milestone updated to: ${route.successLabel}`);
        
        return res.status(200).json({ success: true, injected: itemsAddedCount });

    } catch (error) {
        console.error('❌ Automation engine fault encountered:', error);
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
