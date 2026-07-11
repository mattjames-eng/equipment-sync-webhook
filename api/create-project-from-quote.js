/**
 * Flex Quote → monday.com Master Atomic Sync Pipeline + Google Drive Folder Creation
 * 
 * This endpoint handles the entire creation and relationship binding loop 
 * in a single operational step to bypass background automation delays.
 * 
 * NEW: Creates Google Drive folder structure for each project
 * NEW: Writes all three Flex UUIDs (Event Folder, Quote, Equipment List) at creation time
 * 
 * Workflow:
 * 1. Safely queries Flex via GET /api/search layout guidelines
 * 2. Classifies search results to extract all three UUIDs (Event Folder, Quote, Equip List)
 * 3. Fetches field parameters using precise comma-separated codeList entries
 * 4. Extracts clean contact UUID strings, filtering out literal key titles (FIX)
 * 5. Resolves human-readable text identities via /api/contact/{uuid}/identity
 * 6. Matches names against the monday Contacts board and links relations inline
 * 7. SEARCHES for existing project by Flex number to prevent duplicates
 * 8. Updates existing project OR creates new one atomically
 * 9. Creates Google Drive folder structure from template
 * 
 * Author: Matt James, Antic Studios
 * Last Updated: June 16, 2026 - v3: Replaced broken API fallbacks with name-based second search
 *   - Step 1.6: strips quote suffix from name ("Hoofbeat 2026 - Video Walls" → "Hoofbeat 2026"),
 *     fires a second Flex search, and classifies ALL results — can find both Event Folder
 *     AND Equipment List UUID in a single call
 *   - Step 1.7: retained as last-resort equipment list scan using folder UUID if 1.6 found
 *     the folder but not the equipment list
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';
const PM_DEFAULT_ID     = process.env.PM_DEFAULT_MONDAY_USER_ID || '102097223';

const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL || null;

// ================================================================
// HELPER: Precision utility to extract true 36-character UUID tokens
// from nested Flex metadata structures
// ================================================================
function extractContactUuid(obj) {
    if (!obj) return null;
    if (typeof obj === 'string' && obj.trim().length === 36) return obj.trim();
    if (typeof obj === 'object') {
        if (obj.data && typeof obj.data === 'object' && obj.data.id) return obj.data.id.trim();
        if (obj.data && typeof obj.data === 'string' && obj.data.trim().length === 36) return obj.data.trim();
        if (obj.value && typeof obj.value === 'string' && obj.value.trim().length === 36) return obj.value.trim();
        if (obj.id && typeof obj.id === 'string' && obj.id.trim().length === 36) return obj.id.trim();
        for (const key in obj) {
            if (typeof obj[key] === 'string' && obj[key].trim().length === 36) return obj[key].trim();
        }
    }
    return null;
}

// ================================================================
// HELPER: Global text backup normalization handler
// ================================================================
function deepExtractName(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj.trim();
    if (Array.isArray(obj)) return deepExtractName(obj[0]);
    if (typeof obj === 'object') {
        if (obj.data && typeof obj.data === 'object') {
            if (obj.data.preferredDisplayString) return String(obj.data.preferredDisplayString).trim();
            if (obj.data.name) return String(obj.data.name).trim();
        }
        if (obj.displayString)            return String(obj.displayString).trim();
        if (obj.preferredDisplayString)   return String(obj.preferredDisplayString).trim();
        if (obj.name)                     return String(obj.name).trim();
        if (obj.value)                    return String(obj.value).trim();
        if (obj.text)                     return String(obj.text).trim();
        for (const key in obj) {
            if (key !== 'id' && key !== 'fieldType' && typeof obj[key] === 'string' && obj[key].trim().length > 0) {
                return obj[key].trim();
            }
        }
    }
    return null;
}

// ================================================================
// HELPER: Extract numeric value from Flex ElementHeaderDataPoint wrapper
// ================================================================
function extractFlexNumericValue(obj) {
    if (!obj) return 0;
    if (typeof obj === 'number') return obj;
    if (typeof obj === 'string') return parseFloat(obj) || 0;
    if (typeof obj === 'object' && obj.data !== undefined) {
        return typeof obj.data === 'number' ? obj.data : parseFloat(obj.data) || 0;
    }
    return 0;
}

// ================================================================
// HELPER: Resolves a raw contact UUID to a human-readable name string
// via Flex Identity Dictionary
// ================================================================
async function fetchContactNameFromFlex(uuid, fallbackDefault) {
    if (!uuid) return fallbackDefault;
    try {
        const res = await fetch(`${FLEX_BASE_URL}/api/contact/${uuid}/identity`, {
            headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
        });
        if (res.ok) {
            const identityData = await res.json();
            return identityData.name || identityData.preferredDisplayString || fallbackDefault;
        }
    } catch (e) {
        console.log(`⚠️ Identity lookup bypassed for contact UUID: ${uuid}`);
    }
    return fallbackDefault;
}

// ================================================================
// HELPER: Resolves a contact UUID to { name, email } via Flex Identity
// ================================================================
async function fetchContactIdentityFromFlex(uuid) {
    if (!uuid) return null;
    try {
        const res = await fetch(`${FLEX_BASE_URL}/api/contact/${uuid}/identity`, {
            headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
        });
        if (res.ok) {
            const data = await res.json();
            return {
                name:  data.name || data.preferredDisplayString || null,
                email: data.email || data.emailAddress || data.primaryEmail || null
            };
        }
    } catch (e) {
        console.log(`⚠️ Identity fetch failed for UUID: ${uuid}`);
    }
    return null;
}

// ================================================================
// HELPER: Find monday.com user by email address
// ================================================================
async function findMondayUserByEmail(email) {
    if (!email) return null;
    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query: `query { users(emails: ["${email}"]) { id email } }` })
        });
        const result = await response.json();
        return result.data?.users?.[0]?.id || null;
    } catch (e) {
        console.log(`⚠️ Monday user lookup failed for: ${email}`);
        return null;
    }
}

// ================================================================
// HELPER: Scan monday Contacts registry board directly
// ================================================================
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

// ================================================================
// HELPER: Search for existing project by Flex quote number to prevent duplicates
// ================================================================
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

// ================================================================
// HELPER: Create Google Drive folder structure for project
// ================================================================
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
                projectName,
                projectId,
                clientName,
                eventDate,
                pmEmail
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

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const quoteId = req.body.quoteNumber || req.body.elementId || req.body.itemId || req.body['Flex Quote Number'];
        if (!quoteId) return res.status(400).json({ error: 'Missing active quote target tracking identifier parameter' });

        // ===== STEP 1: Search Flex for the quote =====
        console.log(`🔍 Initializing document index locator lookup for quote: ${quoteId}`);
        const searchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(quoteId)}&searchTypes=all&includeClosed=true`;
        const searchResponse = await fetch(searchUrl, {
            headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
        });
        if (!searchResponse.ok) throw new Error(`Flex Global Search lookup rejected request with status: ${searchResponse.status}`);

        const searchData = await searchResponse.json();
        console.log('🔍 Raw Flex search response:', JSON.stringify(searchData, null, 2));

        const results = searchData.data || searchData.content || searchData.elements || searchData;
        if (!results || results.length === 0) throw new Error(`Quote identity reference "${quoteId}" not found in system.`);

        // ===== STEP 1.5: CLASSIFY ALL SEARCH RESULTS → EXTRACT THE THREE UUIDs =====
        let quoteUUID         = null;
        let eventFolderUUID   = null;
        let equipmentListUUID = null;

        const resultArray = Array.isArray(results) ? results : [results];

        for (const result of resultArray) {
            const domain = (result.domainId || result.domain || result.type || '').toLowerCase();
            const id     = result.id || result.elementId || result.uuid;
            const name   = result.name || result.displayName || '(no name)';
            console.log(`  📦 domain="${domain}" | id=${id} | name="${name}"`);

            if (['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain)) {
                equipmentListUUID = id;
                console.log(`  📋 → Equipment List UUID: ${id}`);

            } else if (['project', 'event-folder', 'event_folder', 'folder', 'simple-project-element'].includes(domain)) {
                eventFolderUUID = id;
                console.log(`  📁 → Event Folder UUID: ${id}`);

            } else if (['quote', 'financial-document', 'financial_document', 'financialdocument'].includes(domain)) {
                quoteUUID = id;
                console.log(`  📄 → Quote UUID: ${id}`);

            } else {
                console.log(`  ❓ → Unrecognized domain "${domain}" — holding as fallback`);
                if (!quoteUUID) {
                    quoteUUID = id;
                    console.log(`  📄 → Quote UUID (fallback — first unrecognized result): ${id}`);
                }
            }
        }

        const internalId = quoteUUID || resultArray[0].id || resultArray[0].elementId;
        console.log(`\n🔗 Internal ID for header-data fetch: ${internalId}`);

        // ===== STEP 1.6: FALLBACK — Event Folder + Equipment List via Name Search =====
        if (!eventFolderUUID || !equipmentListUUID) {
            try {
                const rawQuoteName  = resultArray[0]?.name || '';
                const dashIndex     = rawQuoteName.lastIndexOf(' - ');
                const strippedName  = dashIndex !== -1 ? rawQuoteName.substring(0, dashIndex).trim() : '';
                const searchTerms   = [];
                if (strippedName) searchTerms.push(strippedName);
                if (rawQuoteName && rawQuoteName !== strippedName) searchTerms.push(rawQuoteName);

                console.log(`\n🔍 STEP 1.6 — Searching for event folder by name. Terms to try: ${JSON.stringify(searchTerms)}`);

                for (const term of searchTerms) {
                    if (eventFolderUUID && equipmentListUUID) break;

                    console.log(`  🔍 Name search: "${term}"`);
                    const nameSearchUrl = `${FLEX_BASE_URL}/api/search?searchText=${encodeURIComponent(term)}&searchTypes=all&includeClosed=true`;
                    const nameSearchRes = await fetch(nameSearchUrl, {
                        headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
                    });
                    console.log(`  Name search status: ${nameSearchRes.status}`);

                    if (!nameSearchRes.ok) {
                        console.warn(`  ⚠️ Name search returned ${nameSearchRes.status} — skipping term`);
                        continue;
                    }

                    const nameSearchData = await nameSearchRes.json();
                    console.log(`📁 Name search results for "${term}":`, JSON.stringify(nameSearchData, null, 2));

                    const nameResults = Array.isArray(nameSearchData)
                        ? nameSearchData
                        : (nameSearchData.data || nameSearchData.content || nameSearchData.elements || []);

                    for (const r of nameResults) {
                        const domain = (r.domainId || r.domain || r.searchType || r.type || '').toLowerCase();
                        const id     = r.id || r.elementId || r.uuid;
                        const rName  = r.name || r.displayName || '(no name)';
                        console.log(`    📦 domain="${domain}" | id=${id} | name="${rName}"`);

                        if (!equipmentListUUID && ['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain)) {
                            equipmentListUUID = id;
                            console.log(`    📋 → Equipment List UUID (from name search): ${id}`);

                        } else if (!eventFolderUUID && ['project', 'event-folder', 'event_folder', 'folder', 'element', 'simple-project-element'].includes(domain)) {
                            eventFolderUUID = id;
                            console.log(`    📁 → Event Folder UUID (from name search): ${id}`);
                        }
                    }
                }

                if (!eventFolderUUID)   console.warn('⚠️ Event Folder UUID still not found after name search');
                if (!equipmentListUUID) console.warn('⚠️ Equipment List UUID still not found after name search');

            } catch (e) {
                console.warn('⚠️ Step 1.6 name search failed:', e.message);
            }
        }

        // ===== STEP 1.7: LAST RESORT — Equipment List UUID via direct endpoint scan =====
        if (!equipmentListUUID) {
            const scanId = eventFolderUUID || internalId;
            const label  = eventFolderUUID ? 'event folder' : 'quote (fallback — no folder UUID yet)';
            console.log(`🔍 Scanning equipment lists under ${label}: ${scanId}`);

            const urlsToTry = [
                `${FLEX_BASE_URL}/api/equipment-list?elementId=${scanId}&page=0&size=10`,
                `${FLEX_BASE_URL}/api/equipment-list?parentElementId=${scanId}&page=0&size=10`,
                `${FLEX_BASE_URL}/api/pull-sheet?elementId=${scanId}&page=0&size=10`,
                `${FLEX_BASE_URL}/api/pull-sheet?parentElementId=${scanId}&page=0&size=10`,
                `${FLEX_BASE_URL}/api/element/${scanId}/equipment-list`,
                `${FLEX_BASE_URL}/api/element/${scanId}/pull-sheet`,
            ];

            for (const url of urlsToTry) {
                try {
                    const eqRes = await fetch(url, {
                        headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
                    });
                    console.log(`  [${eqRes.status}] ${url}`);
                    if (eqRes.ok) {
                        const eqData  = await eqRes.json();
                        console.log('📋 Equipment list response:', JSON.stringify(eqData, null, 2));
                        const eqItems = Array.isArray(eqData) ? eqData : (eqData.content || eqData.data || []);
                        if (eqItems.length > 0) {
                            equipmentListUUID = eqItems[0].id;
                            console.log(`✅ Equipment List UUID: ${equipmentListUUID}`);
                            break;
                        } else {
                            console.warn('  ↳ Returned 200 but zero items in result');
                        }
                    }
                } catch (e) {
                    console.warn(`  ↳ Fetch error on ${url}: ${e.message}`);
                }
            }

            if (!equipmentListUUID) {
                console.warn('⚠️ All equipment list endpoint attempts exhausted — UUID not found this run');
            }
        }

        // Log what we have so far
        console.log('\n📊 UUID SUMMARY (pre-header-data):');
        console.log(`  📁 Event Folder : ${eventFolderUUID   || '❌ NOT FOUND'}`);
        console.log(`  📄 Quote        : ${quoteUUID         || '❌ NOT FOUND'}`);
        console.log(`  📋 Equip List   : ${equipmentListUUID || '❌ NOT FOUND'}`);

        // ===== STEP 2: Fetch Flex quote header data =====
        const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=elementNumber,name,clientId,venueId,personResponsible,eventDate,plannedStartDate,plannedEndDate,totalPrice,notes,equipmentList`;
        const dataResponse = await fetch(dataUrl, {
            headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
        });
        if (!dataResponse.ok) throw new Error(`Flex header data mapping path failed: ${dataResponse.status}`);

        const data = await dataResponse.json();
        console.log('📋 Flex header data:', JSON.stringify(data, null, 2));

        if (!eventFolderUUID) {
            eventFolderUUID = data.parentElementId || data?.data?.parentElementId || null;
            if (eventFolderUUID) console.log(`✅ Event Folder UUID from header data: ${eventFolderUUID}`);
        }

        // ===== STEP 3: Precision isolate the real wrapped 36-character UUID strings =====
        const clientUuid              = extractContactUuid(data?.clientId);
        const venueUuid               = extractContactUuid(data?.venueId);
        const personResponsibleUuid   = extractContactUuid(data?.personResponsible);

        // ===== STEP 4: Resolve true corporate titles =====
        const clientFallback = deepExtractName(data?.clientId) || '';
        const venueFallback  = deepExtractName(data?.venueId)  || '';

        // Resolve both identity lookups in parallel — they're independent Flex API calls
        const [clientResolvedName, venueResolvedName] = await Promise.all([
            fetchContactNameFromFlex(clientUuid, clientFallback),
            fetchContactNameFromFlex(venueUuid,  venueFallback)
        ]);

        const quoteNumber    = deepExtractName(data?.elementNumber) || String(quoteId);
        const projectName    = deepExtractName(data?.name)          || 'Untitled Project';
        const totalEstimate  = extractFlexNumericValue(data?.totalPrice);
        const notesText      = deepExtractName(data?.notes)         || 'No Notes';

        console.log(`🎯 RESOLVED IDENTITY -> Client: "${clientResolvedName}" | Venue: "${venueResolvedName}"`);

        // ===== STEP 4.5: Resolve personResponsible → monday.com user =====
        let accountManagerId = parseInt(PM_DEFAULT_ID, 10);
        if (personResponsibleUuid) {
            const amIdentity = await fetchContactIdentityFromFlex(personResponsibleUuid);
            console.log(`👤 Person Responsible identity:`, amIdentity);
            if (amIdentity?.email) {
                const amUserId = await findMondayUserByEmail(amIdentity.email);
                if (amUserId) {
                    accountManagerId = parseInt(amUserId, 10);
                    console.log(`✅ Account Manager resolved: ${amIdentity.name} (${amIdentity.email}) → monday user ${amUserId}`);
                } else {
                    console.log(`⚠️ No monday user matched email "${amIdentity.email}" — falling back to PM default`);
                }
            } else {
                console.log(`⚠️ personResponsible identity returned no email — falling back to PM default`);
            }
        } else {
            console.log(`ℹ️ No personResponsible in Flex data — using PM default`);
        }

        // ===== STEP 5: Scan monday registry + duplicate check =====
        const [matchedClientId, matchedVenueId, existingProjectId] = await Promise.all([
            findContactInMondayRegistry(clientResolvedName),
            findContactInMondayRegistry(venueResolvedName),
            findExistingProjectByFlexNumber(quoteNumber)
        ]);

        // ===== STEP 6: Build the unified row mapping data frame object =====
        const columnValues = {
            text_mm3x2yr6:             quoteNumber,
            text_mm435rt8:             clientResolvedName,
            text_mm43r22q:             venueResolvedName,
            multiple_person_mm3xmbb2:  { personsAndTeams: [{ id: accountManagerId, kind: 'person' }] },
            numeric_mm3xzncg:          totalEstimate,
            long_text_mm3xfve1:        notesText,
            color_mm3x4534:            { label: "Design" },
            color_mm3xhnjc:            { label: "Medium" },
            date_mm3z1vqz:             { date: new Date().toISOString().split('T')[0] },
            color_mm3y3bxj:            { label: "Synced" },

            // ✅ THE THREE FLEX UUIDs
            ...(eventFolderUUID   && { text_mm466djv: eventFolderUUID }),
            ...(quoteUUID         && { text_mm4cwasc: quoteUUID }),
            ...(equipmentListUUID && { text_mm3y7xwa: equipmentListUUID }),
        };

        if (matchedClientId) columnValues.board_relation_mm3x8evw = { item_ids: [parseInt(matchedClientId, 10)] };
        if (matchedVenueId)  columnValues.board_relation_mm3xrm02 = { item_ids: [parseInt(matchedVenueId,  10)] };

        if (data?.eventDate) {
            const dateStr   = deepExtractName(data.eventDate);
            const dateMatch = dateStr ? dateStr.match(/(\d{4}-\d{2}-\d{2})/) : null;
            if (dateMatch) columnValues.date_mm3xca9r = { date: dateMatch[1] };
        }

        // Prep Date (plannedStartDate from Flex)
        if (data?.plannedStartDate) {
            const dateStr   = deepExtractName(data.plannedStartDate);
            const dateMatch = dateStr ? dateStr.match(/(\d{4}-\d{2}-\d{2})/) : null;
            if (dateMatch) columnValues.date_mm4at0qc = { date: dateMatch[1] };
        }

        // Return Date (plannedEndDate from Flex)
        if (data?.plannedEndDate) {
            const dateStr   = deepExtractName(data.plannedEndDate);
            const dateMatch = dateStr ? dateStr.match(/(\d{4}-\d{2}-\d{2})/) : null;
            if (dateMatch) columnValues.date_mm4a7fn6 = { date: dateMatch[1] };
        }

        console.log('\n📝 Column values to write:', JSON.stringify(columnValues, null, 2));

        console.log('\n📊 FINAL UUID WRITE STATUS:');
        console.log(`  📁 Event Folder → text_mm466djv : ${eventFolderUUID   || '❌ NOT WRITTEN'}`);
        console.log(`  📄 Quote        → text_mm4cwasc  : ${quoteUUID         || '❌ NOT WRITTEN'}`);
        console.log(`  📋 Equip List   → text_mm3y7xwa  : ${equipmentListUUID || '❌ NOT WRITTEN'}`);

        let resultItemId;
        let operationType;
        let driveFolder = null;

        // ===== STEP 7: Update existing OR create new project =====
        if (existingProjectId) {
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

            resultItemId  = updateResult.data.change_multiple_column_values.id;
            operationType = 'UPDATED';
            console.log(`✅ SUCCESS: Project updated - ID: ${resultItemId}`);

        } else {
            console.log(`➕ Creating new project: "${projectName}"`);

            const createMutation = `mutation { create_item(board_id: ${PROJECTS_BOARD_ID}, item_name: "${projectName.replace(/"/g, '\\"')}", column_values: ${JSON.stringify(JSON.stringify(columnValues))}) { id } }`;
            const createResponse = await fetch(MONDAY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                body: JSON.stringify({ query: createMutation })
            });

            const createResult = await createResponse.json();
            if (createResult.errors) throw new Error(`monday row initialization rejected: ${JSON.stringify(createResult.errors)}`);

            resultItemId  = createResult.data.create_item.id;
            operationType = 'CREATED';
            console.log(`✅ SUCCESS: New project created - ID: ${resultItemId}`);

            const eventDateStr = columnValues.date_mm3xca9r?.date || '';
            driveFolder = await createProjectFolder(
                projectName,
                resultItemId,
                clientResolvedName,
                eventDateStr,
                process.env.PM_DEFAULT_EMAIL || 'matt.james@anticstudios.com'
            );
        }

        return res.status(200).json({
            success: true,
            projectId: resultItemId,
            operation: operationType,
            flexNumber: quoteNumber,
            uuids: {
                eventFolder:   { column: 'text_mm466djv', value: eventFolderUUID   || null },
                quote:         { column: 'text_mm4cwasc',  value: quoteUUID         || null },
                equipmentList: { column: 'text_mm3y7xwa',  value: equipmentListUUID || null }
            },
            driveFolder: driveFolder ? {
                folderId:  driveFolder.folderId,
                folderUrl: driveFolder.folderUrl
            } : null
        });

    } catch (error) {
        console.error('❌ Sync Pipeline Dropout:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
