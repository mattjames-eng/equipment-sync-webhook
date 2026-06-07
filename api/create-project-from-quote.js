/**
 * Flex Quote → monday.com Project Creator
 * * This endpoint receives Flex quote data and automatically creates
 * a project in monday.com with all fields populated.
 * * Handles:
 * - Client/venue lookup and creation (Strict duplicate prevention)
 * - Multi-step Board Relation connection binding
 * - Manual PM assignment default (Lands unassigned)
 * - Recursive "Deep-Dive" text extraction for complex Flex payloads
 * - LAYER 3: Dedicated Contact API routing (with Date Safety Patch)
 * * Author: Matt James, Antic Studios
 */

// Environment variables
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY || 'QjT1EKjjVkZoQmmUsIpRK3ggq94bqW34qNCt';
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
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
                if (obj.data) return typeof obj.data === 'string' ? obj.data.trim() : deepExtractName(obj.data);
                
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
                customer: { name: deepExtractName(req.body.customer) || deepExtractName(req.body.client) || 'Unknown Client' },
                venue: { name: deepExtractName(req.body.venue) || deepExtractName(req.body.location) || 'Unknown Venue' },
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
        
        console.log(`🎯 PROJECT NAME EXTRACTED: [${quoteData.name}]`);
        console.log(`👥 CLIENT EXTRACTED: [${quoteData.customer.name}] | 📍 VENUE EXTRACTED: [${quoteData.venue.name}]`);

        // Check for duplicate project
        const existingProject = await checkForDuplicateProject(quoteData.elementNumber);
        if (existingProject) {
            console.log(`⚠️ Duplicate project found: ${existingProject.id}. Updating instead.`);
            await updateExistingProject(existingProject.id, quoteData);
            return res.status(200).json({ success: true, action: 'updated', projectId: existingProject.id });
        }

        // Database Contact Lookups
        const clientId = await findOrCreateContact(quoteData.customer.name, 'Client');
        const venueId = await findOrCreateContact(quoteData.venue.name, 'Venue');

        // Create the base project
        const project = await createMondayProject(quoteData);
        console.log(`✅ Base project record created! ID: ${project.id}`);

        // Bind Cross-Board Relations (Which automatically triggers the mirror columns)
        await bindProjectRelations(project.id, clientId, venueId);

        return res.status(200).json({ success: true, action: 'created', projectId: project.id, message: `Successfully created project ${quoteData.elementNumber}` });

    } catch (error) {
        console.error('❌ Error creating project:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function fetchFlexQuoteData(quoteId) {
    // LAYER 1: Hit the Search API
    const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
    const searchResponse = await fetch(searchUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
    if (!searchResponse.ok) throw new Error(`Flex Search API failed: ${searchResponse.status}`);

    const searchData = await searchResponse.json();
    const searchResults = searchData.data || searchData.content || searchData.elements || searchData;
    if (!searchResults || searchResults.length === 0) throw new Error(`Quote ${quoteId} could not be found in Flex.`);

    const internalId = searchResults[0].id || searchResults[0].elementId;
    const searchObj = searchResults[0];

    // LAYER 2: Hit the Header-Data API
    const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}`;
    const dataResponse = await fetch(dataUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
    const data = dataResponse.ok ? await dataResponse.json() : {};

    const deepExtractName = (obj) => {
        if (!obj) return null;
        if (typeof obj === 'string') return obj.trim();
        if (Array.isArray(obj)) return deepExtractName(obj[0]);
        if (typeof obj === 'object') {
            if (obj.displayString) return String(obj.displayString).trim();
            if (obj.name) return String(obj.name).trim();
            if (obj.value) return String(obj.value).trim();
            if (obj.text) return String(obj.text).trim();
            if (obj.data) return typeof obj.data === 'string' ? obj.data.trim() : deepExtractName(obj.data);
            for (const key in obj) {
                if (typeof obj[key] === 'string' && obj[key].trim().length > 0) return obj[key].trim();
            }
        }
        return null;
    };

    // PATCHED: Date safety check to prevent undefined .match() crashes
    const extractCleanDate = (dateVal) => {
        if (!dateVal) return null;
        const rawString = deepExtractName(dateVal) || String(dateVal);
        const match = rawString.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    };

    // LAYER 3: Hit the Dedicated Contacts API
    let fetchedClient = null;
    let fetchedVenue = null;
    try {
        const contactUrl = `${FLEX_BASE_URL}/api/element/${internalId}/contact`;
        const contactResponse = await fetch(contactUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        
        if (contactResponse.ok) {
            const contactData = await contactResponse.json();
            console.log("🚨 RAW CONTACTS API PAYLOAD:", JSON.stringify(contactData));
            
            const contactList = Array.isArray(contactData) ? contactData : (contactData.data || contactData.content || [contactData]);
            
            contactList.forEach(c => {
                const typeStr = JSON.stringify(c).toLowerCase();
                const name = deepExtractName(c.contact || c.company || c.name || c);
                
                // Route the extracted name to the right bucket based on Flex's internal tagging
                if (typeStr.includes('client') || typeStr.includes('customer')) {
                    fetchedClient = name;
                } else if (typeStr.includes('venue') || typeStr.includes('location') || typeStr.includes('site')) {
                    fetchedVenue = name;
                }
            });
        }
    } catch (e) {
        console.log("⚠️ Could not fetch from /contact endpoint", e.message);
    }

    return {
        elementNumber: deepExtractName(data?.elementNumber) || String(quoteId),
        name: deepExtractName(data?.name) || deepExtractName(searchObj?.name) || 'Untitled Project',
        // Fallback chain: Contact API -> Header API -> Search API -> Default
        customer: { name: fetchedClient || deepExtractName(data?.customer) || deepExtractName(searchObj?.customer) || 'Unknown Client' },
        venue: { name: fetchedVenue || deepExtractName(data?.venue) || deepExtractName(searchObj?.venue) || 'Unknown Venue' },
        eventDate: extractCleanDate(data?.eventDate) || extractCleanDate(searchObj?.eventDate),
        totalEstimate: data?.totalEstimate || searchObj?.totalEstimate || 0,
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

async function findOrCreateContact(name, type) {
    if (!name || name === 'Unknown Client' || name === 'Unknown Venue' || name === 'Unknown' || name === '') {
        console.log(`⚠️ Skipping database search: Flex payload returned an empty/unknown ${type} name.`);
        return null;
    }

    const safeName = String(name).trim();
    console.log(`🔍 Scanning contacts registry for existing ${type}: "${safeName}"`);

    const searchQuery = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 10, query_params: { term: "${safeName.replace(/"/g, '\\"')}" }) { items { id name } } } }`;
    const searchResponse = await mondayApiCall(searchQuery);
    const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];
    
    const match = existingItems.find(item => item.name.trim().toLowerCase() === safeName.toLowerCase());
    if (match) {
        console.log(`🎯 Exact match found! Linking to ID: ${match.id}`);
        return match.id;
    }

    console.log(`✨ No match found. Generating new contact entry for ${type}: "${safeName}"`);
    const escapedSafeName = safeName.replace(/"/g, '\\"');
    const createMutation = `mutation { create_item(board_id: ${CONTACTS_BOARD_ID}, item_name: "${escapedSafeName}", column_values: "{\\"dropdown_mm3vqxqh\\":\\"${type}\\",\\"color_mm3vqxqh\\":{\\"label\\":\\"Active\\"}}") { id } }`;
    const createMutationResponse = await mondayApiCall(createMutation);
    return createMutationResponse.data.create_item.id;
}

async function createMondayProject(quoteData) {
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

async function bindProjectRelations(projectId, clientId, venueId) {
    const connectionValues = {};
    if (clientId) connectionValues.board_relation_mm3x8evw = { item_ids: [parseInt(clientId, 10)] };
    if (venueId) connectionValues.board_relation_mm3xrm02 = { item_ids: [parseInt(venueId, 10)] };

    if (Object.keys(connectionValues).length === 0) {
        console.log('⚠️ No valid Client or Venue IDs were resolved. Skipping relationship binding step.');
        return;
    }

    console.log(`🔗 Linking Client [${clientId || 'Empty'}] and Venue [${venueId || 'Empty'}] to the Project Item...`);
    const mutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(connectionValues))}) { id } }`;
    await mondayApiCall(mutation);
}

async function updateExistingProject(projectId, quoteData) {
    const columnValues = { numeric_mm3xzncg: quoteData.totalEstimate, numeric_mm3zsgna: quoteData.equipmentList.count, long_text_mm3xfve1: quoteData.notes, date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] } };
    const mutation = `mutation { change_multiple_column_values(board_id: ${PROJECTS_BOARD_ID}, item_id: ${projectId}, column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
    await mondayApiCall(mutation);
}

async function mondayApiCall(query) {
    const response = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query }) });
    if (!response.ok) throw new Error(`monday.com API error: ${response.status}`);
    const data = await response.json();
    if (data.errors) throw new Error(`monday.com GraphQL error: ${JSON.stringify(data.errors)}`);
    return data;
}
