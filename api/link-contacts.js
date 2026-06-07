/**
 * monday.com Text Handoff → Board Relation Auto-Linker
 * * This endpoint listens for text column changes on the Projects board,
 * searches the Contacts registry, and automatically links the board relation.
 * * Handles:
 * - Dynamic field routing ("client" vs "venue")
 * - Modern token index search parameterization via "term" matching
 * - Strict type parsing for relationship update payloads
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
        // monday.com test challenges / standard automation payload parsing
        const event = req.body.event || req.body;
        if (req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

        const projectId = event.pulseId || event.itemId;
        const textValue = event.value?.value || event.textValue;
        const targetType = event.field || event.type; // Expects "client" or "venue"

        if (!projectId || !textValue) {
            console.log('⚠️ Missing required payload parameters. Skipping linking pass.');
            return res.status(200).json({ success: false, message: 'Missing parameters' });
        }

        console.log(`📥 Received linking request for Project ID ${projectId} | Target Text: "${textValue}" (${targetType})`);

        // Step 1: Scan the contacts board via modern term indexes
        const safeName = String(textValue).trim();
        const searchQuery = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 10, query_params: { term: "${safeName.replace(/"/g, '\\"')}" }) { items { id name } } } }`;
        const searchResponse = await mondayApiCall(searchQuery);
        const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];

        // Isolate exact casing/string matches natively
        const match = existingItems.find(item => item.name.trim().toLowerCase() === safeName.toLowerCase());
        
        if (!match) {
            console.log(`❌ No match found in registry for: "${safeName}". Stopping linkage execution loop.`);
            return res.status(200).json({ success: false, message: 'No contact match found' });
        }

        console.log(`🎯 Target matched in database! Contact Entry ID: ${match.id} ("${match.name}")`);

        // Step 2: Set the correct column target dynamically based on webhook routing data
        const connectionValues = {};
        if (targetType === 'client') {
            connectionValues.board_relation_mm3x8evw = { item_ids: [parseInt(match.id, 10)] };
        } else if (targetType === 'venue') {
            connectionValues.board_relation_mm3xrm02 = { item_ids: [parseInt(match.id, 10)] };
        } else {
            throw new Error(`Invalid structural target layout field assignment requested: ${targetType}`);
        }

        // Step 3: Mutate the target relations on the projects board
        console.log(`🔗 Programmatically binding relationship row indices to project...`);
        const linkMutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(connectionValues))}) { id } }`;
        await mondayApiCall(linkMutation);

        console.log(`✅ Relationship linked completely!`);
        return res.status(200).json({ success: true, message: `Linked contact ID ${match.id} to project ID ${projectId}` });

    } catch (error) {
        console.error('❌ Error in linking automation engine:', error);
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
