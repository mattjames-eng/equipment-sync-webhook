/**
 * Google Drive Folder Backfill Audit
 *
 * Checks every project on the monday.com Projects board and verifies whether
 * a matching Google Drive folder exists in the shared project parent folder.
 *
 * For each project reports:
 *   - Drive folder found / not found
 *   - Drive folder URL (if found)
 *   - Whether the Drive URL is already stored in monday (text_mm4y2drive column)
 *   - Whether the monday Drive URL column is blank / mismatched
 *
 * Optional: pass ?fix=true to write back found folder URLs to monday.com
 *           pass ?dryRun=true to report only, no writes (default)
 *
 * Usage:
 *   GET  /api/audit-drive-folders             → full report, no writes
 *   GET  /api/audit-drive-folders?fix=true    → write back missing URLs
 *   GET  /api/audit-drive-folders?group=group_mm3x407x  → filter to one group
 *
 * Author: Matt James, Antic Studios
 */

export const config   = { api: { bodyParser: false } };
export const maxDuration = 60;

const MONDAY_API_URL  = 'https://api.monday.com/v2';
const MONDAY_API_KEY  = process.env.MONDAY_API_KEY;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_2 || process.env.GOOGLE_SERVICE_ACCOUNT_KEY || null;

const PROJECTS_BOARD_ID = '18415679761';
const PARENT_FOLDER_ID  = '0AAdFvqzEGrPzUk9PVA';  // Shared Drive parent — same as create-project-from-quote.js
const DRIVE_URL_COL     = 'link_mm4y2drive';        // New column added to store Drive folder URL

