// /api/sync-crew-user.js
// Syncs the monday.com User from Crew Database to the assignee column
// on Crew Assignments and Crew Contracts when a crew member is linked.
//
// Routes:
//   ?route=assignments  →  triggers on Crew Assignments "Crew Member" relation
//   ?route=contracts    →  triggers on Crew Contracts "Tech/Engineer" relation

const MONDAY_API_URL = 'https://api.monday.com/v2';

const CREW_DB_BOARD_ID = '18415879010';
const USER_COLUMN_ID   = 'multiple_person_mm4m4jvs'; // "User" column in Crew Database

const ROUTE_CONFIG = {
  assignments: {
    targetBoardId:  '18415879040',
    targetColumnId: 'multiple_person_mm3yfksh', // "Crew Log In"
  },
  contracts: {
    targetBoardId:  '18415879229',
    targetColumnId: 'multiple_person_mm4me99f',  // "Crew User" (new column)
  },
};

async function mondayQuery(apiKey, query) {
  const res = await fetch(MONDAY_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': apiKey,
      'API-Version':   '2024-01',
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const route = req.query.route;
  const cfg   = ROUTE_CONFIG[route];

  if (!cfg) {
    return res.status(400).json({ error: `Unknown route: ${route}` });
  }

  const { event } = req.body;
  if (!event || !event.pulseId) {
    return res.status(400).json({ error: 'Missing event payload' });
  }

  const triggeredItemId = event.pulseId;
  const apiKey = process.env.MONDAY_API_KEY;

  // ── 1. Get linked crew member item ID from the relation column value ─────
  const linkedIds = event?.value?.linkedPulseIds ?? [];

  if (linkedIds.length === 0) {
    // Crew member was cleared — clear the user column too
    await clearPeopleColumn(apiKey, cfg.targetBoardId, triggeredItemId, cfg.targetColumnId);
    return res.status(200).json({ success: true, action: 'cleared' });
  }

  const crewMemberItemId = linkedIds[0].linkedPulseId;

  // ── 2. Fetch the User column from Crew Database ──────────────────────────
  const fetchQuery = `
    query {
      items(ids: [${crewMemberItemId}]) {
        column_values(ids: ["${USER_COLUMN_ID}"]) {
          value
        }
      }
    }
  `;

  const fetchResult = await mondayQuery(apiKey, fetchQuery);
  const items = fetchResult?.data?.items ?? [];

  if (items.length === 0) {
    return res.status(404).json({ error: 'Crew member item not found in Crew Database' });
  }

  const rawValue = items[0].column_values[0]?.value;

  if (!rawValue) {
    // No monday user linked yet — skip silently (crew member not onboarded)
    return res.status(200).json({ success: true, action: 'skipped_no_user' });
  }

  const parsed = JSON.parse(rawValue);
  const personsAndTeams = parsed?.personsAndTeams ?? [];

  if (personsAndTeams.length === 0) {
    return res.status(200).json({ success: true, action: 'skipped_empty_user' });
  }

  // ── 3. Write the user to the target board's people column ────────────────
  const columnValue = JSON.stringify({ personsAndTeams });
  const escapedValue = columnValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const updateMutation = `
    mutation {
      change_column_value(
        board_id: ${cfg.targetBoardId},
        item_id: ${triggeredItemId},
        column_id: "${cfg.targetColumnId}",
        value: "${escapedValue}"
      ) {
        id
      }
    }
  `;

  const updateResult = await mondayQuery(apiKey, updateMutation);

  if (updateResult?.errors) {
    console.error('Monday API error:', JSON.stringify(updateResult.errors));
    return res.status(500).json({ error: 'Failed to update column', details: updateResult.errors });
  }

  console.log(`[sync-crew-user] route=${route} item=${triggeredItemId} crew_member=${crewMemberItemId} users=${JSON.stringify(personsAndTeams)}`);
  return res.status(200).json({ success: true, action: 'synced', route, triggeredItemId, crewMemberItemId });
}

async function clearPeopleColumn(apiKey, boardId, itemId, columnId) {
  const mutation = `
    mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "{\\"personsAndTeams\\":[]}"
      ) { id }
    }
  `;
  await mondayQuery(apiKey, mutation);
}
