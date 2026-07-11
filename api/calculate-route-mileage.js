// Vercel body parser configuration
export const config = {
  api: {
    bodyParser: true,
  },
};

// Monday.com API configuration
const MONDAY_API_URL    = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN  = process.env.MONDAY_API_KEY;

// Google Maps API configuration
const ROUTES_V2_API_KEY = process.env.ROUTES_V2_API_KEY;

// Board IDs
const ROUTES_BOARD_ID      = '18415598386';
const ROUTE_STOPS_BOARD_ID = '18415570592';

// Column IDs - Routes Board
const ROUTES_START_LOCATION_COLUMN   = 'board_relation_mm4dfw6d'; // Route Start Location
const ROUTES_END_LOCATION_COLUMN     = 'board_relation_mm4d795a'; // Route End Location
const ROUTES_TOTAL_DISTANCE_COLUMN   = 'numeric_mm3wwt5j';        // Total Distance on Routes
const ROUTES_TOTAL_DRIVE_TIME_COLUMN = 'numeric_mm3wens3';        // Total Drive Time on Routes

// Column IDs - Route Stops Board
const ROUTE_STOPS_ROUTE_COLUMN       = 'board_relation_mm3w48fh'; // Route connection
const ROUTE_STOPS_LOCATION_COLUMN    = 'board_relation_mm3vn6yb'; // Location connection
const ROUTE_STOPS_DATE_COLUMN        = 'date_mm3v2kz1';           // Date for sorting
const ROUTE_STOPS_TIME_COLUMN        = 'hour_mm3ws9gq';           // Time for sorting
const ROUTE_STOPS_DISTANCE_COLUMN    = 'numeric_mm4eq22c';        // Distance to Next Stop
const ROUTE_STOPS_DRIVE_TIME_COLUMN  = 'numeric_mm4ezw83';        // Drive Time to Next Stop

// ================================================================
// SHARED HELPER: resolve linked item ID from a BoardRelationValue.
// monday.com returns this in 3 different formats depending on
// which API version / fragment you use — handle all of them.
// ================================================================
function getLinkedId(colData) {
  if (!colData) return null;

  // Format A: GraphQL inline fragment (most reliable)
  if (colData.linked_item_ids?.length) return colData.linked_item_ids[0];

  const val = colData.value;
  if (!val) return null;

  // Format B: { linkedPulseIds: [{ linkedPulseId: "..." }] }
  if (val.linkedPulseIds?.length) return val.linkedPulseIds[0].linkedPulseId;

  // Format C: direct array [{ id: "..." }]
  if (Array.isArray(val) && val.length) return val[0].id;

  return null;
}

