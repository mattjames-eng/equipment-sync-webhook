/**
 * Flex Quote → monday.com Project Creator
 * 
 * This endpoint receives Flex quote data and automatically creates
 * a project in monday.com with all fields populated.
 * 
 * Handles:
 * - Client/venue lookup and creation
 * - Duplicate prevention
 * - PM assignment based on budget
 * - Notifications
 * - CORS for Vibe app access
 * - Two-step Flex API lookup using correct /api/search endpoint
 * - Strict nested metadata cleaning for complex Flex objects (Dates & Names)
 * - Vibe app form submissions with "Flex Quote Number" field
 * 
 * Author: Matt James, Antic Studios
 */

// Environment variables (set in Vercel)
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY || 'QjT1EKjjVkZoQmmUsIpRK3ggq94bqW34qNCt';
const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Board IDs
const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';

// PM User IDs
const PM_ASSIGNMENTS = {
    junior: null,
    mid: null,
    senior: null,
    default: '102097223' // Matt James
};

export default async function handler(req, res) {
    // Add CORS headers to allow requests from Vibe app
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        console.log('📥 Received request');
        console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
        
        // Helper to extract clean values from Vibe form fields
        const extractValue = (field) => {
            if (!field) return null;
            if (typeof field === 'string') return field;
            if (typeof field === 'object' && field.data !== undefined) return field.data;
            return String(field);
        };
        
        // Detect if this is from Vibe app (has "Flex Quote Number" field) or Flex webhook (has elementId)
        const vibeQuoteNumber = extractValue(req.body['Flex Quote Number']);
        const flexWebhookId = req.body.elementId || req.body.itemId;
        
        const quoteId = vibeQuoteNumber || flexWebhookId;
        
        if (!quoteId) {
            console.log('❌ Missing quote ID in request');
            return res.status(400).json({ 
                error: 'Missing quote ID', 
                message: 'Please provide either "Flex Quote Number" field or elementId/itemId parameter' 
            });
        }
        
        const source = vibeQuoteNumber ? 'Vibe App' : 'Flex Webhook';
        console.log(`🔍 Processing quote ${quoteId} from ${source}`);

        // Step 1: Fetch full quote details from Flex
        const quoteData = await fetchFlexQuoteData(quoteId);
        console.log(`✅ Fetched quote data: ${quoteData.name}`);

        // Step 2: Check for duplicate project
        const existingProject = await checkForDuplicateProject(quoteData.elementNumber);

        if (existingProject) {
            console.log(`⚠️ Duplicate found: ${existingProject.id}`);
            await updateExistingProject(existingProject.id, quoteData);
            return res.status(200).json({ 
                success: true, 
                action: 'updated', 
                projectId: existingProject.id, 
                message: `Updated existing project ${quoteData.elementNumber}` 
            });
        }

        // Step 3: Find or create client
        const clientId = await findOrCreateContact(quoteData.customer.name, 'Client');
        
        // Step 4: Find or create venue
        const venueId = await findOrCreateContact(quoteData.venue.name, 'Venue');

        // Step 5: Create project in monday.com
        const project = await createMondayProject(quoteData, clientId, venueId);
        console.log(`✅ Created project: ${project.id}`);

        // Step 6: Assign PM based on budget
        const assignedPM = await assignPM(project.id, quoteData.totalEstimate);

        // Step 7: Send notification
        await sendNotification(project.id, quoteData, assignedPM);

        // Success response
        return res.status(200).json({ 
            success: true, 
            action: 'created', 
            projectId: project.id, 
            projectUrl: project.url, 
            flexProjectNumber: quoteData.elementNumber, 
            message: `Successfully created project from Flex quote ${quoteData.elementNumber}` 
        });

    } catch (error) {
        console.error('❌ Error creating project:', error);
        await logError(error, req.body);
        return res.status(500).json({ success: false, error: error.message, details: error.stack });
    }
}

/**
 * Fetch quote data from Flex API using a Two-Step Process
 */
