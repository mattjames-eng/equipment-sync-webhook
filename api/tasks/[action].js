/**
 * ShowFlow PM Checklist Loader
 *
 * Copies all subitems from the master template project (see TEMPLATE_PROJECT_ID)
 * into a target project, one at a time in strict insertion order.
 *
 * ⚠️  Sequential execution is intentional — do NOT convert to Promise.all or batch.
 *     Parallel requests race each other; monday.com inserts tasks in arrival order,
 *     not submission order, which scrambles the checklist.
 *
 * Route:  POST /api/tasks/load-all
 * Author: Matt James, Antic Studios
 */

import { waitUntil } from '@vercel/functions';

export const maxDuration = 300; // seconds — 65 tasks × ~1.8s ≈ 120s, needs room to breathe

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PROJECTS_BOARD_ID = '18415679761';
const TEMPLATE_PROJECT_ID = '12153638858';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body?.event || req.body || {};
  const projectId = event.pulseId || event.itemId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  console.log(`📥 Sequential Task Load starting for Project ID: ${projectId}`);

  // STEP 0: Pre-flight — check BOTH the status column AND existing subitems.
  // Checking status first blocks Vercel's automatic request retries (which arrive
  // after a gateway timeout). The status gets flipped to "Loading Tasks..." before
  // any task creation, so a retry will see the flag and bail immediately without
  // racing past the subitem check.
  const preflightQuery = `
    query($id: [ID!]) {
      items(ids: $id) {
        subitems { id }
        column_values(ids: ["color_mm3ycrm1"]) { id text }
      }
    }
  `;
  const preflightResponse = await mondayApiCall(preflightQuery, { id: [projectId.toString()] });
  const preflightItem     = preflightResponse.data?.items?.[0];
  const existingSubitems  = preflightItem?.subitems || [];
  const currentStatus     = preflightItem?.column_values?.find(c => c.id === 'color_mm3ycrm1')?.text || '';

  // Only block on "Tasks Loaded" — NOT "Loading Tasks...".
  // The button automation sets "Loading Tasks..." BEFORE the webhook fires,
  // so if we block on that status, every legitimate first call gets killed.
  // "Tasks Loaded" is the reliable post-success guard. Subitem count catches the rest.
  if (currentStatus === 'Tasks Loaded') {
    console.log(`⚠️ Project ${projectId} status is "Tasks Loaded" — aborting to prevent duplicates`);
    return res.status(200).json({
      success: false,
      alreadyLoaded: true,
      currentStatus,
      message: `Blocked — status is already "Tasks Loaded". Clear tasks and reset status before reloading.`
    });
  }

  if (existingSubitems.length > 0) {
    console.log(`⚠️ Project ${projectId} already has ${existingSubitems.length} tasks — aborting`);
    return res.status(200).json({
      success: false,
      alreadyLoaded: true,
      existingTaskCount: existingSubitems.length,
      message: `Tasks already exist (${existingSubitems.length}). Clear existing tasks first if you want to reload.`
    });
  }

  // Status is already "Loading Tasks..." (set by the button automation that triggered this webhook).
  // No need to set it again — skip straight to the pipeline.
  console.log(`⏳ Status already "Loading Tasks..." (set by button automation) — proceeding for project ${projectId}`);

  // Respond 200 immediately so the HTTP client gets a clean response and Vercel
  // doesn't trigger an automatic retry. waitUntil() tells Vercel to keep this
  // function instance alive until runTaskPipeline() resolves, even though the
  // HTTP response has already been sent.
  res.status(200).json({ success: true, message: 'Task loading started', projectId });
  waitUntil(runTaskPipeline(projectId));
}

/**
 * All the real work happens here — fetching the template, creating all subitems
 * in a single batched GraphQL mutation, then flipping the parent status to "Tasks Loaded".
 *
 * Why a single batched mutation?
 * The Vercel Hobby plan caps function execution at 60 seconds. 65 sequential
 * create_subitem calls at ~1.5s each = ~97s — over the limit. By sending all
 * 65 creates as aliased mutations in one request, we make a single network
 * round-trip (~2-3s total). Per the GraphQL spec, mutations execute serially,
 * so insertion order is guaranteed identical to template order.
 *
 * Called via waitUntil() so it keeps running after the 200 response is sent.
 */