// ================================================================
// SHARED HELPER: Monday GraphQL request
// ================================================================
async function mondayRequest(query) {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query })
  });
  const data = await response.json();
  if (data.errors) throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
  console.log('Route mileage webhook triggered');

  // Monday webhook challenge
  if (req.method === 'POST' && req.body?.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  // Sub-route dispatch
  const route = req.query?.route;
  if (route === 'sync-route-driver') return handleSyncRouteDriver(req, res);
  if (route === 'sync-stop-driver')  return handleSyncStopDriver(req, res);

  // Parse body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON in request body' }); }
  }

  try {
    const event = body?.event;
    if (!event)          return res.status(400).json({ error: 'Missing event data' });
    const routeId = event.pulseId;
    if (!routeId)        return res.status(400).json({ error: 'Missing routeId' });

    console.log(`Calculating mileage for Route: ${routeId}`);

    // Fetch route details + stops in parallel (stops are server-side filtered)
    const [routeDetails, routeStops] = await Promise.all([
      fetchRouteDetails(routeId),
      fetchRouteStops(routeId)
    ]);

    console.log(`Route: "${routeDetails.name}" | ${routeStops.length} stops`);

    if (routeStops.length === 0) {
      return res.status(200).json({ message: 'No route stops found for this route', routeId });
    }

    // Sort by date + time
    const sortedStops = sortRouteStops(routeStops);

    // Fetch all location addresses in parallel (batched + start/end simultaneously)
    const locationIds = sortedStops.map(s => s.locationId).filter(Boolean);
    const [locationMap, startLocation, endLocation] = await Promise.all([
      fetchLocationsByIds(locationIds),
      fetchLocationAddress(routeDetails.startLocationId),
      fetchLocationAddress(routeDetails.endLocationId)
    ]);

    const stopsWithAddresses = sortedStops.map(stop => ({
      ...stop,
      locationName: locationMap[stop.locationId]?.name    || 'Unknown',
      address:      locationMap[stop.locationId]?.address || 'Unknown'
    }));

    // Build full waypoint sequence: Start → Stops → End
    const completeRoute = buildCompleteRoute(startLocation, stopsWithAddresses, endLocation);
    console.log(`${completeRoute.length} waypoints total`);

    // Calculate all leg distances in parallel, then write all stops in parallel
    const calculations = await calculateDistancesAndTimes(completeRoute);
    await updateRouteStops(calculations);

    // Roll up totals and update the Route item
    const totals = calculateTotals(calculations);
    await updateRouteTotals(routeId, totals);

    console.log(`✅ Route complete — ${totals.totalDistance} mi, ${totals.totalDriveTime} hrs`);

    return res.status(200).json({
      success: true,
      routeId,
      stopsProcessed: routeStops.length,
      totalDistance:  totals.totalDistance,
      totalDriveTime: totals.totalDriveTime
    });

  } catch (error) {
    console.error('Route mileage error:', error);
    return res.status(500).json({ error: 'Failed to calculate route mileage', details: error.message });
  }
}

// ================================================================
// FETCH ROUTE DETAILS (start/end location IDs)
// ================================================================
async function fetchRouteDetails(routeId) {
  const data = await mondayRequest(`
    query {
      items(ids: [${routeId}]) {
        id name
        column_values(ids: ["${ROUTES_START_LOCATION_COLUMN}", "${ROUTES_END_LOCATION_COLUMN}"]) {
          id value text
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }
  `);

  const item = data.items[0];
  const colMap = {};
  item.column_values.forEach(col => {
    colMap[col.id] = {
      value:           col.value ? JSON.parse(col.value) : null,
      text:            col.text,
      linked_item_ids: col.linked_item_ids || null
    };
  });

  return {
    id:              item.id,
    name:            item.name,
    startLocationId: getLinkedId(colMap[ROUTES_START_LOCATION_COLUMN]),
    endLocationId:   getLinkedId(colMap[ROUTES_END_LOCATION_COLUMN])
  };
}

// ================================================================
// FETCH ROUTE STOPS — server-side filtered by routeId.
// monday's items_page query_params handles the join so we never
// pull the full board and filter in JavaScript.
// ================================================================
async function fetchRouteStops(routeId) {
  const data = await mondayRequest(`
    query {
      boards(ids: [${ROUTE_STOPS_BOARD_ID}]) {
        items_page(
          limit: 500,
          query_params: {
            rules: [{
              column_id: "${ROUTE_STOPS_ROUTE_COLUMN}",
              compare_value: ["${routeId}"]
            }]
          }
        ) {
          items {
            id name
            column_values(ids: [
              "${ROUTE_STOPS_LOCATION_COLUMN}",
              "${ROUTE_STOPS_DATE_COLUMN}",
              "${ROUTE_STOPS_TIME_COLUMN}"
            ]) {
              id value text
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }
      }
    }
  `);

  const items = data.boards[0].items_page.items;
  console.log(`Found ${items.length} stops for Route ${routeId}`);

  return items.map(item => {
    const colMap = {};
    item.column_values.forEach(col => {
      colMap[col.id] = {
        value:           col.value ? JSON.parse(col.value) : null,
        text:            col.text,
        linked_item_ids: col.linked_item_ids || null
      };
    });

    return {
      id:         item.id,
      name:       item.name,
      date:       colMap[ROUTE_STOPS_DATE_COLUMN]?.text     || '',
      time:       colMap[ROUTE_STOPS_TIME_COLUMN]?.text     || '',
      locationId: getLinkedId(colMap[ROUTE_STOPS_LOCATION_COLUMN])
    };
  });
}

