// /api/sync-crew-user-assignments.js
// Fires when Crew Member relation changes on Crew Assignments board.
// Looks up the monday.com User from Crew Database and writes it to the Crew Log In column.
// Self-contained — no cross-function imports.

const MONDAY_API_URL = 'https://api.monday.com/v2';
const USER_COLUMN_ID = 'multiple_person_mm4m4jvs'; // "User" col in Crew Database
const TARGET_BOARD_ID = '18415879040';              // Crew Assignments
const TARGET_COLUMN_ID = 'multiple_person_mm3yfksh'; // "Crew Log In"

async function mondayQuery(apiKey, query) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { event } = req.body;
  if (!event || !event.pulseId) {
    return res.status(400).json({ error: 'Missing event payload' });
  }

  const triggeredItemId = event.pulseId;
  const apiKey = process.env.MONDAY_API_KEY;
  const linkedIds = event?.value?.linkedPulseIds ?? [];

  // Crew member cleared — wipe the people column too
  if (linkedIds.length === 0) {
    await mondayQuery(apiKey, `
      mutation {
        change_column_value(
          board_id: ${TARGET_BOARD_ID},
          item_id: ${triggeredItemId},
          column_id: "${TARGET_COLUMN_ID}",
          value: "{\\"personsAndTeams\\":[]}"
        ) { id }
      }
    `);
    return res.status(200).json({ success: true, action: 'cleared' });
  }

  const crewMemberItemId = linkedIds[0].linkedPulseId;

  // Fetch the User column from Crew Database
  const fetchResult = await mondayQuery(apiKey, `
    query {
      items(ids: [${crewMemberItemId}]) {
        column_values(ids: ["${USER_COLUMN_ID}"]) {
          value
        }
      }
    }
  `);

  const items = fetchResult?.data?.items ?? [];
  if (items.length === 0) {
    return res.status(404).json({ error: 'Crew member not found in Crew Database' });
  }

  const rawValue = items[0].column_values[0]?.value;
  if (!rawValue) {
    // No monday user linked yet — skip silently
    return res.status(200).json({ success: true, action: 'skipped_no_user' });
  }

  const parsed = JSON.parse(rawValue);
  const personsAndTeams = parsed?.personsAndTeams ?? [];
  if (personsAndTeams.length === 0) {
    return res.status(200).json({ success: true, action: 'skipped_empty_user' });
  }

  // Write the user to Crew Log In
  const columnValue = JSON.stringify({ personsAndTeams });
  const escapedValue = columnValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const updateResult = await mondayQuery(apiKey, `
    mutation {
      change_column_value(
        board_id: ${TARGET_BOARD_ID},
        item_id: ${triggeredItemId},
        column_id: "${TARGET_COLUMN_ID}",
        value: "${escapedValue}"
      ) { id }
    }
  `);

  if (updateResult?.errors) {
    console.error('[sync-crew-user-assignments] API error:', JSON.stringify(updateResult.errors));
    return res.status(500).json({ error: 'Failed to update column', details: updateResult.errors });
  }

  console.log(`[sync-crew-user-assignments] synced item=${triggeredItemId} crew_member=${crewMemberItemId}`);
  return res.status(200).json({ success: true, action: 'synced', triggeredItemId, crewMemberItemId });
}
