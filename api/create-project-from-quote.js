/**
 * Flex Quote → monday.com Project Sync + Google Drive Folder Creation
 * 
 * This endpoint handles the entire creation and relationship binding loop 
 * in a single operational step to bypass background automation delays.
 * 
 * Creates Google Drive folder structure for each project
 * Writes all three Flex UUIDs (Event Folder, Quote, Equipment List) at creation time
 * 
 * Workflow:
 * 1. Safely queries Flex via GET /api/search layout guidelines
 * 2. Classifies search results to extract all three UUIDs (Event Folder, Quote, Equip List)
 * 3. Fetches field parameters using precise comma-separated codeList entries
 * 4. Extracts clean contact UUID strings, filtering out literal key titles
 * 5. Resolves human-readable text identities via /api/contact/{uuid}/identity
 * 6. Matches names against the monday Contacts board and links relations inline
 * 7. SEARCHES for existing project by Flex number to prevent duplicates
 * 8. Updates existing project OR creates new one atomically
 * 9. Creates Google Drive folder structure from template
 * 
 * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const PROJECTS_BOARD_ID = '18415679761';
const CONTACTS_BOARD_ID = '18415573401';

const GOOGLE_APPS_SCRIPT_URL     = process.env.GOOGLE_APPS_SCRIPT_URL   || null;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_2 || process.env.GOOGLE_SERVICE_ACCOUNT_KEY || null; // JSON string of service account credentials
const FLEX_EVENT_DEFINITION_ID   = process.env.FLEX_EVENT_DEFINITION_ID || null;

// Cached definitionId for Flex event folder lookup (populated on first call)
let _cachedDefinitionId = FLEX_EVENT_DEFINITION_ID;

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
// HELPER: Find contact in monday Contacts board
// Primary:  match by Flex Contact UUID (text_mm56w1vz) — exact, instant
// Fallback: full-text name search — for contacts not yet synced from Flex
// ================================================================
async function findContactByFlexUuid(flexUuid, nameFallback) {
    // Primary: UUID match via Flex Contact ID column
    if (flexUuid) {
        try {
            const response = await fetch(MONDAY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                body: JSON.stringify({ query: `query { items_page_by_column_values(limit: 5, board_id: ${CONTACTS_BOARD_ID}, columns: [{ column_id: "text_mm56w1vz", column_values: ["${flexUuid}"] }]) { items { id name } } }` })
            });
            const result = await response.json();
            const items = result.data?.items_page_by_column_values?.items || [];
            if (items.length > 0) {
                console.log(`✅ Contact matched by Flex UUID: "${items[0].name}" (${flexUuid})`);
                return items[0].id;
            }
        } catch (e) {
            console.warn(`⚠️ UUID contact lookup failed for ${flexUuid}:`, e.message);
        }
    }

    // Fallback: name search (contacts not yet synced from Flex)
    if (!nameFallback || nameFallback.trim() === '' || nameFallback.includes('Unknown')) return null;
    const safeName = nameFallback.trim();
    console.log(`🔍 UUID miss — falling back to name search for: "${safeName}"`);
    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query: `query { boards(ids: [${CONTACTS_BOARD_ID}]) { items_page(limit: 50, query_params: { term: "${safeName.replace(/"/g, '\\"')}" }) { items { id name } } } }` })
        });
        const result = await response.json();
        const items = result.data?.boards?.[0]?.items_page?.items || [];
        const exactMatch = items.find(item => item.name.trim().toLowerCase() === safeName.toLowerCase());
        if (exactMatch) {
            console.log(`✅ Contact matched by name fallback: "${exactMatch.name}"`);
            return exactMatch.id;
        }
    } catch (e) {
        console.error(`❌ Name fallback contact lookup failed:`, e);
    }
    return null;
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
// HELPER: Get a short-lived Google OAuth2 access token from a
// service account JSON key using the JWT Bearer flow.
// No external libraries — pure fetch + built-in crypto.
// ================================================================
async function getGoogleAccessToken() {
    if (!GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
    const key     = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const scope   = 'https://www.googleapis.com/auth/drive';
    const now     = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim   = Buffer.from(JSON.stringify({
        iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600, iat: now,
    })).toString('base64url');

    // Sign with RS256 using the service account private key
    const { createSign } = await import('node:crypto');
    const sign    = createSign('RSA-SHA256');
    sign.update(`${header}.${claim}`);
    const sig     = sign.sign(key.private_key, 'base64url');
    const jwt     = `${header}.${claim}.${sig}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    return tokenData.access_token;
}

// ================================================================
// HELPER: Recursively copies all files and subfolders from a Drive
// source folder into a destination folder — mirrors GAS copyFolderContents.
// Siblings are processed in parallel (Promise.all) for speed.
// ================================================================
async function _copyDriveFolderContents(sourceFolderId, destFolderId, authHeaders) {
    const BASE = 'https://www.googleapis.com/drive/v3';

    // List all direct children of source (files + subfolders)
    const q   = encodeURIComponent(`'${sourceFolderId}' in parents and trashed = false`);
    const listRes = await fetch(
        `${BASE}/files?q=${q}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`,
        { headers: authHeaders }
    );
    const { files = [] } = await listRes.json();

    await Promise.all(files.map(async child => {
        if (child.mimeType === 'application/vnd.google-apps.folder') {
            // Create matching subfolder, then recurse
            const subRes = await fetch(`${BASE}/files?supportsAllDrives=true&fields=id`, {
                method:  'POST',
                headers: authHeaders,
                body:    JSON.stringify({
                    name:     child.name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents:  [destFolderId],
                }),
            });
            const sub = await subRes.json();
            if (sub.id) {
                console.log(`  📁 Created subfolder: ${child.name}`);
                await _copyDriveFolderContents(child.id, sub.id, authHeaders);
            }
        } else {
            // Copy file into destination
            await fetch(`${BASE}/files/${child.id}/copy?supportsAllDrives=true`, {
                method:  'POST',
                headers: authHeaders,
                body:    JSON.stringify({ name: child.name, parents: [destFolderId] }),
            });
            console.log(`  📄 Copied file: ${child.name}`);
        }
    }));
}

// ================================================================
// HELPER: Create Google Drive folder structure for project.
// Mirrors GAS duplicateFolderTree exactly:
//   - copies template folder (1tj247t4cSc4GjAbhdylmjcDhzpgmEuY8) recursively
//   - places result in parent folder (0AAdFvqzEGrPzUk9PVA)
//   - names root folder exactly projectName (same as GAS)
//   - shares with PM as writer
//
// Primary:  direct Drive REST API v3 via service account (faster, no cold-start delay)
// Fallback: Google Apps Script URL if GOOGLE_SERVICE_ACCOUNT_KEY not set
// ================================================================
async function createProjectFolder(projectName, projectId, clientName, eventDate, pmEmail) {
    const TEMPLATE_FOLDER_ID = '1tj247t4cSc4GjAbhdylmjcDhzpgmEuY8';
    const PARENT_FOLDER_ID   = '0AAdFvqzEGrPzUk9PVA';
    const BASE               = 'https://www.googleapis.com/drive/v3';

    // ── Primary path: direct Drive API (fast, no GAS cold start) ──────────
    if (GOOGLE_SERVICE_ACCOUNT_KEY) {
        try {
            console.log(`📁 Creating Google Drive folder for: ${projectName} (direct API)`);
            const token   = await getGoogleAccessToken();
            const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

            // Create root folder named exactly projectName, same as GAS
            const rootRes = await fetch(`${BASE}/files?supportsAllDrives=true&fields=id,webViewLink`, {
                method:  'POST',
                headers,
                body:    JSON.stringify({
                    name:     projectName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents:  [PARENT_FOLDER_ID],
                }),
            });
            const rootFolder = await rootRes.json();
            if (!rootFolder.id) throw new Error(`Drive create root folder failed: ${JSON.stringify(rootFolder)}`);
            console.log(`  📂 Created root folder: ${projectName}`);

            // Recursively copy template tree into new root folder
            await _copyDriveFolderContents(TEMPLATE_FOLDER_ID, rootFolder.id, headers);

            // Share with PM (writer access), same as GAS shareWithUser
            if (pmEmail) {
                await fetch(`${BASE}/files/${rootFolder.id}/permissions?supportsAllDrives=true`, {
                    method:  'POST',
                    headers,
                    body:    JSON.stringify({ type: 'user', role: 'writer', emailAddress: pmEmail }),
                }).catch(e => console.warn(`⚠️ Could not share Drive folder with PM: ${e.message}`));
                console.log(`  ✅ Shared folder with PM: ${pmEmail}`);
            }

            const folderUrl = rootFolder.webViewLink || `https://drive.google.com/drive/folders/${rootFolder.id}`;
            console.log(`✅ Google Drive folder created: ${folderUrl}`);
            return { success: true, folderId: rootFolder.id, folderUrl, folderName: projectName };

        } catch (e) {
            console.error(`❌ Drive API error: ${e.message}`);
            // Fall through to GAS fallback
        }
    }

    // ── Fallback path: Google Apps Script (slower, may timeout on cold start) ─────
    if (!GOOGLE_APPS_SCRIPT_URL) {
        console.log(`⚠️ No Drive credentials configured — skipping folder creation`);
        return null;
    }

    try {
        console.log(`📁 Creating Google Drive folder for: ${projectName} (GAS fallback)`);
        const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ projectName, projectId, clientName, eventDate, pmEmail }),
        });
        const result = await response.json();
        if (result.success) {
            console.log(`✅ Google Drive folder created: ${result.folderUrl}`);
            return result;
        }
        console.error(`❌ GAS folder creation failed: ${result.error}`);
        return null;
    } catch (e) {
        console.error(`❌ Google Drive API error:`, e);
        return null;
    }
}

// ================================================================
// HELPER: Resolve Flex "Event Folder" definitionId
// Calls GET /api/element-definition/enabled-definitions once, caches result.
// Set FLEX_EVENT_DEFINITION_ID env var to skip the lookup entirely.
// ================================================================
async function resolveEventFolderDefinitionId() {
    if (_cachedDefinitionId) return _cachedDefinitionId;

    console.log('[create-folder] 🔍 Looking up event folder definition ID...');
    const res = await fetch(`${FLEX_BASE_URL}/api/element-definition/enabled-definitions`, {
        headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`Flex element-definition lookup failed: HTTP ${res.status}`);
    const defs = await res.json();

    if (!Array.isArray(defs) || defs.length === 0) {
        throw new Error('No element definitions returned from Flex. Check FLEX_API_KEY.');
    }

    console.log('[create-folder] Available definitions:');
    for (const d of defs) {
        console.log(`  id=${d.id}  code=${d.code}  name="${d.name}"  namePlural="${d.namePlural}"`);
    }

    const EXCLUDE = ['quote', 'equipment', 'crew', 'expense', 'task', 'session', 'manifest'];
    const PREFER  = ['event', 'project', 'folder', 'show'];
    const candidates = defs.filter(d => {
        const h = `${d.name} ${d.namePlural} ${d.code}`.toLowerCase();
        return PREFER.some(x => h.includes(x)) && !EXCLUDE.some(x => h.includes(x));
    });

    const chosen = candidates[0] || defs[0];
    _cachedDefinitionId = chosen.id;
    console.log(`[create-folder] ✅ Using definition: id=${chosen.id} name="${chosen.name}"`);
    console.log(`[create-folder] 💡 Set FLEX_EVENT_DEFINITION_ID=${chosen.id} to skip this lookup`);
    return _cachedDefinitionId;
}

// ================================================================
// ACTION HANDLER: ?action=create-folder
// Creates a Flex event folder + Google Drive folder structure.
// Called by the Vibe "Project Setup" app BEFORE a full project exists.
//
// POST /api/create-project-from-quote?action=create-folder
// Body: { projectName, eventDate, clientName?, pmEmail? }
// Response: { ok, flexEventFolderId, flexElementNumber, flexElementName,
//             clientLinked, clientFlexId, driveFolder }
// ================================================================
async function handleCreateFolder(req, res) {
    const { projectName, eventDate, prepDate, returnDate, clientName, pmEmail } = req.body || {};

    if (!projectName?.trim()) {
        return res.status(400).json({ error: 'projectName is required' });
    }
    if (!eventDate?.trim()) {
        return res.status(400).json({ error: 'eventDate is required (YYYY-MM-DD)' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate.trim())) {
        return res.status(400).json({ error: 'eventDate must be YYYY-MM-DD format' });
    }
    if (prepDate && !/^\d{4}-\d{2}-\d{2}$/.test(prepDate.trim())) {
        return res.status(400).json({ error: 'prepDate must be YYYY-MM-DD format' });
    }
    if (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate.trim())) {
        return res.status(400).json({ error: 'returnDate must be YYYY-MM-DD format' });
    }

    console.log(`\n🚀 create-folder | "${projectName}" | event: ${eventDate} | prep: ${prepDate || 'none'} | return: ${returnDate || 'none'} | client: ${clientName || 'none'} | pm: ${pmEmail || 'none'}`);

    // ── Resolve definitionId + client UUID in parallel ─────────────────────
    const [definitionId, clientUUID] = await Promise.all([
        resolveEventFolderDefinitionId(),
        clientName?.trim() ? resolveClientUUIDByName(clientName.trim()) : Promise.resolve(null),
    ]);

    // ── Build Flex payload — dates must be ISO date-time ───────────────────
    const toFlexDT = (d, hour = 9) => d ? `${d.trim()}T${String(hour).padStart(2, '0')}:00:00.000Z` : null;
    const payload = {
        definitionId,
        name:             projectName.trim(),
        open:             true,
        statusId:         'ddde5e2c-aee7-11df-b8d5-00e08175e43e', // "Inquiry" — matches Flex UI default
        locationId:       '2f49c62c-b139-11df-b8d5-00e08175e43e', // "ANTIC HQ" — required for upcoming schedule visibility
        eventDate:        toFlexDT(eventDate, 9),
        plannedStartDate: toFlexDT(prepDate || eventDate, 9),
        plannedEndDate:   toFlexDT(returnDate || eventDate, 17),
    };
    if (clientUUID) payload.clientId = clientUUID;

    // ── POST to Flex /api/element ──────────────────────────────────────────
    console.log(`[create-folder] 📤 POSTing to Flex /api/element`);
    const flexRes = await fetch(`${FLEX_BASE_URL}/api/element`, {
        method: 'POST',
        headers: {
            'X-Auth-Token': FLEX_API_KEY,
            'Accept':       'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    const flexText = await flexRes.text();
    if (!flexRes.ok) throw new Error(`Flex POST /api/element → HTTP ${flexRes.status}: ${flexText}`);
    const flexData = JSON.parse(flexText);

    // Response is ElementKeyInfo — primary key is elementId
    const elementId     = flexData?.elementId;
    const elementNumber = flexData?.elementNumber || null;
    const elementName   = flexData?.elementName   || projectName.trim();

    if (!elementId) throw new Error(`Flex returned no elementId. Response: ${flexText}`);
    console.log(`[create-folder] ✅ Flex element created: ${elementId} (${elementNumber})`);

    // ── Create Google Drive folder (non-fatal) ─────────────────────────────
    let driveFolder = null;
    try {
        driveFolder = await createProjectFolder(projectName.trim(), elementId, clientName || '', eventDate.trim(), pmEmail || '');
    } catch (driveErr) {
        console.warn(`[create-folder] ⚠️ Drive folder skipped: ${driveErr.message}`);
    }

    return res.status(200).json({
        ok:                true,
        flexEventFolderId: elementId,
        flexElementNumber: elementNumber,
        flexElementName:   elementName,
        clientLinked:      !!clientUUID,
        clientFlexId:      clientUUID || null,
        driveFolder:       driveFolder || null,
    });
}

// ================================================================
// HELPER: Resolve client name → Flex contact UUID
// Uses GET /api/contact/search (PageContactSearchEntry response)
// ================================================================
async function resolveClientUUIDByName(clientName) {
    try {
        const encoded = encodeURIComponent(clientName);
        const res = await fetch(`${FLEX_BASE_URL}/api/contact/search?searchText=${encoded}&size=5`, {
            headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' }
        });
        if (!res.ok) return null;
        const data    = await res.json();
        const results = data?.content || [];
        if (!results.length) return null;
        const exact = results.find(c => c.name?.trim().toLowerCase() === clientName.toLowerCase());
        const match = exact || results[0];
        console.log(`[create-folder] ✅ Client resolved: "${match.name}" → ${match.id}`);
        return match.id || null;
    } catch (err) {
        console.warn(`[create-folder] ⚠️ Client lookup failed: ${err.message}`);
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

    // ── Route: ?action=create-folder ──────────────────────────────────────────
    if (req.query?.action === 'create-folder') {
        try {
            return await handleCreateFolder(req, res);
        } catch (err) {
            console.error('[create-folder] ❌ Error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

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
        const dataUrl = `${FLEX_BASE_URL}/api/element/${internalId}/header-data?codeList=elementNumber,name,clientId,venueId,personResponsibleId,personResponsibleDefaultEmailAddress,eventDate,plannedStartDate,plannedEndDate,totalPrice,notes,equipmentList`;
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
        const personResponsibleEmail  = data?.personResponsibleDefaultEmailAddress?.data || null;

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


        // ===== STEP 5: Scan monday registry + duplicate check =====
        const [matchedClientId, matchedVenueId, existingProjectId] = await Promise.all([
            findContactByFlexUuid(clientUuid, clientResolvedName),
            findContactByFlexUuid(venueUuid,  venueResolvedName),
            findExistingProjectByFlexNumber(quoteNumber)
        ]);

        // ===== STEP 6: Build the unified row mapping data frame object =====
        const columnValues = {
            text_mm3x2yr6:             quoteNumber,
            numeric_mm3xzncg:          totalEstimate,
            long_text_mm3xfve1:        notesText,
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