// ── Google OAuth (mirrors create-project-from-quote.js) ──────────────────────
async function getGoogleAccessToken() {
    if (!GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
    const key   = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
    const scope = 'https://www.googleapis.com/auth/drive';
    const now   = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim  = Buffer.from(JSON.stringify({
        iss: key.client_email, scope,
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600, iat: now,
    })).toString('base64url');
    const { createSign } = await import('node:crypto');
    const sign = createSign('RSA-SHA256');
    sign.update(`${header}.${claim}`);
    const sig = sign.sign(key.private_key, 'base64url');
    const jwt = `${header}.${claim}.${sig}`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    return tokenData.access_token;
}

// ── Search Drive for an exact-name folder inside the parent ──────────────────
async function findDriveFolder(folderName, authHeaders) {
    const BASE = 'https://www.googleapis.com/drive/v3';
    const safeName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = encodeURIComponent(
        `name = '${safeName}' and '${PARENT_FOLDER_ID}' in parents ` +
        `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const res = await fetch(
        `${BASE}/files?q=${q}&fields=files(id,name,webViewLink,createdTime)` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: authHeaders }
    );
    const data = await res.json();
    return data.files || [];
}

// ── Fetch all projects from the monday Projects board ─────────────────────────
async function fetchAllProjects(groupFilter) {
    const projects = [];
    let cursor     = null;

    do {
        const cursorClause = cursor ? `, cursor: "${cursor}"` : '';
        const groupClause  = groupFilter ? `group_id: "${groupFilter}"` : '';

        const query = `
            query {
                boards(ids: [${PROJECTS_BOARD_ID}]) {
                    groups ${groupClause ? `(ids: ["${groupFilter}"])` : ''} {
                        id
                        title
                        items_page(limit: 100${cursorClause}) {
                            cursor
                            items {
                                id
                                name
                                column_values(ids: ["text_mm3x2yr6", "${DRIVE_URL_COL}"]) {
                                    id
                                    text
                                }
                            }
                        }
                    }
                }
            }
        `;

        const res  = await fetch(MONDAY_API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
            body:    JSON.stringify({ query }),
        });
        const data = await res.json();
        if (data.errors) throw new Error(`monday API error: ${JSON.stringify(data.errors)}`);

        const groups = data?.data?.boards?.[0]?.groups || [];
        cursor = null;

        for (const group of groups) {
            const page = group.items_page;
            cursor = page?.cursor || null;
            for (const item of (page?.items || [])) {
                const flexNumCol  = item.column_values?.find(c => c.id === 'text_mm3x2yr6');
                const driveUrlCol = item.column_values?.find(c => c.id === DRIVE_URL_COL);
                projects.push({
                    id:            item.id,
                    name:          item.name,
                    flexProjectNum: flexNumCol?.text?.trim() || null,
                    mondayDriveUrl: driveUrlCol?.text?.trim() || null,
                    group:         group.title,
                });
            }
        }
    } while (cursor);

    return projects;
}

// ── Write Drive folder URL back to the monday project item ────────────────────
async function writeDriveUrl(itemId, driveUrl) {
    const colValue = JSON.stringify(JSON.stringify({ url: driveUrl, text: 'Google Drive Folder' }));
    const mutation = `
        mutation {
            change_column_value(
                board_id:  ${PROJECTS_BOARD_ID},
                item_id:   ${itemId},
                column_id: "${DRIVE_URL_COL}",
                value:     ${colValue}
            ) { id }
        }
    `;
    const res  = await fetch(MONDAY_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
        body:    JSON.stringify({ query: mutation }),
    });
    const data = await res.json();
    if (data.errors) throw new Error(`monday write error: ${JSON.stringify(data.errors)}`);
    return true;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const fix         = req.query?.fix         === 'true';
    const dryRun      = req.query?.dryRun      !== 'false'; // default true (safe)
    const groupFilter = req.query?.group        || null;
    const shouldWrite = fix && !dryRun;

    console.log(`\n🔍 Drive Folder Audit | fix=${fix} | dryRun=${dryRun} | group=${groupFilter || 'all'}`);

    try {
        // ── 1. Get Google auth ────────────────────────────────────────────────
        if (!GOOGLE_SERVICE_ACCOUNT_KEY) {
            return res.status(500).json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_KEY not configured' });
        }
        const token      = await getGoogleAccessToken();
        const authHeaders = {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
        };

        // ── 2. Fetch all monday projects ──────────────────────────────────────
        console.log('📋 Fetching monday projects...');
        const projects = await fetchAllProjects(groupFilter);
        console.log(`   Found ${projects.length} projects`);

        // ── 3. Search Drive for each project (batched, 5 at a time) ──────────
        const results     = [];
        const BATCH_SIZE  = 5;

        for (let i = 0; i < projects.length; i += BATCH_SIZE) {
            const batch = projects.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async project => {
                console.log(`  🔍 "${project.name}"`);
                try {
                    const folders = await findDriveFolder(project.name, authHeaders);

                    const result = {
                        mondayId:       project.id,
                        projectName:    project.name,
                        group:          project.group,
                        flexProjectNum: project.flexProjectNum,
                        mondayDriveUrl: project.mondayDriveUrl,
                        driveStatus:    folders.length === 0  ? 'NOT_FOUND'
                                      : folders.length === 1  ? 'FOUND'
                                      :                         'MULTIPLE_FOUND',
                        driveFolders:   folders.map(f => ({
                            id:          f.id,
                            name:        f.name,
                            url:         f.webViewLink,
                            createdTime: f.createdTime,
                        })),
                        primaryDriveUrl: folders[0]?.webViewLink || null,
                        mondayLinked:   !!(project.mondayDriveUrl),
                        action:         null,
                    };

                    // Determine action
                    if (folders.length === 0) {
                        result.action = 'NEEDS_FOLDER_CREATED';
                    } else if (!project.mondayDriveUrl && fix) {
                        result.action = shouldWrite ? 'WRITING_URL' : 'WOULD_WRITE_URL';
                        if (shouldWrite) {
                            try {
                                await writeDriveUrl(project.id, folders[0].webViewLink);
                                result.action   = 'URL_WRITTEN';
                                result.mondayLinked = true;
                            } catch (writeErr) {
                                result.action   = `WRITE_FAILED: ${writeErr.message}`;
                            }
                        }
                    } else if (project.mondayDriveUrl && folders.length > 0) {
                        result.action = 'ALREADY_LINKED';
                    } else if (!project.mondayDriveUrl) {
                        result.action = 'FOUND_NOT_LINKED';
                    }

                    return result;

                } catch (err) {
                    return {
                        mondayId:    project.id,
                        projectName: project.name,
                        group:       project.group,
                        driveStatus: 'ERROR',
                        error:       err.message,
                        action:      'ERROR',
                    };
                }
            }));

            results.push(...batchResults);
        }

        // ── 4. Build summary stats ────────────────────────────────────────────
        const summary = {
            total:             results.length,
            found:             results.filter(r => r.driveStatus === 'FOUND').length,
            notFound:          results.filter(r => r.driveStatus === 'NOT_FOUND').length,
            multipleFound:     results.filter(r => r.driveStatus === 'MULTIPLE_FOUND').length,
            alreadyLinked:     results.filter(r => r.action === 'ALREADY_LINKED').length,
            foundNotLinked:    results.filter(r => r.action === 'FOUND_NOT_LINKED' || r.action === 'WOULD_WRITE_URL').length,
            urlsWritten:       results.filter(r => r.action === 'URL_WRITTEN').length,
            needsFolderCreate: results.filter(r => r.action === 'NEEDS_FOLDER_CREATED').length,
            errors:            results.filter(r => r.driveStatus === 'ERROR').length,
        };

        console.log('\n📊 AUDIT SUMMARY:');
        console.log(`  ✅ Found in Drive  : ${summary.found}`);
        console.log(`  ❌ Not found       : ${summary.notFound}`);
        console.log(`  ⚠️  Multiple found  : ${summary.multipleFound}`);
        console.log(`  🔗 Already linked  : ${summary.alreadyLinked}`);
        console.log(`  🔓 Found, no link  : ${summary.foundNotLinked}`);
        console.log(`  ✍️  URLs written    : ${summary.urlsWritten}`);
        console.log(`  ➕ Needs creation  : ${summary.needsFolderCreate}`);

        return res.status(200).json({
            ok: true,
            mode:    shouldWrite ? 'WRITE' : 'DRY_RUN',
            summary,
            results: results.sort((a, b) => {
                // Sort: NOT_FOUND first, then MULTIPLE, then FOUND
                const order = { NOT_FOUND: 0, MULTIPLE_FOUND: 1, FOUND: 2, ERROR: 3 };
                return (order[a.driveStatus] ?? 9) - (order[b.driveStatus] ?? 9);
            }),
        });

    } catch (err) {
        console.error('❌ Audit error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
