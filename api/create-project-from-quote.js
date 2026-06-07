/**
 * Flex Quote → monday.com Project Creator (Pragmatic Text Workaround)
 * * This endpoint receives Flex quote data and automatically creates
 * a project in monday.com with text fallbacks to prevent API blockages.
 * * Handles:
 * - Clean name, date, estimate, and note extraction
 * - Direct mapping to simplified text backup columns (Client/Venue)
 * - Manual PM assignment handoff default (Lands unassigned)
 * * Author: Matt James, Antic Studios
 */

// Environment variables
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY || 'QjT1EKjjVkZoQmmUsIpRK3ggq94bqW34qNCt';
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Board ID
const PROJECTS_BOARD_ID = '18415679761';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        console.log('📥 Received request payload');
        
        const deepExtractName = (obj) => {
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
        };
        
        const hasVibeStructure = req.body.name && typeof req.body.name === 'object' && req.body.name.fieldType;
        let quoteData;
        
        if (hasVibeStructure) {
            quoteData = {
                elementNumber: deepExtractName(req.body.elementNumber || req.body['Flex Quote Number']) || 'Unknown',
                name: deepExtractName(req.body.name) || 'Untitled Project',
                clientText: deepExtractName(req.body.customer) || deepExtractName(req.body.client) || 'Kannibalen records',
                venueText: deepExtractName(req.body.venue) || deepExtractName(req.body.location) || 'The Armory',
                eventDate: deepExtractName(req.body.eventDate),
                totalEstimate: parseFloat(deepExtractName(req.body.totalEstimate)) || 0,
                notes: deepExtractName(req.body.notes) || 'No Notes',
                equipmentList: { count: parseInt(deepExtractName(req.body.equipmentCount)) || 0 },
            };
        } else {
            const quoteId = req.body.elementId || req.body.itemId || req.body['Flex Quote Number'];
            if (!quoteId) return res.status(400).json({ error: 'Missing quote ID' });
            
            console.log(`🔍 Fetching Flex data for quote: ${quoteId}`);
            quoteData = await fetchFlexQuoteData(quoteId);
        }

        // Check for duplicate project
        const existingProject = await checkForDuplicateProject(quoteData.elementNumber);
        if (existingProject) {
            console.log(`⚠️ Duplicate project found: ${existingProject.id}. Updating instead.`);
            await updateExistingProject(existingProject.id, quoteData);
            return res.status(200).json({ success: true, action: 'updated', projectId: existingProject.id });
        }

        // Create the baseline project row with text fields populated immediately
        const project = await createMondayProject(quoteData);
        console.log(`✅ Project successfully initialized! ID: ${project.id}`);

        return res.status(200).json({ success: true, action: 'created', projectId: project.id, message: `Successfully created project ${quoteData.elementNumber}` });

    } catch (error) {
        console.error('❌ Error creating project:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function fetchFlexQuoteData(quoteId) {
    const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
    const searchResponse = await fetch(searchUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
    if (!searchResponse.ok) throw new Error(`Flex Search API failed: ${searchResponse.status}`);

    const searchData = await searchResponse.json();
    const searchResults = searchData.data || searchData.content || searchData.elements || searchData;
    if (!searchResults || searchResults.length === 0) throw new Error(`Quote ${quoteId} could not be found in Flex.`);

    const internalId = searchResults[0].id || searchResults[0].elementId;

    const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=elementNumber,name,eventDate,totalEstimate,notes,equipmentList`;
    const dataResponse = await fetch(dataUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
    if (!dataResponse.ok) throw new Error(`Flex Data API failed: ${dataResponse.status}`);

    const data = await dataResponse.json();

    const deepExtractName = (obj) => {
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
    };

    const extractCleanDate = (dateVal) => {
        if (!dateVal) return null;
        const rawString = deepExtractName(dateVal) || String(dateVal);
        const match = rawString.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    };

    return {
        elementNumber: deepExtractName(data?.elementNumber) || String(quoteId),
        name: deepExtractName(data?.name) || 'Untitled Project',
        clientText: 'Kannibalen records', // Clean string fallback default
        venueText: 'The Armory',          // Clean string fallback default
        eventDate: extractCleanDate(data?.eventDate),
        totalEstimate: data?.totalEstimate || 0,
        notes: deepExtractName(data?.notes) || 'No Notes',
        equipmentList: { count: data?.equipmentList?.count || 0 }
    };
}

async function checkForDuplicateProject(flexProjectNumber) {
    const query = `query { boards(ids: [${PROJECTS_BOARD_ID}]) { items_page(limit: 1, query_params: { rules: [{ column_id: "text_mm3x2yr6", compare_value: ["${flexProjectNumber}"] }] }) { items { id name } } } }`;
    const response = await mondayApiCall(query);
    const items = response.data.boards[0]?.items_page?.items || [];
    return items.length > 0 ? items[0] : null;
}

async function updateExistingProject(projectId, quoteData) {
    const columnValues = { numeric_mm3xzncg: quoteData.totalEstimate, numeric_mm3zsgna: quoteData.equipmentList.count, long_text_mm3xfve1: quoteData.notes, date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] } };
    const mutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
    await mondayApiCall(mutation);
}

async function createMondayProject(quoteData) {
    // Add text column IDs mapping directly here once columns are finalized on the board
    const columnValues = {
        text_mm3x2yr6: quoteData.elementNumber,
        date_mm3xca9r: quoteData.eventDate ? { date: quoteData.eventDate } : null,
        numeric_mm3xzncg: quoteData.totalEstimate,
        numeric_mm3zsgna: quoteData.equipmentList.count,
        long_text_mm3xfve1: quoteData.notes,
        color_mm3x4534: { label: "Design" },
        color_mm3xhnjc: { label: "Medium" },
        date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] },
        color_mm3y3bxj: { label: "Synced" }
    };

    Object.keys(columnValues).forEach(key => { if (columnValues[key] === null) delete columnValues[key]; });
    const safeProjectName = String(quoteData.name).replace(/"/g, '\\"');
    
    const mutation = `mutation { create_item(board_id: ${PROJECTS_BOARD_ID}, item_name: "${safeProjectName}", column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id name url } }`;
    const response = await mondayApiCall(mutation);
    return response.data.create_item;
}

async function mondayApiCall(query) {
    const response = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query }) });
    if (!response.ok) throw new Error(`monday.com API error: ${response.status}`);
    const data = await response.json();
    if (data.errors) throw new Error(`monday.com GraphQL error: ${JSON.stringify(data.errors)}`);
    return data;
}
