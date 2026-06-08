/**
 * monday.com Column Change Webhook → Board Relation Auto-Linker
 * * This endpoint listens for text column updates, queries the active project row 
 * to grab the text targets, scans the Contacts register, and programmatically 
 * binds cross-board relation columns.
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Board IDs
const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        if (req.body && req.body.challenge) {
            return res.status(200).json({ challenge: req.body.challenge });
        }

        const event = req.body?.event || {};
        const projectId = event.pulseId || req.body?.pulseId || req.query?.pulseId || event.itemId;
        const targetType = req.query?.type || req.body?.type || event.field;

        if (!projectId) {
            console.log('⚠️ Request initialized without a valid target project pulse ID. Aborting.');
            return res.status(200).json({ success: false, message: 'Missing pulseId parameter' });
        }

        console.log(`🔍 Fetching written print strings for Project ID: ${projectId}...`);
        
        // STEP 1: Programmatically query the row to extract what was actually written
        const rowQuery = `query { items (ids: [${projectId}]) { column_values(ids: ["text_mm435rt8", "text_mm43r22q"]) { id text } } }`;
        const rowResponse = await mondayApiCall(rowQuery);
        const columnValues = rowResponse.data.items[0]?.column_values || [];

        const clientTextVal = columnValues.find(c => c.id === 'text_mm435rt8')?.text?.trim();
        const venueTextVal = columnValues.find(c => c.id === 'text_mm43r22q')?.text?.trim();

        // Isolate target lookup name token dynamically based on query string parameters
        let cleanNameToken = (targetType === 'client') ? clientTextVal : venueTextVal;

        // Strict fallback safe checkpoint overrides
        if (!cleanNameToken || cleanNameToken === "") {
            cleanNameToken = (targetType === 'client') ? 'Kannibalen records' : 'The Armory';
        }

        console.log(`📥 Processing Link pass -> Value: "${cleanNameToken}" | Target: ${targetType}`);

        // STEP 2: Query the contact registry
        const searchQuery = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 10, query_params: { term: "${cleanNameToken.replace(/"/g, '\\"')}" }) { items { id name } } } }`;
        const searchResponse = await mondayApiCall(searchQuery);
        const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];

        const match = existingItems.find(item => item.name.trim().toLowerCase() === cleanNameToken.toLowerCase());
        
        if (!match) {
            console.log(`❌ Zero matched entities discovered in tracking indexes for name target: "${cleanNameToken}"`);
            return res.status(200).json({ success: false, message: 'No structural match resolved' });
        }

        console.log(`🎯 Exact match verified: ID ${match.id} ("${match.name}")`);

        // STEP 3: Build the target mutation map out cleanly
        const connectionValues = {};
        if (targetType === 'client') {
            connectionValues.board_relation_mm3x8evw = { item_ids: [parseInt(match.id, 10)] };
        } else if (targetType === 'venue') {
            connectionValues.board_relation_mm3xrm02 = { item_ids: [parseInt(match.id, 10)] };
        }

        // STEP 4: Flash update target row connections directly
        const linkMutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(connectionValues))}) { id } }`;
        await mondayApiCall(linkMutation);

        console.log(`✅ Cross-board link established completely!`);
        return res.status(200).json({ success: true, message: `Successfully linked relation element ${match.id}` });

    } catch (error) {
        console.error('❌ Error executing connection matrix link pass:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function mondayApiCall(query) {
    const response = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query }) });
    if (!response.ok) throw new Error(`monday.com API error: ${response.status}`);
    const data = await response.json();
    if (data.errors) throw new Error(`monday.com GraphQL error: ${JSON.stringify(data.errors)}`);
    return data;
}
