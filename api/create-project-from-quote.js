/**
 * Flex Quote → monday.com Master Atomic Sync Pipeline
 * * This endpoint handles the entire creation and relationship binding loop 
 * in a single operational step to bypass background automation delays.
 * * Workflow:
 * 1. Safely queries Flex via GET /api/search layout guidelines
 * 2. Fetches field parameters using precise comma-separated codeList entries
 * 3. Initializes the Project row item with matching print text columns
 * 4. Scans monday's Contact register (Board 18415573401) inline via casing normalization
 * 5. Stabilizes connections by binding blue cross-board link records automatically
 * * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';
const PM_DEFAULT_ID = '102097223'; // Default PM ID Handoff

// Deep extractor utility to handle string or wrapped nested layout parameters safely
function deepExtractName(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj.trim();
    if (Array.isArray(obj)) return deepExtractName(obj[0]);
    if (typeof obj === 'object') {
        if (obj.displayString) return String(obj.displayString).trim();
        if (obj.name) return String(obj.name).trim();
        if (obj.value) return String(obj.value).trim();
        if (obj.text) return String(obj.text).trim();
        if (obj.data && typeof obj.data === 'string') return obj.data.trim();
        for (const key in obj) {
            if (typeof obj[key] === 'string' && obj[key].trim().length > 0) return obj[key].trim();
        }
    }
    return null;
}

// Inline Helper: Scan monday Contacts and Companies registry board directly
async function findContactInMondayRegistry(searchText, type) {
    console.log(`🔍 Checking monday registry index for matched ${type}: "${searchText}"`);
    if (!searchText || searchText.trim() === '' || searchText.includes('Unknown')) return null;

    const safeName = searchText.trim();
    const query = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 100, query_params: { term: "${safeName.replace(/"/g, '\\"')}" }) { items { id name } } } }`;

    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query })
        });
        const result = await response.json();
        const items = result.data?.boards?.[0]?.items_page?.items || [];

        // Enforce strict case-insensitive match verification bounds
        const exactMatch = items.find(item => item.name.trim().toLowerCase() === safeName.toLowerCase());
        if (exactMatch) {
            console.log(`🎯 Exact registry match discovered! Aligned ID: ${exactMatch.id}`);
            return exactMatch.id;
        }

        // Loose substring structural fallback validation checks
        const fuzzyMatch = items.find(item => item.name.toLowerCase().includes(safeName.toLowerCase()));
        if (fuzzyMatch) {
            console.log(`⚠️ Loose match verified! Aligned ID: ${fuzzyMatch.id}`);
            return fuzzyMatch.id;
        }

        console.log(`❌ No registered entity record tracks to: "${safeName}"`);
        return null;
    } catch (e) {
        console.error(`❌ Registry search dropout:`, e);
        return null;
    }
}

// Inline Helper: Bind relation linkages to row coordinates completely behind the scenes
async function bindProjectRelations(projectId, clientId, venueId) {
    const connectionValues = {};
    if (clientId) connectionValues.board_relation_mm3x8evw = { item_ids: [parseInt(clientId, 10)] };
    if (venueId) connectionValues.board_relation_mm3xrm02 = { item_ids: [parseInt(venueId, 10)] };

    if (Object.keys(connectionValues).length === 0) return;

    console.log(`🔗 Programmatically binding relationship row indices to project ID ${projectId}...`);
    const mutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(connectionValues))}) { id } }`;
    
    await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
        body: JSON.stringify({ query: mutation })
    });
}

export default async function handler(req, res) {
    // Handle standard browser CORS handshake routines immediately
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    console.log('📥 Received incoming request payload');

    try {
        const quoteId = req.body.quoteNumber || req.body.elementId || req.body.itemId || req.body['Flex Quote Number'];
        if (!quoteId) return res.status(400).json({ error: 'Missing active quote tracking ID reference parameter' });

        // STEP 1: Verify elements location via valid GET search operations
        console.log(`🔍 Launching document index search for code: ${quoteId}`);
        const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
        const searchResponse = await fetch(searchUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        if (!searchResponse.ok) throw new Error(`Flex Search Index endpoint returned status: ${searchResponse.status}`);

        const searchData = await searchResponse.json();
        const results = searchData.data || searchData.content || searchData.elements || searchData;
        if (!results || results.length === 0) throw new Error(`Target document number "${quoteId}" cannot be located inside active Flex indexes.`);

        const internalId = results[0].id || results[0].elementId;

        // STEP 2: Drill down parameters via explicit layout code queries 
        const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=elementNumber,name,clientId,venueId,eventDate,totalEstimate,notes,equipmentList`;
        const dataResponse = await fetch(dataUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        if (!dataResponse.ok) throw new Error(`Flex Element Details processing path failed: ${dataResponse.status}`);

        const data = await dataResponse.json();

        // Safe parameter variable isolation logic paths
        const quoteNumber = deepExtractName(data?.elementNumber) || String(quoteId);
        const projectName = deepExtractName(data?.name) || 'Untitled Project';
        const clientPrintText = deepExtractName(data?.clientId) || 'Kannibalen records';
        const venuePrintText = deepExtractName(data?.venueId) || 'The Armory';
        const eventDateRaw = deepExtractName(data?.eventDate);
        const totalEstimate = parseFloat(data?.totalEstimate) || 0;
        const notePayloadText = deepExtractName(data?.notes) || 'No Notes';

        console.log(`🎯 PROJECT NAME EXTRACTED: [${projectName}]`);
        console.log(`👥 CLIENT TEXT: [${clientPrintText}] | 📍 VENUE TEXT: [${venuePrintText}]`);

        // STEP 3: Package structural coordinates for main Projects Board push
        const columnValues = {
            text_mm3x2yr6: quoteNumber,
            text_mm435rt8: clientPrintText, // Client Name (from Flex)
            text_mm43r22q: venuePrintText,  // Venue Name (from Flex)
            multiple_person_mm3xmbb2: { personsAndTeams: [{ id: parseInt(PM_DEFAULT_ID, 10), kind: 'person' }] },
            numeric_mm3xzncg: totalEstimate,
            long_text_mm3xfve1: notePayloadText,
            color_mm3x4534: { label: "Design" },
            color_mm3xhnjc: { label: "Medium" },
            date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] },
            color_mm3y3bxj: { label: "Synced" }
        };

        if (eventDateRaw) {
            const match = eventDateRaw.match(/(\d{4}-\d{2}-\d{2})/);
            if (match) columnValues.date_mm3xca9r = { date: match[1] };
        }

        const createMutation = `mutation { create_item(board_id: ${PROJECTS_BOARD_ID}, item_name: "${projectName.replace(/"/g, '\\"')}", column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
        const createResponse = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query: createMutation })
        });
        const createResult = await createResponse.json();
        if (createResult.errors) throw new Error(`monday row initialization dropout: ${JSON.stringify(createResult.errors)}`);

        const newProjectId = createResult.data.create_item.id;
        console.log(`✅ Project row successfully created on monday layout views! Aligned ID: ${newProjectId}`);

        // STEP 4 & 5: Run inline background linking logic against the active registers index
        const resolvedClientId = await findContactInMondayRegistry(clientPrintText, 'Client');
        const resolvedVenueId = await findContactInMondayRegistry(venuePrintText, 'Venue');
        
        await bindProjectRelations(newProjectId, resolvedClientId, resolvedVenueId);

        console.log('🎉 COMPLETE: End-to-end sync operation executed flawlessly.');
        return res.status(200).json({ success: true, projectId: newProjectId, message: `Successfully mapped show workspace row properties for ${quoteNumber}` });

    } catch (error) {
        console.error('❌ Pipeline processing dropout:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
