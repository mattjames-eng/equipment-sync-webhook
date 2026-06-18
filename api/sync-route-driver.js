const fetch = require('node-fetch');

export const config = {
  api: { bodyParser: true },
};

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

const ROUTES_BOARD_ID = '18415598386';
const ROUTE_STOPS_BOARD_ID = '18415570592';

const ROUTES_DRIVER_COLUMN = 'board_relation_mm4cb1se';      // Driver on Routes
const ROUTE_STOPS_ROUTE_COLUMN = 'board_relation_mm3w48fh';  // Route connection on Route Stops
const ROUTE_STOPS_DRIVER_COLUMN = 'board_relation_mm3va52r'; // Driver on Route Stops

module.exports = async (req, res) => {
  console.log('Sync Route Driver webhook triggered');
  console.log('Method:', req.method);
  console.log('Body:', JSON.stringify(req.body));

  if (req.method === 'POST' && req.body && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
  }

  try {
    const event = body.event;
    if (!event) return res.status(400).json({ error: 'Missing event data' });

    const routeId = event.pulseId;
    if (!routeId) return res.status(400).json({ error: 'Missing routeId' });

    console.log(`Syncing driver for Route: ${routeId}`);

    const driverIds = await fetchRouteDriverIds(routeId);
    console.log(`Driver IDs on Route: ${JSON.stringify(driverIds)}`);

    const routeStops = await fetchRouteStops(routeId);
    console.log(`Found ${routeStops.length} route stops to update`);

    if (routeStops.length === 0) {
      return res.status(200).json({ message: 'No route stops found', routeId });
    }

    await updateRouteStopsDriver(routeStops, driverIds);
    console.log(`Driver synced to ${routeStops.length} route stops`);

    return res.status(200).json({
      success: true,
      message: 'Driver synced to route stops successfully',
      routeId,
      driverIds,
      stopsUpdated: routeStops.length
    });

  } catch (error) {
    console.error('Error syncing route driver:', error);
    return res.status(500).json({ error: 'Failed to sync route driver', details: error.message });
  }
};

async function fetchRouteDriverIds(routeId) {
  const query = `
    query {
      items(ids: [${routeId}]) {
        id
        name
        column_values(ids: ["${ROUTES_DRIVER_COLUMN}"]) {
          id
          value
          text
          ... on BoardRelationValue {
            linked_item_ids
          }
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);

  const item = data.data.items[0];
  if (!item) throw new Error(`Route ${routeId} not found`);

  const driverCol = item.column_values.find(c => c.id === ROUTES_DRIVER_COLUMN);
  console.log('Driver column raw:', JSON.stringify(driverCol));

  if (driverCol?.linked_item_ids && driverCol.linked_item_ids.length > 0) {
    return driverCol.linked_item_ids;
  }

  if (driverCol?.value) {
    try {
      const parsed = JSON.parse(driverCol.value);
      if (parsed.linkedPulseIds && parsed.linkedPulseIds.length > 0) {
        return parsed.linkedPulseIds.map(l => l.linkedPulseId);
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(l => l.id);
      }
    } catch (e) {
      console.error('Error parsing driver column value:', e);
    }
  }

  return [];
}

async function fetchRouteStops(routeId) {
  const query = `
    query {
      boards(ids: [${ROUTE_STOPS_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: ["${ROUTE_STOPS_ROUTE_COLUMN}"]) {
              id
              value
              text
              ... on BoardRelationValue {
                linked_item_ids
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);

  const allItems = data.data.boards[0].items_page.items;
  console.log(`Fetched ${allItems.length} total items from Route Stops board`);

  return allItems.filter(item => {
    const routeCol = item.column_values.find(c => c.id === ROUTE_STOPS_ROUTE_COLUMN);
    if (!routeCol) return false;

    if (routeCol.linked_item_ids) {
      return routeCol.linked_item_ids.some(id => id.toString() === routeId.toString());
    }

    if (!routeCol.value) return false;

    try {
      const parsed = JSON.parse(routeCol.value);
      if (parsed.linkedPulseIds) {
        return parsed.linkedPulseIds.some(l => l.linkedPulseId.toString() === routeId.toString());
      }
      if (Array.isArray(parsed)) {
        return parsed.some(l => l.id && l.id.toString() === routeId.toString());
      }
    } catch (e) {
      console.error(`Error parsing route column for stop ${item.id}:`, e);
    }

    return false;
  });
}

async function updateRouteStopsDriver(stops, driverIds) {
  const columnValue = driverIds.length > 0
    ? JSON.stringify({ item_ids: driverIds })
    : JSON.stringify({ item_ids: [] });

  for (const stop of stops) {
    console.log(`Updating driver on stop: ${stop.id} (${stop.name})`);

    const mutation = `
      mutation {
        change_column_value(
          item_id: ${stop.id},
          board_id: ${ROUTE_STOPS_BOARD_ID},
          column_id: "${ROUTE_STOPS_DRIVER_COLUMN}",
          value: ${JSON.stringify(columnValue)}
        ) {
          id
        }
      }
    `;

    const response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
      body: JSON.stringify({ query: mutation })
    });

    const data = await response.json();
    if (data.errors) {
      console.error(`Failed to update driver on stop ${stop.id}:`, data.errors);
    } else {
      console.log(`✓ Stop ${stop.id} (${stop.name}) driver updated`);
    }
  }
}
