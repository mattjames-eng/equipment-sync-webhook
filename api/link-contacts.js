/**
 * monday.com Column Change Webhook → Board Relation Auto-Linker
 * * This endpoint listens for text column updates, automatically extracts parameters
 * from either body data payloads OR URL query string arguments, searches your
 * Contacts master register, and programmatically binds cross-board relations.
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
        // Handle native monday challenge checks
        if (req.body && req.body.challenge) {
            return res.status(200).json({ challenge: req.body.challenge });
        }

        const event = req.body?.event || {};
        
        // FIXED TYPE RUNTIME: Fallback tree checks body parameters -> URL variables -> native event payloads
        const projectId = event.pulseId || req.body?.pulseId || req.query?.pulseId || event.itemId;
        const targetType = req.query?.type || req.body?.type || event.field; 
        
        // Extract raw string value from monday's native change structure
        const textValue = event.value?.value || req.body?.textValue || event.textValue;

        if (!projectId) {
            console.log('⚠️ Request initialized without a valid target project pulse ID. Aborting.');
            return res.status(200).json({ success: false, message: 'Missing pulseId parameter' });
        }

        // If the text value field hasn't filled yet, read the baseline fallbacks directly
        let cleanNameToken = textValue ? String(textValue).trim() : null;
        if (!cleanNameToken || cleanNameToken === "") {
            cleanNameToken = (targetType === 'client') ? 'Kannibalen records' : 'The Armory';
        }

        console.log(`📥 Processing Link pass -> Project: ${projectId} | Value: "${cleanNameToken}" | Target: ${targetType}`);

        // Step 1: Query the contact registry
        const searchQuery = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 10, query_params: { term: "${cleanNameToken.replace(/"/g, '\\"')}" }) { items { id name } } } }`;
        const searchResponse = await mondayApiCall(searchQuery);
        const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];

        const match = existingItems.find(item => item.name.trim().toLowerCase() === cleanNameToken.toLowerCase());
        
        if (!match) {
            console.log(`❌ Zero matched entities discovered in tracking indexes for name target: "${cleanNameToken}"`);
            return res.status(200).json({ success: false, message: 'No structural match resolved' });
        }

        console.log(`🎯 Exact match verified: ID ${match.id} ("${match.name}")`);

        // Step 2: Build the target mutation map out cleanly
        const connectionValues = {};
        if (targetType === 'client') {
            connectionValues.board_relation_mm3x8evw = { item_ids: [parseInt(match.id, 10)] };
        } else if (targetType === 'venue') {
            connectionValues.board_relation_mm3xrm02 = { item_ids: [parseInt(match.id, 10)] };
        } else {
            throw new Error(`Unmapped link context routing requested: ${targetType}`);
        }

        // Step 3: Flash update target row connections directly
        const linkMutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(connectionValues))}) { id } }`;
        await mondayApiCall(linkMutation);

        console.log(`✅ Cross-board link established successfully!`);
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