async function fetchFlexQuoteData(quoteId) {
    // STEP 1: Search Flex to find the internal UUID using the correct /api/search endpoint
    const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
    console.log(`🔍 Step 1: Searching for internal Flex ID using quote number: ${quoteId}`);
    
    const searchResponse = await fetch(searchUrl, {
        method: 'GET',
        headers: {
            'X-Auth-Token': FLEX_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        console.error(`❌ Flex Search API error: ${searchResponse.status} - ${errorText}`);
        throw new Error(`Flex Search API failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();
    
    const searchResults = searchData.data || searchData.content || searchData.elements || searchData;
    if (!searchResults || searchResults.length === 0) {
        throw new Error(`Quote ${quoteId} could not be found in Flex. Please verify the quote number.`);
    }

    // Extract the long internal UUID
    const internalId = searchResults[0].id || searchResults[0].elementId;
    console.log(`✅ Step 1 Success! Found internal ID: ${internalId}`);

    // STEP 2: Fetch actual header data with codeList
    const codeList = "elementNumber,name,customer,venue,eventDate,loadInDate,strikeDate,totalEstimate,notes,equipmentList,status,salesRep";
    const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=${codeList}`;
    console.log(`📥 Step 2: Fetching header data using internal ID...`);

    const dataResponse = await fetch(dataUrl, {
        method: 'GET',
        headers: {
            'X-Auth-Token': FLEX_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    if (!dataResponse.ok) {
        const errorText = await dataResponse.text();
        console.error(`❌ Flex Data API error: ${dataResponse.status} - ${errorText}`);
        throw new Error(`Flex Data API failed: ${dataResponse.status}`);
    }

    const data = await dataResponse.json();
    console.log(`✅ Step 2 Success! Raw data structural parse verified.`);

    // Helper to safely pull clean string names out of nested structural properties
    const extractString = (val) => {
        if (!val) return 'Unknown';
        if (typeof val === 'string') return val;
        if (typeof val === 'object') {
            return val.name || val.text || val.value || val.displayString || JSON.stringify(val);
        }
        return String(val);
    };

    // Helper to extract clean YYYY-MM-DD date values from nested layout structures
    const extractCleanDate = (dateVal) => {
        if (!dateVal) return null;
        let rawString = '';
        if (typeof dateVal === 'string') {
            rawString = dateVal;
        } else if (typeof dateVal === 'object') {
            rawString = dateVal.data || dateVal.value || dateVal.date || JSON.stringify(dateVal);
        }
        
        // Use regex pattern extraction to pull out YYYY-MM-DD cleanly
        const match = rawString.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    };

    return {
        elementNumber: extractString(data.elementNumber || quoteId),
        name: extractString(data.name || 'Untitled Project'),
        customer: { name: extractString(data.customer?.name || data.customer || 'Unknown Client') },
        venue: { name: extractString(data.venue?.name || data.venue || 'Unknown Venue') },
        eventDate: extractCleanDate(data.eventDate),
        loadInDate: extractCleanDate(data.loadInDate),
        strikeDate: extractCleanDate(data.strikeDate),
        totalEstimate: data.totalEstimate || 0,
        notes: extractString(data.notes || ''),
        equipmentList: { count: data.equipmentList?.count || 0 },
        status: extractString(data.status || 'Quote'),
        salesRep: { name: extractString(data.salesRep?.name || data.salesRep || 'Unknown') }
    };
}

async function checkForDuplicateProject(flexProjectNumber) {
    const query = `query {
        boards(ids: [${PROJECTS_BOARD_ID}]) {
            items_page(limit: 1, query_params: {
                rules: [{
                    column_id: "text_mm3x2yr6",
                    compare_value: ["${flexProjectNumber}"]
                }]
            }) {
                items { id name }
            }
        }
    }`;
    const response = await mondayApiCall(query);
    const items = response.data.boards[0]?.items_page?.items || [];
    return items.length > 0 ? items[0] : null;
}

async function findOrCreateContact(name, type) {
    const safeName = String(name).replace(/"/g, '\\"');
    const searchQuery = `query {
        boards(ids: [${CONTACTS_BOARD_ID}]) {
            items_page(limit: 1, query_params: {
                rules: [{
                    column_id: "name",
                    compare_value: ["${safeName}"]
                }]
            }) {
                items { id name }
            }
        }
    }`;
    const searchResponse = await mondayApiCall(searchQuery);
    const existingItems = searchResponse.data.boards[0]?.items_page?.items || [];
    
    if (existingItems.length > 0) return existingItems[0].id;

    const createMutation = `mutation {
        create_item(
            board_id: ${CONTACTS_BOARD_ID},
            item_name: "${safeName}",
            column_values: "{\\"dropdown_mm3vqxqh\\":\\"${type}\\",\\"color_mm3vqxqh\\":{\\"label\\":\\"Active\\"}}"
        ) { id }
    }`;
    const createMutationResponse = await mondayApiCall(createMutation);
    return createMutationResponse.data.create_item.id;
}

async function createMondayProject(quoteData, clientId, venueId) {
    const columnValues = {
        text_mm3x2yr6: quoteData.elementNumber,
        board_relation_mm3x8evw: { item_ids: [parseInt(clientId)] },
        board_relation_mm3xrm02: { item_ids: [parseInt(venueId)] },
        date_mm3xca9r: quoteData.eventDate ? { date: quoteData.eventDate } : null,
        numeric_mm3xzncg: quoteData.totalEstimate,
        numeric_mm3zsgna: quoteData.equipmentList.count,
        long_text_mm3xfve1: quoteData.notes,
        color_mm3x4534: { label: "Design" },
        color_mm3xhnjc: { label: "Medium" },
        date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] },
        color_mm3y3bxj: { label: "Synced" }
    };

    Object.keys(columnValues).forEach(key => {
        if (columnValues[key] === null) delete columnValues[key];
    });

    const safeProjectName = String(quoteData.name).replace(/"/g, '\\"');
    const mutation = `mutation {
        create_item(
            board_id: ${PROJECTS_BOARD_ID},
            item_name: "${safeProjectName}",
            column_values: ${JSON.stringify(JSON.stringify(columnValues))}
        ) { id name url }
    }`;
    const response = await mondayApiCall(mutation);
    return response.data.create_item;
}

async function updateExistingProject(projectId, quoteData) {
    const columnValues = {
        numeric_mm3xzncg: quoteData.totalEstimate,
        numeric_mm3zsgna: quoteData.equipmentList.count,
        long_text_mm3xfve1: quoteData.notes,
        date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] }
    };
    const mutation = `mutation {
        change_multiple_column_values(
            board_id: ${PROJECTS_BOARD_ID},
            item_id: ${projectId},
            column_values: ${JSON.stringify(JSON.stringify(columnValues))}
        ) { id }
    }`;
    await mondayApiCall(mutation);
}

async function assignPM(projectId, budget) {
    let pmUserId;
    if (budget < 50000) pmUserId = PM_ASSIGNMENTS.junior || PM_ASSIGNMENTS.default;
    else if (budget < 150000) pmUserId = PM_ASSIGNMENTS.mid || PM_ASSIGNMENTS.default;
    else pmUserId = PM_ASSIGNMENTS.senior || PM_ASSIGNMENTS.default;

    if (!pmUserId) return null;

    const mutation = `mutation {
        change_multiple_column_values(
            board_id: ${PROJECTS_BOARD_ID},
            item_id: ${projectId},
            column_values: "{\\"multiple_person_mm3xmbb2\\":{\\"personsAndTeams\\":[{\\"id\\":${pmUserId},\\"kind\\":\\"person\\"}]}}"
        ) { id }
    }`;
    await mondayApiCall(mutation);
    return pmUserId;
}

async function sendNotification(projectId, quoteData, pmUserId) {
    const userId = pmUserId || PM_ASSIGNMENTS.default;
    const safeProjectName = String(quoteData.name).replace(/"/g, '\\"');
    
    // REMOVED UNSUPPORTED PAYLOAD ARGUMENT HERE
    const mutation = `mutation {
        create_notification(
            user_id: ${userId},
            target_id: ${projectId},
            target_type: Project,
            text: "New project created from Flex: ${safeProjectName} (${quoteData.elementNumber})"
        ) { text }
    }`;
    await mondayApiCall(mutation);
}

async function logError(error, payload) {
    console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        payload: payload,
        timestamp: new Date().toISOString()
    });
}

async function mondayApiCall(query) {
    const response = await fetch(MONDAY_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': MONDAY_API_KEY
        },
        body: JSON.stringify({ query })
    });
    if (!response.ok) {
        throw new Error(`monday.com API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.errors) {
        throw new Error(`monday.com GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    return data;
}