// ================================================================
// SORT STOPS by date + time
// Handles missing dates/times gracefully — stops without dates sort last
// so they don't corrupt the leg order for stops that do have dates.
// ================================================================
function sortRouteStops(stops) {
  return [...stops].sort((a, b) => {
    const dateA = a.date ? new Date(`${a.date} ${a.time || '00:00'}`) : null;
    const dateB = b.date ? new Date(`${b.date} ${b.time || '00:00'}`) : null;

    // Both valid → compare normally
    if (dateA && dateB) return dateA - dateB;
    // Only A is missing → A goes last
    if (!dateA && dateB) return 1;
    // Only B is missing → B goes last
    if (dateA && !dateB) return -1;
    // Both missing → preserve original array order (stable)
    return 0;
  });
}

// ================================================================
// FETCH LOCATIONS — single batched query for all stop locations
// ================================================================
async function fetchLocationsByIds(locationIds) {
  if (!locationIds.length) return {};

  const data = await mondayRequest(`
    query {
      items(ids: [${locationIds.join(', ')}]) {
        id name
        column_values(ids: ["long_text_mm3vkzc6"]) { id text }
      }
    }
  `);

  const map = {};
  data.items.forEach(item => {
    const addressCol = item.column_values.find(c => c.id === 'long_text_mm3vkzc6');
    map[item.id] = {
      name:    item.name,
      address: addressCol?.text || item.name
    };
  });
  return map;
}

// ================================================================
// FETCH SINGLE LOCATION ADDRESS (for route start/end)
// ================================================================
async function fetchLocationAddress(locationId) {
  if (!locationId) return null;

  const data = await mondayRequest(`
    query {
      items(ids: [${locationId}]) {
        id name
        column_values(ids: ["long_text_mm3vkzc6"]) { id text }
      }
    }
  `);

  const item       = data.items[0];
  const addressCol = item.column_values.find(c => c.id === 'long_text_mm3vkzc6');
  return {
    id:      item.id,
    name:    item.name,
    address: addressCol?.text || item.name
  };
}

// ================================================================
// BUILD COMPLETE ROUTE: Start sentinel → Stops → End sentinel
// ================================================================
function buildCompleteRoute(startLocation, stops, endLocation) {
  const route = [];

  if (startLocation) {
    route.push({
      id: 'start', name: startLocation.name,
      locationName: startLocation.name, address: startLocation.address,
      isStartLocation: true
    });
  }

  stops.forEach(stop => route.push(stop));

  if (endLocation) {
    route.push({
      id: 'end', name: endLocation.name,
      locationName: endLocation.name, address: endLocation.address,
      isEndLocation: true
    });
  }

  return route;
}

// ================================================================
// CALCULATE DISTANCES + DRIVE TIMES
// All Google Routes API calls fire in parallel — one per leg.
// ================================================================
async function calculateDistancesAndTimes(waypoints) {
  const pairs = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    pairs.push({ origin: waypoints[i], destination: waypoints[i + 1] });
  }

  const legResults = await Promise.all(pairs.map(async ({ origin, destination }) => {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   ROUTES_V2_API_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      body: JSON.stringify({
        origin:                   { address: origin.address },
        destination:              { address: destination.address },
        travelMode:               'DRIVE',
        routingPreference:        'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        units:                    'IMPERIAL'
      })
    });

    const data = await response.json();

    if (!data.routes?.length) {
      console.error(`No route: ${origin.locationName} → ${destination.locationName}`);
      return { origin, distanceMiles: 0, driveTimeHours: 0, error: true };
    }

    const leg           = data.routes[0];
    const distanceMiles = parseFloat((leg.distanceMeters / 1609.34).toFixed(1));
    // Google returns duration as "1234s" — strip non-numeric chars to be safe
    const durationSec   = parseInt(leg.duration.replace(/\D/g, ''), 10);
    const driveTimeHours = parseFloat((durationSec / 3600).toFixed(2));

    console.log(`  ${origin.locationName} → ${destination.locationName}: ${distanceMiles} mi, ${driveTimeHours} hrs`);
    return { origin, distanceMiles, driveTimeHours };
  }));

  // Map to stop write objects — skip start/end sentinels
  const calculations = [];
  for (const { origin, distanceMiles, driveTimeHours, error } of legResults) {
    if (!origin.isStartLocation && !origin.isEndLocation) {
      calculations.push({
        stopId:          origin.id,
        distanceToNext:  distanceMiles,
        driveTimeToNext: driveTimeHours,
        ...(error && { error: 'NO_ROUTE_FOUND' })
      });
    }
  }

  // True terminus (no end-location sentinel): zero out "to next"
  const last = waypoints[waypoints.length - 1];
  if (!last.isEndLocation && !last.isStartLocation) {
    calculations.push({ stopId: last.id, distanceToNext: 0, driveTimeToNext: 0 });
  }

  return calculations;
}

