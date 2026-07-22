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
 * 7. SEARCHES for existing project by Flex QUOTE NUMBER to prevent duplicates
 * 8. Updates existing project OR creates new one — keyed by quote, NOT event folder
 * 9. Drive folder creation is handled by ?action=create-folder (called from Vibe app)
 *
 * Architecture:
 *   Projects are ONLY created from quotes. One quote = one project.
 *   Multiple quotes can share the same event folder UUID (same event, different scopes).
 *   ?action=create-folder creates the Flex event folder + Google Drive folder structure,
 *   then propagates dates/Drive link to any quote-based projects that already exist.
 * 
 * Author: Matt James, Antic Studios
 */

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

const PROJECTS_BOARD_ID        = '18415679761';
const CONTACTS_BOARD_ID        = '18415573401';
const EVENT_FOLDER_REGISTRY_ID = '18423176877'; // 📁 Event Folder Registry board

// Registry column IDs (📁 Event Folder Registry board — 18423176877)
const REG_COL_UUID   = 'text_mm5f4g7g';  // Flex Event Folder UUID
const REG_COL_DRIVE  = 'link_mm5fz1b3';  // Google Drive Folder link
const REG_COL_STATUS = 'color_mm5fp4w3'; // Folder Status
const REG_COL_VENUE  = 'board_relation_mm5gaek9'; // Venue board relation → Contacts & Companies
const REG_GROUP_ACTIVE = 'group_mm5fc60c'; // Active Events group

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

    // Fallback: name match via items_page_by_column_values on the name column.
    // More reliable than full-text search (query_params term) which can miss exact
    // company names depending on monday's search indexing.
    if (!nameFallback || nameFallback.trim() === '' || nameFallback.includes('Unknown')) return null;
    const safeName = nameFallback.trim();
    console.log(`🔍 UUID miss — falling back to name lookup for: "${safeName}"`);
    try {
        const response = await fetch(MONDAY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body: JSON.stringify({ query: `query { items_page_by_column_values(limit: 5, board_id: ${CONTACTS_BOARD_ID}, columns: [{ column_id: "name", column_values: ["${safeName.replace(/"/g, '\\"')}"] }]) { items { id name } } }` })
        });
        const result = await response.json();
        const items = result.data?.items_page_by_column_values?.items || [];
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
// HELPER: Look up an event folder in the Event Folder Registry board
// by its Flex Event Folder UUID.
// Returns { itemId, driveUrl, driveFolderName } if found, null otherwise.
// ================================================================
async function findRegistryEntry(flexEventFolderUUID) {
    if (!flexEventFolderUUID) return null;
    try {
        const query = `query {
            items_page_by_column_values(
                limit: 5,
                board_id: ${EVENT_FOLDER_REGISTRY_ID},
                columns: [{ column_id: "${REG_COL_UUID}", column_values: ["${flexEventFolderUUID}"] }]
            ) {
                items {
                    id
                    name
                    column_values(ids: ["${REG_COL_DRIVE}"]) { id text value }
                }
            }
        }`;
        const res  = await fetch(MONDAY_API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body:    JSON.stringify({ query }),
        });
        const data = await res.json();
        const items = data?.data?.items_page_by_column_values?.items || [];
        if (items.length === 0) return null;

        const item     = items[0];
        const driveCol = item.column_values?.find(c => c.id === REG_COL_DRIVE);
        let driveUrl   = null;
        if (driveCol?.value) {
            try { driveUrl = JSON.parse(driveCol.value)?.url || driveCol.text || null; } catch { driveUrl = driveCol.text || null; }
        }
        console.log(`[registry] ✅ Found entry for UUID ${flexEventFolderUUID}: "${item.name}" | drive: ${driveUrl || 'no link yet'}`);
        return { itemId: item.id, driveUrl, driveFolderName: item.name };
    } catch (e) {
        console.warn(`[registry] ⚠️ Lookup failed for ${flexEventFolderUUID}: ${e.message}`);
        return null;
    }
}