async function runTaskPipeline(projectId) {
  try {
    // Fetch all subitems from the master template project
    const templateQuery = `query($templateId: [ID!]) { items(ids: $templateId) { subitems { id name column_values { id text } } } }`;
    const templateResponse = await mondayApiCall(templateQuery, { templateId: [TEMPLATE_PROJECT_ID] });
    const allTemplateSubitems = templateResponse.data?.items?.[0]?.subitems || [];

    console.log(`🎯 Retrieved ${allTemplateSubitems.length} tasks from template — building batch mutation`);

    // Build one mega-mutation: all creates as aliases (t0, t1, t2…).
    // GraphQL mutations are serial per spec — t0 completes before t1 starts,
    // so monday.com inserts them in the same order they appear here.
    const mutationAliases = [];
    const variables = {};

    for (let i = 0; i < allTemplateSubitems.length; i++) {
      const task = allTemplateSubitems[i];
      const phaseText    = task.column_values.find(col => col.id === 'dropdown_mm3x2wmx')?.text;
      const priorityText = task.column_values.find(col => col.id === 'color_mm3x885a')?.text;
      const assignedTier = task.column_values.find(col => col.id === 'dropdown_mm3xhker')?.text || 'Basic';

      const subitemValues = {
        status: { label: "Not Started" },
        dropdown_mm3xhker: { labels: assignedTier.split(',').map(s => s.trim()) }
      };
      if (phaseText)    subitemValues.dropdown_mm3x2wmx = { labels: phaseText.split(',').map(s => s.trim()) };
      if (priorityText) subitemValues.color_mm3x885a    = { label: priorityText };

      variables[`name${i}`]   = task.name;
      variables[`values${i}`] = JSON.stringify(subitemValues);

      mutationAliases.push(
        `t${i}: create_subitem(parent_item_id: "${projectId}", item_name: $name${i}, column_values: $values${i}) { id }`
      );
    }

    // Declare every variable in the mutation signature
    const varDeclarations = allTemplateSubitems
      .map((_, i) => `$name${i}: String!, $values${i}: JSON!`)
      .join(', ');

    const batchMutation = `mutation CreateAll(${varDeclarations}) { ${mutationAliases.join(' ')} }`;

    // Flip status to "Tasks Loaded" BEFORE firing the batch.
    // Monday.com takes ~70s to process 66 serial mutations — over the 60s Hobby
    // cap. The function will time out while waiting for the batch response.
    // By flipping status now, we guarantee it's correct regardless of timeout.
    // The tasks themselves land on the board even after our connection closes,
    // because monday's server already has the full request body in flight.
    await mondayApiCall(
      `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) { change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id } }`,
      { boardId: PROJECTS_BOARD_ID, itemId: projectId.toString(), values: JSON.stringify({ "color_mm3ycrm1": { "label": "Tasks Loaded" } }) }
    );
    console.log(`✅ Status → "Tasks Loaded" — firing batch for ${allTemplateSubitems.length} tasks`);

    // Fire the batch — don't await the full response (it arrives after the 60s wall).
    // Node transmits the full request body to monday's server before we exit.
    // Monday processes all mutations serially, even after the TCP connection closes.
    fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY, 'API-Version': '2024-10' },
      body: JSON.stringify({ query: batchMutation, variables })
    })
      .then(r => r.json())
      .then(d => console.log(`  batch response — ${Object.keys(d.data || {}).length} tasks confirmed`))
      .catch(e => console.log(`  batch connection ended: ${e.message}`));

    // Give the request 2s to transmit fully before the runtime cleans up
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`🚀 Done — batch in flight, status already flipped`);
  } catch (error) {
    console.error('❌ runTaskPipeline failed:', error);
  }
}

async function mondayApiCall(query, variables = null) {
  const payload = { query };
  if (variables) payload.variables = variables;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version': '2024-10'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) throw new Error(`monday HTTP error: ${response.status}`);
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);

  return data;
}