// ================================================================
// UPDATE ROUTE STOPS — all writes in parallel
// ================================================================
async function updateRouteStops(calculations) {
  await Promise.all(calculations.map(async (calc) => {
    await mondayRequest(`
      mutation {
        change_multiple_column_values(
          item_id: ${calc.stopId},
          board_id: ${ROUTE_STOPS_BOARD_ID},
          column_values: "{\\"${ROUTE_STOPS_DISTANCE_COLUMN}\\": \\"${calc.distanceToNext}\\", \\"${ROUTE_STOPS_DRIVE_TIME_COLUMN}\\": \\"${calc.driveTimeToNext}\\"}"
        ) { id }
      }
    `);
  }));
}

// ================================================================
// CALCULATE + WRITE ROUTE TOTALS
// ================================================================
function calculateTotals(calculations) {
  return {
    totalDistance:  parseFloat(calculations.reduce((s, c) => s + c.distanceToNext,  0).toFixed(1)),
    totalDriveTime: parseFloat(calculations.reduce((s, c) => s + c.driveTimeToNext, 0).toFixed(2))
  };
}

async function updateRouteTotals(routeId, totals) {
  await mondayRequest(`
    mutation {
      change_multiple_column_values(
        item_id: ${routeId},
        board_id: ${ROUTES_BOARD_ID},
        column_values: "{\\"${ROUTES_TOTAL_DISTANCE_COLUMN}\\": \\"${totals.totalDistance}\\", \\"${ROUTES_TOTAL_DRIVE_TIME_COLUMN}\\": \\"${totals.totalDriveTime}\\"}"
      ) { id }
    }
  `);
}

// ================================================================
// HANDLER: Sync route driver → cascade driver to all stops
// Endpoint: /api/calculate-route-mileage?route=sync-route-driver
// ================================================================
async function handleSyncRouteDriver(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  try {
    const event   = body?.event;
    if (!event)   return res.status(400).json({ error: 'Missing event data' });
    const routeId = event.pulseId;
    if (!routeId) return res.status(400).json({ error: 'Missing routeId' });

    console.log(`Syncing driver for Route: ${routeId}`);

    const [driverIds, routeStops] = await Promise.all([
      fetchRouteDriverIds(routeId),
      fetchRouteStopsForDriverSync(routeId)
    ]);

    if (routeStops.length === 0) {
      return res.status(200).json({ message: 'No route stops found', routeId });
    }

    await updateRouteStopsDriver(routeStops, driverIds);

    return res.status(200).json({ success: true, routeId, driverIds, stopsUpdated: routeStops.length });

  } catch (error) {
    console.error('Error syncing route driver:', error);
    return res.status(500).json({ error: 'Failed to sync route driver', details: error.message });
  }
}

// ================================================================
// HANDLER: Sync stop driver — single stop inherits driver from its route
// Endpoint: /api/calculate-route-mileage?route=sync-stop-driver
// ================================================================
async function handleSyncStopDriver(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  try {
    const event  = body?.event;
    if (!event)  return res.status(400).json({ error: 'Missing event data' });
    const stopId = event.pulseId;
    if (!stopId) return res.status(400).json({ error: 'Missing stopId' });

    const routeId = await fetchStopRouteId(stopId);
    if (!routeId) {
      return res.status(200).json({ message: 'No route connected to this stop yet', stopId });
    }

    const driverIds = await fetchRouteDriverIds(routeId);
    if (driverIds.length === 0) {
      return res.status(200).json({ message: 'No driver on connected route', stopId, routeId });
    }

    await updateStopDriver(stopId, driverIds);

    return res.status(200).json({ success: true, stopId, routeId, driverIds });

  } catch (error) {
    console.error('Error syncing stop driver:', error);
    return res.status(500).json({ error: 'Failed to sync stop driver', details: error.message });
  }
}