// ================================================================
// HELPER: Write (create or update) an entry in the Event Folder
// Registry board. Pass itemId to update an existing row, or null
// to create a new one.
// ================================================================
async function writeRegistryEntry({ itemId, eventName, flexEventFolderUUID, driveUrl, mondayVenueId }) {
    const colValues = {
        [REG_COL_UUID]:   flexEventFolderUUID || '',
        [REG_COL_STATUS]: { label: driveUrl ? 'Active' : 'No Drive Folder' },
    };
    if (driveUrl)      colValues[REG_COL_DRIVE] = { url: driveUrl, text: 'Google Drive Folder' };
    if (mondayVenueId) colValues[REG_COL_VENUE] = { item_ids: [parseInt(mondayVenueId, 10)] };

    try {
        if (itemId) {
            // Update existing row
            const mutation = `mutation {
                change_multiple_column_values(
                    board_id:      ${EVENT_FOLDER_REGISTRY_ID},
                    item_id:       ${itemId},
                    column_values: ${JSON.stringify(JSON.stringify(colValues))}
                ) { id }
            }`;
            const res  = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query: mutation }) });
            const data = await res.json();
            if (data.errors) throw new Error(JSON.stringify(data.errors));
            console.log(`[registry] ✅ Updated entry ${itemId} for "${eventName}"`);
            return itemId;
        } else {
            // Create new row
            const mutation = `mutation {
                create_item(
                    board_id:      ${EVENT_FOLDER_REGISTRY_ID},
                    group_id:      "${REG_GROUP_ACTIVE}",
                    item_name:     ${JSON.stringify(eventName || 'Unnamed Event')},
                    column_values: ${JSON.stringify(JSON.stringify(colValues))}
                ) { id }
            }`;
            const res  = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query: mutation }) });
            const data = await res.json();
            if (data.errors) throw new Error(JSON.stringify(data.errors));
            const newId = data?.data?.create_item?.id;
            console.log(`[registry] ✅ Created registry entry ${newId} for "${eventName}"`);
            return newId;
        }
    } catch (e) {
        console.warn(`[registry] ⚠️ Write failed for "${eventName}": ${e.message}`);
        return null;
    }
}

// ================================================================
// HELPER: Search Google Drive for an existing folder by exact name
// within a specific parent folder.
// Returns { id, name, webViewLink } if found, null otherwise.
// ================================================================
async function findExistingDriveFolder(folderName, parentFolderId, authHeaders) {
    const BASE = 'https://www.googleapis.com/drive/v3';
    // Escape single quotes in folder name for the Drive query
    const safeName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(
        `name = '${safeName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    try {
        const res = await fetch(
            `${BASE}/files?q=${q}&fields=files(id,name,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
            { headers: authHeaders }
        );
        const data = await res.json();
        const files = data.files || [];
        if (files.length > 0) {
            console.log(`  🔍 Existing Drive folder found: "${files[0].name}" (${files[0].id})`);
            return files[0];
        }
    } catch (e) {
        console.warn(`⚠️ Drive folder search failed: ${e.message}`);
    }
    return null;
}

