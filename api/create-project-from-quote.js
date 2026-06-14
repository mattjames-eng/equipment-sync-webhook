/**
 * Flex Quote → monday.com Master Atomic Sync Pipeline + Google Drive Folder Creation
 * 
 * This endpoint handles the entire creation and relationship binding loop 
 * in a single operational step to bypass background automation delays.
 * 
 * NEW: Creates Google Drive folder structure for each project
 * 
 * Workflow:
 * 1. Safely queries Flex via GET /api/search layout guidelines
 * 2. Fetches field parameters using precise comma-separated codeList entries
 * 3. Extracts clean contact UUID strings, filtering out literal key titles (FIX)
 * 4. Resolves human-readable text identities via /api/contact/{uuid}/identity
 * 5. Matches names against the monday Contacts board and links relations inline
 * 6. SEARCHES for existing project by Flex number to prevent duplicates
 * 7. Updates existing project OR creates new one atomically
 * 8. Creates Google Drive folder structure from template
 * 
 * Author: Matt James, Antic Studios
 * Last Updated: June 14, 2026 - ADDED GOOGLE DRIVE INTEGRATION
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY || 'QjT1EKjjVkZoQmmUsIpRK3ggq94bqW34qNCt';

const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';
const PM_DEFAULT_ID = '102097223'; 

// NEW: Google Drive folder creation endpoint
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL || null;

// Precision utility to extract true 36-character UUID tokens from nested Flex metadata structures
function extractContactUuid(obj) {
    if (!obj) return null;
    if (typeof obj === 'string' && obj.trim().length === 36) return obj.trim();
    if (typeof obj === 'object') {
        // NEW: Handle nested data.id structure from Flex API
        if (obj.data && typeof obj.data === 'object' && obj.data.id) {
            return obj.data.id.trim();
        }
        if (obj.data && typeof obj.data === 'string' && obj.data.trim().length === 36) return obj.data.trim();
        if (obj.value && typeof obj.value === 'string' && obj.value.trim().length === 36) return obj.value.trim();
        if (obj.id && typeof obj.id === 'string' && obj.id.trim().length === 36) return obj.id.trim();
        for (const key in obj) {
            if (typeof obj[key] === 'string' && obj[key].trim().length === 36) return obj[key].trim();
        }
    }
    return null;
}

// Global text backup normalization handler
function deepExtractName(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj.trim();
    if (Array.isArray(obj)) return deepExtractName(obj[0]);
    if (typeof obj === 'object') {
        // NEW: Handle nested data.name or data.preferredDisplayString structure from Flex API
        if (obj.data && typeof obj.data === 'object') {
            if (obj.data.preferredDisplayString) return String(obj.data.preferredDisplayString).trim();
            if (obj.data.name) return String(obj.data.name).trim();
        }
        if (obj.displayString) return String(obj.displayString).trim();
        if (obj.preferredDisplayString) return String(obj.preferredDisplayString).trim();
        if (obj.name) return String(obj.name).trim();
        if (obj.value) return String(obj.value).trim();
        if (obj.text) return String(obj.text).trim();
        for (const key in obj) {
            if (key !== 'id' && key !== 'fieldType' && typeof obj[key] === 'string' && obj[key].trim().length > 0) {
                return obj[key].trim();
            }
        }
    }
    return null;
}

// Extract numeric value from Flex ElementHeaderDataPoint wrapper
function extractFlexNumericValue(obj) {
    if (!obj) return 0;
    if (typeof obj === 'number') return obj;
    if (typeof obj === 'string') return parseFloat(obj) || 0;
    if (typeof obj === 'object' && obj.data !== undefined) {
        return typeof obj.data === 'number' ? obj.data : parseFloat(obj.data) || 0;
    }
    return 0;
}

// Resolves a raw contact UUID to a human-readable name string via Flex Identity Dictionary
async function fetchContactNameFromFlex(uuid, fallbackDefault) {
    if (!uuid) return fallbackDefault;
    try {
        const res = await fetch(`${FLEX_BASE_URL}/api/contact/${uuid}/identity`, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        if (res.ok) {
            const identityData = await res.json();
            return identityData.name || identityData.preferredDisplayString || fallbackDefault;
        }
    } catch (e) {
        console.log(`⚠️ Identity lookup bypassed for contact UUID: ${uuid}`);
    }
    return fallbackDefault;
}

// Inline Helper: Scan monday Contacts registry board directly
async function findContactInMondayRegistry(searchText) {
    if (!searchText || searchText.trim() === '' || searchText.includes('Unknown')) return null;
    const safeName = searchText.trim();
    console.log(`🔍 Scanning master contacts index for: "${safeName}"`);

    const query = `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 50, query_params: { term: "${safeName.replace(/"/g, '\\"')}" }) { items { id name } } } }`;

    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query })
        });
        const result = await response.json();
        const items = result.data?.boards?.[0]?.items_page?.items || [];

        const exactMatch = items.find(item => item.name.trim().toLowerCase() === safeName.toLowerCase());
        return exactMatch ? exactMatch.id : null;
    } catch (e) {
        console.error(`❌ Contacts registry lookup timeout:`, e);
        return null;
    }
}

// NEW: Search for existing project by Flex quote number to prevent duplicates
async function findExistingProjectByFlexNumber(flexNumber) {
    if (!flexNumber) return null;
    console.log(`🔎 Checking for existing project with Flex number: "${flexNumber}"`);

    const query = `query {
        items_page_by_column_values(
            limit: 10,
            board_id: ${PROJECTS_BOARD_ID},
            columns: [
                {
                    column_id: "text_mm3x2yr6",
                    column_values: ["${flexNumber.replace(/"/g, '\\"')}"]
                }
            ]
        ) {
            items {
                id
                name
            }
        }
    }`;

    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query })
        });
        const result = await response.json();
        const items = result.data?.items_page_by_column_values?.items || [];

        if (items.length > 0) {
            console.log(`✅ Found existing project: "${items[0].name}" (ID: ${items[0].id})`);
            return items[0].id;
        }
        
        console.log(`➕ No existing project found - will create new`);
        return null;
    } catch (e) {
        console.error(`❌ Duplicate check failed:`, e);
        return null;
    }
}

// NEW: Create Google Drive folder structure for project
async function createProjectFolder(projectName, projectId, clientName, eventDate, pmEmail) {
    if (!GOOGLE_APPS_SCRIPT_URL) {
        console.log(`⚠️ Google Apps Script URL not configured - skipping folder creation`);
        return null;
    }

    try {
        console.log(`📁 Creating Google Drive folder for: ${projectName}`);
        
        const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectName: projectName,
                projectId: projectId,
                clientName: clientName,
                eventDate: eventDate,
                pmEmail: pmEmail
            })
        });

        const result = await response.json();
        
        if (result.success) {
            console.log(`✅ Google Drive folder created: ${result.folderUrl}`);
            return result;
        } else {
            console.error(`❌ Google Drive folder creation failed: ${result.error}`);
            return null;
        }
    } catch (e) {
        console.error(`❌ Google Drive API error:`, e);
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const quoteId = req.body.quoteNumber || req.body.elementId || req.body.itemId || req.body['Flex Quote Number'];
        if (!quoteId) return res.status(400).json({ error: 'Missing active quote target tracking identifier parameter' });

        console.log(`🔍 Initializing document index locator lookup for quote: ${quoteId}`);
        const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
        const searchResponse = await fetch(searchUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        if (!searchResponse.ok) throw new Error(`Flex Global Search lookup rejected request with status: ${searchResponse.status}`);

        const searchData = await searchResponse.json();
        const results = searchData.data || searchData.content || searchData.elements || searchData;
        if (!results || results.length === 0) throw new Error(`Quote identity reference "${quoteId}" not found in system.`);

        const internalId = results[0].id || results[0].elementId;

        // Fetch Flex quote data
        const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=elementNumber,name,clientId,venueId,eventDate,totalPrice,notes,equipmentList`;
        const dataResponse = await fetch(dataUrl, { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }});
        if (!dataResponse.ok) throw new Error(`Flex header data mapping path failed: ${dataResponse.status}`);

        const data = await dataResponse.json();

        // STEP 1: Precision isolate the real wrapped 36-character UUID strings
        const clientUuid = extractContactUuid(data?.clientId);
        const venueUuid = extractContactUuid(data?.venueId);

        // STEP 2: Resolve true corporate titles from the isolated system addresses
        const clientFallback = deepExtractName(data?.clientId) || '';
        const venueFallback = deepExtractName(data?.venueId) || '';
        
        const clientResolvedName = await fetchContactNameFromFlex(clientUuid, clientFallback);
        const venueResolvedName = await fetchContactNameFromFlex(venueUuid, venueFallback);

        const quoteNumber = deepExtractName(data?.elementNumber) || String(quoteId);
        const projectName = deepExtractName(data?.name) || 'Untitled Project';
        const totalEstimate = extractFlexNumericValue(data?.totalPrice);
        const notesText = deepExtractName(data?.notes) || 'No Notes';

        console.log(`🎯 RESOLVED IDENTITY -> Client: "${clientResolvedName}" | Venue: "${venueResolvedName}"`);

        // STEP 3: Scan the master monday registry board inline to capture row indices
        const matchedClientId = await findContactInMondayRegistry(clientResolvedName);
        const matchedVenueId = await findContactInMondayRegistry(venueResolvedName);

        // STEP 4: Check for existing project by Flex number (DUPLICATE PREVENTION)
        const existingProjectId = await findExistingProjectByFlexNumber(quoteNumber);

        // STEP 5: Build the unified row mapping data frame object
        const columnValues = {
            text_mm3x2yr6: quoteNumber,
            text_mm435rt8: clientResolvedName,
            text_mm43r22q: venueResolvedName,
            multiple_person_mm3xmbb2: { personsAndTeams: [{ id: parseInt(PM_DEFAULT_ID, 10), kind: 'person' }] },
            numeric_mm3xzncg: totalEstimate,
            long_text_mm3xfve1: notesText,
            color_mm3x4534: { label: "Design" },
            color_mm3xhnjc: { label: "Medium" },
            date_mm3z1vqz: { date: new Date().toISOString().split('T')[0] },
            color_mm3y3bxj: { label: "Synced" }
        };

        if (matchedClientId) columnValues.board_relation_mm3x8evw = { item_ids: [parseInt(matchedClientId, 10)] };
        if (matchedVenueId) columnValues.board_relation_mm3xrm02 = { item_ids: [parseInt(matchedVenueId, 10)] };

        if (data?.eventDate) {
            const dateStr = deepExtractName(data.eventDate);
            const dateMatch = dateStr ? dateStr.match(/(\d{4}-\d{2}-\d{2})/) : null;
            if (dateMatch) columnValues.date_mm3xca9r = { date: dateMatch[1] };
        }

        let resultItemId;
        let operationType;
        let driveFolder = null;

        // STEP 6: Update existing OR create new project
        if (existingProjectId) {
            // UPDATE EXISTING PROJECT
            console.log(`🔄 Updating existing project ID: ${existingProjectId}`);
            
            const updateMutation = `mutation {
                change_multiple_column_values(
                    item_id: ${existingProjectId},
                    board_id: ${PROJECTS_BOARD_ID},
                    column_values: ${JSON.stringify(JSON.stringify(columnValues))}
                ) {
                    id
                    name
                }
            }`;

            const updateResponse = await fetch(MONDAY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                body: JSON.stringify({ query: updateMutation })
            });
            
            const updateResult = await updateResponse.json();
            if (updateResult.errors) throw new Error(`monday row update rejected: ${JSON.stringify(updateResult.errors)}`);

            resultItemId = updateResult.data.change_multiple_column_values.id;
            operationType = 'UPDATED';
            console.log(`✅ SUCCESS: Project updated - ID: ${resultItemId}`);

        } else {
            // CREATE NEW PROJECT
            console.log(`➕ Creating new project: "${projectName}"`);
            
            const createMutation = `mutation { create_item(board_id: ${PROJECTS_BOARD_ID}, item_name: "${projectName.replace(/"/g, '\\"')}", column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
            const createResponse = await fetch(MONDAY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                body: JSON.stringify({ query: createMutation })
            });
            
            const createResult = await createResponse.json();
            if (createResult.errors) throw new Error(`monday row initialization rejected: ${JSON.stringify(createResult.errors)}`);

            resultItemId = createResult.data.create_item.id;
            operationType = 'CREATED';
            console.log(`✅ SUCCESS: New project created - ID: ${resultItemId}`);

            // STEP 7: Create Google Drive folder for NEW projects only
            const eventDateStr = columnValues.date_mm3xca9r?.date || '';
            driveFolder = await createProjectFolder(
                projectName,
                resultItemId,
                clientResolvedName,
                eventDateStr,
                'matt.james@anticstudios.com' // Replace with actual PM email lookup
            );
        }

        return res.status(200).json({ 
            success: true, 
            projectId: resultItemId,
            operation: operationType,
            flexNumber: quoteNumber,
            driveFolder: driveFolder ? {
                folderId: driveFolder.folderId,
                folderUrl: driveFolder.folderUrl
            } : null
        });

    } catch (error) {
        console.error('❌ Sync Pipeline Dropout:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