// ================================================================
// DRIVER SYNC HELPERS
// ================================================================

async function fetchRouteDriverIds(routeId) {
  const ROUTES_DRIVER_COLUMN = 'board_relation_mm4ny8kc'; // Driver column on Routes board
  const data = await mondayRequest(`
    query {
      items(ids: [${routeId}]) {
        column_values(ids: ["${ROUTES_DRIVER_COLUMN}"]) {
          id value
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }
  `);

  const col = data.items[0]?.column_values?.find(c => c.id === ROUTES_DRIVER_COLUMN);
  if (col?.linked_item_ids?.length) return col.linked_item_ids;
  if (col?.value) {
    try {
      const p = JSON.parse(col.value);
      if (p.linkedPulseIds?.length) return p.linkedPulseIds.map(l => l.linkedPulseId);
      if (Array.isArray(p) && p.length) return p.map(l => l.id);
    } catch (e) {}
  }
  return [];
}

// Server-side filtered — no full-board scan
async function fetchRouteStopsForDriverSync(routeId) {
  const data = await mondayRequest(`
    query {
      boards(ids: [${ROUTE_STOPS_BOARD_ID}]) {
        items_page(
          limit: 500,
          query_params: {
            rules: [{
              column_id: "${ROUTE_STOPS_ROUTE_COLUMN}",
              compare_value: ["${routeId}"]
            }]
          }
        ) {
          items { id name }
        }
      }
    }
  `);
  return data.boards[0].items_page.items || [];
}

// Parallel writes
async function updateRouteStopsDriver(stops, driverIds) {
  const ROUTE_STOPS_DRIVER_COLUMN = 'board_relation_mm3va52r';
  const columnValue = JSON.stringify({ item_ids: driverIds.length ? driverIds : [] });

  await Promise.all(stops.map(async (stop) => {
    await mondayRequest(`
      mutation {
        change_column_value(
          item_id: ${stop.id},
          board_id: ${ROUTE_STOPS_BOARD_ID},
          column_id: "${ROUTE_STOPS_DRIVER_COLUMN}",
          value: ${JSON.stringify(columnValue)}
        ) { id }
      }
    `);
    console.log(`Stop ${stop.id} (${stop.name}) driver updated`);
  }));
}

async function fetchStopRouteId(stopId) {
  const data = await mondayRequest(`
    query {
      items(ids: [${stopId}]) {
        column_values(ids: ["${ROUTE_STOPS_ROUTE_COLUMN}"]) {
          id value
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }
  `);

  const col = data.items[0]?.column_values?.find(c => c.id === ROUTE_STOPS_ROUTE_COLUMN);
  if (col?.linked_item_ids?.length) return col.linked_item_ids[0];
  if (col?.value) {
    try {
      const p = JSON.parse(col.value);
      if (p.linkedPulseIds?.length) return p.linkedPulseIds[0].linkedPulseId;
      if (Array.isArray(p) && p.length) return p[0].id;
    } catch (e) {}
  }
  return null;
}

async function updateStopDriver(stopId, driverIds) {
  const ROUTE_STOPS_DRIVER_COLUMN = 'board_relation_mm3va52r';
  await mondayRequest(`
    mutation {
      change_column_value(
        item_id: ${stopId},
        board_id: ${ROUTE_STOPS_BOARD_ID},
        column_id: "${ROUTE_STOPS_DRIVER_COLUMN}",
        value: ${JSON.stringify(JSON.stringify({ item_ids: driverIds }))}
      ) { id }
    }
  `);
  console.log(`Stop ${stopId} driver updated`);
}