// ================================================================
// HELPER: Create Google Drive folder structure for project.
// Mirrors GAS duplicateFolderTree exactly:
//   - copies template folder (1tj247t4cSc4GjAbhdylmjcDhzpgmEuY8) recursively
//   - places result in parent folder (0AAdFvqzEGrPzUk9PVA)
//   - names root folder exactly projectName (same as GAS)
//   - shares with PM as writer
//
// IDEMPOTENT: Checks for an existing folder with the same name in the
// parent before creating. If found, returns the existing folder and
// skips all creation — prevents duplicate Drive folders.
//
// Primary:  direct Drive REST API v3 via service account (faster, no cold-start delay)
// Fallback: Google Apps Script URL if GOOGLE_SERVICE_ACCOUNT_KEY not set
// ================================================================
async function createProjectFolder(projectName, projectId, clientName, pmEmail) {
    const TEMPLATE_FOLDER_ID = '1tj247t4cSc4GjAbhdylmjcDhzpgmEuY8';
    const PARENT_FOLDER_ID   = '0AAdFvqzEGrPzUk9PVA';
    const BASE               = 'https://www.googleapis.com/drive/v3';

    // ── Primary path: direct Drive API (fast, no GAS cold start) ──────────
    if (GOOGLE_SERVICE_ACCOUNT_KEY) {
        try {
            console.log(`📁 Creating Google Drive folder for: ${projectName} (direct API)`);
            const token   = await getGoogleAccessToken();
            const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

            // ── IDEMPOTENCY CHECK: return existing folder if it already exists ──
            const existing = await findExistingDriveFolder(projectName, PARENT_FOLDER_ID, headers);
            if (existing) {
                const folderUrl = existing.webViewLink || `https://drive.google.com/drive/folders/${existing.id}`;
                console.log(`✅ Reusing existing Google Drive folder: ${folderUrl}`);
                return { success: true, folderId: existing.id, folderUrl, folderName: projectName, existing: true };
            }

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
// Body: { projectName, prepDate?, returnDate?, clientName?, venueName?, pmEmail? }
// Response: { ok, flexEventFolderId, flexElementNumber, flexElementName,
//             clientLinked, clientFlexId, driveFolder }
// ================================================================
async function handleCreateFolder(req, res) {
    const { projectName, prepDate, returnDate, clientName, venueName, pmEmail } = req.body || {};

    if (!projectName?.trim()) {
        return res.status(400).json({ error: 'projectName is required' });
    }
    if (prepDate && !/^\d{4}-\d{2}-\d{2}$/.test(prepDate.trim())) {
        return res.status(400).json({ error: 'prepDate must be YYYY-MM-DD format' });
    }
    if (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate.trim())) {
        return res.status(400).json({ error: 'returnDate must be YYYY-MM-DD format' });
    }

    console.log(`\n🚀 create-folder | "${projectName}" | prep: ${prepDate || 'none'} | return: ${returnDate || 'none'} | client: ${clientName || 'none'} | venue: ${venueName || 'none'} | pm: ${pmEmail || 'none'}`);

    // ── Resolve definitionId + client UUID + venue UUID in parallel ──────────
    const [definitionId, clientUUID, venueUUID] = await Promise.all([
        resolveEventFolderDefinitionId(),
        clientName?.trim() ? resolveClientUUIDByName(clientName.trim()) : Promise.resolve(null),
        venueName?.trim()  ? resolveClientUUIDByName(venueName.trim())  : Promise.resolve(null),
    ]);

    // ── Build Flex payload — dates must be ISO date-time ───────────────────
    const toFlexDT = (d, hour = 9) => d ? `${d.trim()}T${String(hour).padStart(2, '0')}:00:00.000Z` : null;
    const payload = {
        definitionId,
        name:             projectName.trim(),
        open:             true,
        statusId:         'ddde5e2c-aee7-11df-b8d5-00e08175e43e', // "Inquiry" — matches Flex UI default
        locationId:       '2f49c62c-b139-11df-b8d5-00e08175e43e', // "ANTIC HQ" — required for upcoming schedule visibility
        ...(prepDate   && { plannedStartDate: toFlexDT(prepDate,   9)  }),
        ...(returnDate && { plannedEndDate:   toFlexDT(returnDate, 17) }),
    };
    if (clientUUID) payload.clientId = clientUUID;
    if (venueUUID)  payload.venueId  = venueUUID;

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

    // ── Check Event Folder Registry before touching Drive ─────────────────
    // If a registry entry already has a Drive link, reuse it entirely.
    let driveFolder    = null;
    let registryItemId = null;
    const existingEntry = await findRegistryEntry(elementId);

    if (existingEntry?.driveUrl) {
        // Already in registry with a Drive link — skip creation entirely
        console.log(`[create-folder] 📋 Registry hit — reusing existing Drive folder: ${existingEntry.driveUrl}`);
        driveFolder    = { success: true, folderUrl: existingEntry.driveUrl, folderName: existingEntry.driveFolderName, existing: true };
        registryItemId = existingEntry.itemId;
    } else {
        // Not in registry (or no Drive link yet) — create the Drive folder
        try {
            driveFolder = await createProjectFolder(projectName.trim(), elementId, clientName || '', pmEmail || '');
        } catch (driveErr) {
            console.warn(`[create-folder] ⚠️ Drive folder skipped: ${driveErr.message}`);
        }

        // Write to registry (create or update) — non-fatal
        try {
            registryItemId = await writeRegistryEntry({
                itemId:              existingEntry?.itemId || null, // update if partial entry existed
                eventName:           elementName,
                flexEventFolderUUID: elementId,
                driveUrl:            driveFolder?.folderUrl || null,
                mondayVenueId:       mondayVenueId || null,
            });
        } catch (regErr) {
            console.warn(`[create-folder] ⚠️ Registry write skipped: ${regErr.message}`);
        }
    }

    // ── Resolve venue to a Monday Contacts board item ID ─────────────────────────
    // Declared at outer scope so registry write + propagation both have access.
    let mondayVenueId = null;
    if (venueUUID || venueName?.trim()) {
        mondayVenueId = await findContactByFlexUuid(venueUUID, venueName?.trim() || null);
        if (mondayVenueId) console.log(`[create-folder] ✅ Venue resolved to monday contact: ${mondayVenueId}`);
        else               console.log(`[create-folder] ⚠️ Venue not found in Contacts board — relation will be empty`);
    }

    // ── Propagate event dates + Drive link to any existing quote-based projects ──
    // Projects are ONLY created by the quote sync handler (POST with quoteNumber).
    // create-folder does NOT create stub projects. If one or more projects already
    // exist for this event folder UUID (quotes were synced first, or this is a
    // re-run), push the dates and Drive link onto ALL of them.
    //
    // Multiple quotes can share the same event folder (two separate projects at the
    // same event) — so we update ALL matches, not just the first.
    try {
        const dateColumnValues = {
            text_mm466djv: elementId,   // Flex Event Folder UUID
            ...(prepDate   && { date_mm4at0qc: { date: prepDate.trim()   } }),
            ...(returnDate && { date_mm4a7fn6: { date: returnDate.trim() } }),
            ...(driveFolder?.folderUrl && { link_mm5fa4b8: { url: driveFolder.folderUrl, text: 'Google Drive Folder' } }),
            ...(mondayVenueId && { board_relation_mm3xrm02: { item_ids: [parseInt(mondayVenueId, 10)] } }),
        };

        // Find ALL projects that already share this event folder UUID
        const existingProjects = await (async () => {
            const q = `query {
                items_page_by_column_values(
                    limit: 10,
                    board_id: ${PROJECTS_BOARD_ID},
                    columns: [{ column_id: "text_mm466djv", column_values: ["${elementId}"] }]
                ) { items { id name } }
            }`;
            const r    = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query: q }) });
            const data = await r.json();
            return data?.data?.items_page_by_column_values?.items || [];
        })();

        if (existingProjects.length > 0) {
            // Update ALL matching projects — each quote is its own project but they share this event folder
            await Promise.all(existingProjects.map(async (proj) => {
                const mut = `mutation {
                    change_multiple_column_values(
                        board_id:      ${PROJECTS_BOARD_ID},
                        item_id:       ${proj.id},
                        column_values: ${JSON.stringify(JSON.stringify(dateColumnValues))}
                    ) { id }
                }`;
                await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query: mut }) });
                console.log(`[create-folder] ✅ Updated dates on project "${proj.name}" (${proj.id})`);
            }));
            console.log(`[create-folder] ✅ Propagated dates/Drive link to ${existingProjects.length} project(s) for event folder ${elementId}`);
        } else {
            console.log(`[create-folder] ℹ️ No existing projects for event folder ${elementId} — dates will be applied when quotes sync`);
        }
    } catch (mondayErr) {
        console.warn(`[create-folder] ⚠️ monday date propagation skipped: ${mondayErr.message}`);
    }

    return res.status(200).json({
        ok:                true,
        flexEventFolderId: elementId,
        flexElementNumber: elementNumber,
        flexElementName:   elementName,
        prepDate:          prepDate?.trim()   || null,
        returnDate:        returnDate?.trim()  || null,
        clientLinked:      !!clientUUID,
        clientFlexId:      clientUUID || null,
        venueLinked:       !!mondayVenueId,
        venueFlexId:       venueUUID || null,
        venueMondayId:     mondayVenueId || null,
        driveFolder:       driveFolder || null,
        registryItemId:    registryItemId || null,
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
    // audit-drive-folders is GET; all other actions are POST
    if (req.query?.action !== 'audit-drive-folders' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Route: ?action=create-folder ──────────────────────────────────────────
    if (req.query?.action === 'create-folder') {
        try {
            return await handleCreateFolder(req, res);
        } catch (err) {
            console.error('[create-folder] ❌ Error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // ── Route: ?action=sync-budget ────────────────────────────────────────────
    // Fast, targeted budget sync for the Vibe app to call after a quote is created
    // or repriced in Flex. No Flex search needed — uses UUIDs directly.
    //
    // POST /api/create-project-from-quote?action=sync-budget
    // Body: { mondayItemId, quoteUUID }
    //   mondayItemId — Projects board item ID to update
    //   quoteUUID    — Flex financial document / quote UUID (text_mm4cwasc)
    //
    // Returns: { ok, itemId, budget }
    if (req.query?.action === 'sync-budget') {
        try {
            const { mondayItemId, quoteUUID } = req.body || {};

            if (!mondayItemId) return res.status(400).json({ ok: false, error: 'mondayItemId is required' });
            if (!quoteUUID)    return res.status(400).json({ ok: false, error: 'quoteUUID is required' });

            console.log(`\n💰 sync-budget | item: ${mondayItemId} | quote: ${quoteUUID}`);

            // Fetch only totalPrice from Flex header-data — fast, single field
            const hdRes = await fetch(
                `${FLEX_BASE_URL}/api/element/${quoteUUID}/header-data?codeList=totalPrice`,
                { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' } }
            );
            if (!hdRes.ok) throw new Error(`Flex header-data returned HTTP ${hdRes.status}`);
            const hd = await hdRes.json();

            const budget = extractFlexNumericValue(hd?.totalPrice);
            console.log(`[sync-budget] 💵 totalPrice from Flex: ${budget}`);

            // Write to Estimated Budget column on the Projects board
            const mutation = `mutation {
                change_column_value(
                    board_id:  ${PROJECTS_BOARD_ID},
                    item_id:   ${mondayItemId},
                    column_id: "numeric_mm3xzncg",
                    value:     ${JSON.stringify(String(budget))}
                ) { id }
            }`;

            const mutRes = await fetch(MONDAY_API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                body:    JSON.stringify({ query: mutation })
            });
            const mutData = await mutRes.json();
            if (mutData.errors) throw new Error(`monday mutation failed: ${JSON.stringify(mutData.errors)}`);

            console.log(`[sync-budget] ✅ Estimated Budget updated → $${budget} on item ${mondayItemId}`);
            return res.status(200).json({ ok: true, itemId: mondayItemId, budget });

        } catch (err) {
            console.error('[sync-budget] ❌ Error:', err.message);
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // ── Route: ?action=audit-drive-folders ───────────────────────────────────
    // Audits all Projects board items — checks whether a matching Google Drive
    // folder exists for each project and optionally writes back the URL.
    //
    // GET /api/create-project-from-quote?action=audit-drive-folders
    //   ?fix=true&dryRun=false  → write found Drive URLs to the Google Drive Folder column
    //   ?group=<group_id>       → scope to one board group
    //   ?dryRun=true (default)  → report only, no writes
    //
    // Returns: { ok, mode, summary, results[] }
    if (req.query?.action === 'audit-drive-folders') {
        const fix         = req.query?.fix     === 'true';
        const dryRun      = req.query?.dryRun  !== 'false'; // safe default
        const groupFilter = req.query?.group   || null;
        const shouldWrite = fix && !dryRun;
        const DRIVE_URL_COL    = 'link_mm5fa4b8';  // "Google Drive Folder" link column on Projects board
        const AUDIT_PARENT_ID  = '0AAdFvqzEGrPzUk9PVA';
        const AUDIT_BASE       = 'https://www.googleapis.com/drive/v3';

        console.log(`\n🔍 Drive Folder Audit | fix=${fix} | dryRun=${dryRun} | group=${groupFilter || 'all'}`);

        try {
            if (!GOOGLE_SERVICE_ACCOUNT_KEY) {
                return res.status(500).json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_KEY not configured' });
            }
            const auditToken      = await getGoogleAccessToken();
            const auditAuthHeaders = { Authorization: `Bearer ${auditToken}`, 'Content-Type': 'application/json' };

            // ── Fetch all projects from monday ────────────────────────────────
            const auditProjects = [];
            let auditCursor     = null;
            do {
                const cursorClause = auditCursor ? `, cursor: "${auditCursor}"` : '';
                const groupClause  = groupFilter  ? `(ids: ["${groupFilter}"])` : '';
                const auditQuery   = `query {
                    boards(ids: [${PROJECTS_BOARD_ID}]) {
                        groups ${groupClause} {
                            id title
                            items_page(limit: 100${cursorClause}) {
                                cursor
                                items {
                                    id name
                                    column_values(ids: ["text_mm3x2yr6", "${DRIVE_URL_COL}"]) { id text }
                                }
                            }
                        }
                    }
                }`;
                const auditRes  = await fetch(MONDAY_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
                    body:   JSON.stringify({ query: auditQuery }),
                });
                const auditData = await auditRes.json();
                if (auditData.errors) throw new Error(`monday API: ${JSON.stringify(auditData.errors)}`);
                const groups = auditData?.data?.boards?.[0]?.groups || [];
                auditCursor  = null;
                for (const group of groups) {
                    const page = group.items_page;
                    auditCursor = page?.cursor || null;
                    for (const item of (page?.items || [])) {
                        const flexCol  = item.column_values?.find(c => c.id === 'text_mm3x2yr6');
                        const driveCol = item.column_values?.find(c => c.id === DRIVE_URL_COL);
                        auditProjects.push({
                            id:            item.id,
                            name:          item.name,
                            flexProjectNum: flexCol?.text?.trim()  || null,
                            mondayDriveUrl: driveCol?.text?.trim() || null,
                            group:         group.title,
                        });
                    }
                }
            } while (auditCursor);

            console.log(`[audit] Found ${auditProjects.length} projects to check`);

            // ── Search Drive for each project (5 at a time) ───────────────────
            const auditResults = [];
            const BATCH        = 5;
            for (let i = 0; i < auditProjects.length; i += BATCH) {
                const batch = auditProjects.slice(i, i + BATCH);
                const batchRes = await Promise.all(batch.map(async proj => {
                    console.log(`  🔍 "${proj.name}"`);
                    try {
                        const safeName = proj.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                        const q = encodeURIComponent(
                            `name = '${safeName}' and '${AUDIT_PARENT_ID}' in parents ` +
                            `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
                        );
                        const driveRes = await fetch(
                            `${AUDIT_BASE}/files?q=${q}&fields=files(id,name,webViewLink,createdTime)` +
                            `&supportsAllDrives=true&includeItemsFromAllDrives=true`,
                            { headers: auditAuthHeaders }
                        );
                        const driveData  = await driveRes.json();
                        const folders    = driveData.files || [];
                        const driveStatus = folders.length === 0 ? 'NOT_FOUND'
                                          : folders.length === 1 ? 'FOUND'
                                          :                        'MULTIPLE_FOUND';
                        let action = driveStatus === 'NOT_FOUND'  ? 'NEEDS_FOLDER_CREATED'
                                   : !proj.mondayDriveUrl && !fix ? 'FOUND_NOT_LINKED'
                                   : !proj.mondayDriveUrl && fix  ? (shouldWrite ? 'WRITING_URL' : 'WOULD_WRITE_URL')
                                   :                                 'ALREADY_LINKED';
                        if (shouldWrite && !proj.mondayDriveUrl && folders.length > 0) {
                            try {
                                const writeVal = JSON.stringify(JSON.stringify({ url: folders[0].webViewLink, text: 'Google Drive Folder' }));
                                const writeMut = `mutation { change_column_value(board_id: ${PROJECTS_BOARD_ID}, item_id: ${proj.id}, column_id: "${DRIVE_URL_COL}", value: ${writeVal}) { id } }`;
                                const wr = await fetch(MONDAY_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY }, body: JSON.stringify({ query: writeMut }) });
                                const wd = await wr.json();
                                action = wd.errors ? `WRITE_FAILED: ${JSON.stringify(wd.errors)}` : 'URL_WRITTEN';
                            } catch (we) { action = `WRITE_FAILED: ${we.message}`; }
                        }
                        return {
                            mondayId: proj.id, projectName: proj.name, group: proj.group,
                            flexProjectNum: proj.flexProjectNum, mondayDriveUrl: proj.mondayDriveUrl,
                            driveStatus, action,
                            driveFolders: folders.map(f => ({ id: f.id, name: f.name, url: f.webViewLink, createdTime: f.createdTime })),
                            primaryDriveUrl: folders[0]?.webViewLink || null,
                        };
                    } catch (err) {
                        return { mondayId: proj.id, projectName: proj.name, group: proj.group, driveStatus: 'ERROR', action: 'ERROR', error: err.message };
                    }
                }));
                auditResults.push(...batchRes);
            }

            const summary = {
                total:             auditResults.length,
                found:             auditResults.filter(r => r.driveStatus === 'FOUND').length,
                notFound:          auditResults.filter(r => r.driveStatus === 'NOT_FOUND').length,
                multipleFound:     auditResults.filter(r => r.driveStatus === 'MULTIPLE_FOUND').length,
                alreadyLinked:     auditResults.filter(r => r.action === 'ALREADY_LINKED').length,
                foundNotLinked:    auditResults.filter(r => ['FOUND_NOT_LINKED','WOULD_WRITE_URL'].includes(r.action)).length,
                urlsWritten:       auditResults.filter(r => r.action === 'URL_WRITTEN').length,
                needsFolderCreate: auditResults.filter(r => r.action === 'NEEDS_FOLDER_CREATED').length,
                errors:            auditResults.filter(r => r.driveStatus === 'ERROR').length,
            };
            console.log('[audit] Summary:', JSON.stringify(summary));

            return res.status(200).json({
                ok: true,
                mode: shouldWrite ? 'WRITE' : 'DRY_RUN',
                summary,
                results: auditResults.sort((a, b) => {
                    const ord = { NOT_FOUND: 0, MULTIPLE_FOUND: 1, FOUND: 2, ERROR: 3 };
                    return (ord[a.driveStatus] ?? 9) - (ord[b.driveStatus] ?? 9);
                }),
            });
        } catch (err) {
            console.error('[audit] ❌ Error:', err.message);
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
        // Also check Event Folder Registry for an existing Drive link
        const [matchedClientId, matchedVenueId, existingProjectId, registryEntry] = await Promise.all([
            findContactByFlexUuid(clientUuid, clientResolvedName),
            findContactByFlexUuid(venueUuid,  venueResolvedName),
            findExistingProjectByFlexNumber(quoteNumber),
            eventFolderUUID ? findRegistryEntry(eventFolderUUID) : Promise.resolve(null),
        ]);
        if (registryEntry?.driveUrl) {
            console.log(`[sync] 📋 Registry hit — Drive folder exists: ${registryEntry.driveUrl}`);
        } else if (eventFolderUUID) {
            // Ensure registry has an entry for this event folder (Drive link may come later via create-folder)
            findRegistryEntry(eventFolderUUID).then(existing => {
                if (!existing) {
                    writeRegistryEntry({
                        itemId: null,
                        eventName: projectName,
                        flexEventFolderUUID: eventFolderUUID,
                        driveUrl: null,
                    }).catch(e => console.warn('[sync] Registry seed failed:', e.message));
                }
            }).catch(() => {});
        }

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

        // ===== STEP 7: Update existing OR create new project =====
        // Drive folder creation is intentionally NOT done here.
        // ?action=create-folder owns Drive folder creation — it runs once during
        // the Vibe app project setup flow before any quote is associated.
        // This handler is a data sync tool only.
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
            }
        });

    } catch (error) {
        console.error('❌ Sync Pipeline Dropout:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
