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
  console.log('Sync Stop Driver webhook triggered');
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

    const stopId = event.pulseId;
    if (!stopId) return res.status(400).json({ error: 'Missing stopId' });

    console.log(`Processing Route Stop: ${stopId}`);

    const routeId = await fetchStopRouteId(stopId);
    console.log(`Connected Route ID: ${routeId}`);

    if (!routeId) {
      return res.status(200).json({ message: 'No route connected to this stop yet', stopId });
    }

    const driverIds = await fetchRouteDriverIds(routeId);
    console.log(`Driver IDs on Route: ${JSON.stringify(driverIds)}`);

    if (driverIds.length === 0) {
      return res.status(200).json({ message: 'No driver assigned to the connected route', stopId, routeId });
    }

    await updateStopDriver(stopId, driverIds);
    console.log(`Driver synced to stop ${stopId}`);

    return res.status(200).json({
      success: true,
      message: 'Driver synced to route stop successfully',
      stopId,
      routeId,
      driverIds
    });

  } catch (error) {
    console.error('Error syncing stop driver:', error);
    return res.status(500).json({ error: 'Failed to sync stop driver', details: error.message });
  }
};

async function fetchStopRouteId(stopId) {
  const query = `
    query {
      items(ids: [${stopId}]) {
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
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);

  const item = data.data.items[0];
  if (!item) throw new Error(`Route Stop ${stopId} not found`);

  const routeCol = item.column_values.find(c => c.id === ROUTE_STOPS_ROUTE_COLUMN);
  console.log('Route column raw:', JSON.stringify(routeCol));

  if (routeCol?.linked_item_ids && routeCol.linked_item_ids.length > 0) {
    return routeCol.linked_item_ids[0];
  }

  if (routeCol?.value) {
    try {
      const parsed = JSON.parse(routeCol.value);
      if (parsed.linkedPulseIds && parsed.linkedPulseIds.length > 0) {
        return parsed.linkedPulseIds[0].linkedPulseId;
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0].id;
      }
    } catch (e) {
      console.error('Error parsing route column value:', e);
    }
  }

  return null;
}

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

async function updateStopDriver(stopId, driverIds) {
  const columnValue = JSON.stringify({ item_ids: driverIds });

  const mutation = `
    mutation {
      change_column_value(
        item_id: ${stopId},
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
  if (data.errors) throw new Error(`Failed to update driver on stop ${stopId}: ${JSON.stringify(data.errors)}`);

  console.log(`✓ Stop ${stopId} driver updated`);
}
