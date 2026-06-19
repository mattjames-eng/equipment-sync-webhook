const fetch = require('node-fetch');

// Vercel body parser configuration
export const config = {
  api: {
    bodyParser: true,
  },
};

// Monday.com API configuration
const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// Google Maps API configuration
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY; // Legacy Distance Matrix API (not used)
const ROUTES_V2_API_KEY = process.env.ROUTES_V2_API_KEY; // New Routes API v2

// Board IDs
const ROUTES_BOARD_ID = '18415598386';
const ROUTE_STOPS_BOARD_ID = '18415570592';
const CONTACTS_COMPANIES_BOARD_ID = '18415573401';

// Column IDs - Routes Board
const ROUTES_START_LOCATION_COLUMN = 'board_relation_mm4dfw6d'; // Route Start Location
const ROUTES_END_LOCATION_COLUMN = 'board_relation_mm4d795a';   // Route End Location
const ROUTES_TOTAL_DISTANCE_COLUMN = 'numeric_mm3wwt5j';        // Total Distance on Routes
const ROUTES_TOTAL_DRIVE_TIME_COLUMN = 'numeric_mm3wens3';      // Total Drive Time on Routes

// Column IDs - Route Stops Board
const ROUTE_STOPS_ROUTE_COLUMN = 'board_relation_mm3w48fh';     // Route connection on Route Stops
const ROUTE_STOPS_LOCATION_COLUMN = 'board_relation_mm3vn6yb';  // Location connection
const ROUTE_STOPS_DATE_COLUMN = 'date_mm3v2kz1';                // Date for sorting
const ROUTE_STOPS_TIME_COLUMN = 'hour_mm3ws9gq';                // Time for sorting
const ROUTE_STOPS_DISTANCE_COLUMN = 'numeric_mm4eq22c';         // Distance to Next Stop
const ROUTE_STOPS_DRIVE_TIME_COLUMN = 'numeric_mm4ezw83';       // Drive Time to Next Stop

/**
 * Main handler for route mileage calculation webhook
 */
module.exports = async (req, res) => {
  console.log('Route Mileage Calculation webhook triggered');
  console.log('Method:', req.method);
  console.log('Body:', req.body);

  // Handle Monday webhook challenge validation
  if (req.method === 'POST' && req.body && req.body.challenge) {
    console.log('Responding to Monday challenge:', req.body.challenge);
    return res.status(200).json({ challenge: req.body.challenge });
  }

  // Handle GET requests for basic validation
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  // Parse body if it's not already parsed
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

    if (!event) {
      return res.status(400).json({ error: 'Missing event data in webhook payload' });
    }

    const routeId = event.pulseId;

    if (!routeId) {
      return res.status(400).json({ error: 'Missing routeId in webhook payload' });
    }

    console.log(`Calculating mileage for Route: ${routeId}`);

    // Step 1: Fetch Route details (start/end locations)
    const routeDetails = await fetchRouteDetails(routeId);
    console.log('Route details fetched:', routeDetails);

    // Step 2: Fetch all Route Stops for this route
    const routeStops = await fetchRouteStops(routeId);
    console.log(`Found ${routeStops.length} route stops`);

    if (routeStops.length === 0) {
      return res.status(200).json({ message: 'No route stops found for this route', routeId });
    }

    // Step 3: Sort route stops by date and time
    const sortedStops = sortRouteStops(routeStops);
    console.log('Route stops sorted by date/time');

    // Step 4: Fetch location addresses for route stops
    const stopsWithAddresses = await enrichStopsWithAddresses(sortedStops);
    console.log('Addresses fetched for all stops');

    // Step 5: Fetch start and end location addresses
    const startLocation = await fetchLocationAddress(routeDetails.startLocationId);
    const endLocation = await fetchLocationAddress(routeDetails.endLocationId);
    console.log('Start location:', startLocation);
    console.log('End location:', endLocation);

    // Step 6: Build complete route sequence
    const completeRoute = buildCompleteRoute(startLocation, stopsWithAddresses, endLocation);
    console.log(`Complete route built with ${completeRoute.length} waypoints`);

    // Step 7: Calculate distances and drive times between consecutive waypoints
    const calculations = await calculateDistancesAndTimes(completeRoute);
    console.log('Distances and times calculated');

    // Step 8: Update each Route Stop with distance/time to next stop
    await updateRouteStops(calculations);
    console.log('Route stops updated with distance/time data');

    // Step 9: Calculate totals and update the Route
    const totals = calculateTotals(calculations);
    await updateRouteTotals(routeId, totals);
    console.log(`Route totals updated: ${totals.totalDistance} miles, ${totals.totalDriveTime} hours`);

    return res.status(200).json({
      success: true,
      message: 'Route mileage calculated successfully',
      routeId,
      stopsProcessed: routeStops.length,
      totalDistance: totals.totalDistance,
      totalDriveTime: totals.totalDriveTime
    });

  } catch (error) {
    console.error('Error calculating route mileage:', error);
    return res.status(500).json({ error: 'Failed to calculate route mileage', details: error.message });
  }
};

/**
 * Fetch Route details including start and end locations
 */
async function fetchRouteDetails(routeId) {
  const query = `
    query {
      items(ids: [${routeId}]) {
        id
        name
        column_values {
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

  const route = data.data.items[0];
  const columnData = {};
  route.column_values.forEach(col => {
    columnData[col.id] = {
      value: col.value ? JSON.parse(col.value) : null,
      text: col.text,
      linked_item_ids: col.linked_item_ids || null
    };
  });

  console.log('Start Location Column:', JSON.stringify(columnData[ROUTES_START_LOCATION_COLUMN]));
  console.log('End Location Column:', JSON.stringify(columnData[ROUTES_END_LOCATION_COLUMN]));

  // ✅ Fix 1: check linked_item_ids (GraphQL fragment) first — most reliable
  const getLinkedId = (colData) => {
    if (!colData) {
      console.log('getLinkedId: colData is null/undefined');
      return null;
    }

    if (colData.linked_item_ids && colData.linked_item_ids.length > 0) {
      console.log('Using Format 0 (linked_item_ids)');
      return colData.linked_item_ids[0];
    }

    const columnValue = colData.value;
    if (!columnValue) {
      console.log('getLinkedId: value is null/undefined');
      return null;
    }

    console.log('getLinkedId input value:', JSON.stringify(columnValue));

    if (columnValue.linkedPulseIds && columnValue.linkedPulseIds.length > 0) {
      console.log('Using Format 1 (linkedPulseIds)');
      return columnValue.linkedPulseIds[0].linkedPulseId;
    }

    if (Array.isArray(columnValue) && columnValue.length > 0) {
      console.log('Using Format 2 (direct array)');
      return columnValue[0].id;
    }

    console.log('No matching format found');
    return null;
  };

  return {
    id: route.id,
    name: route.name,
    startLocationId: getLinkedId(columnData[ROUTES_START_LOCATION_COLUMN]),
    endLocationId: getLinkedId(columnData[ROUTES_END_LOCATION_COLUMN])
  };
}

/**
 * Fetch all Route Stops for a given route
 */
async function fetchRouteStops(routeId) {
  const itemsQuery = `
    query {
      boards(ids: [${ROUTE_STOPS_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: ["${ROUTE_STOPS_ROUTE_COLUMN}", "${ROUTE_STOPS_LOCATION_COLUMN}", "${ROUTE_STOPS_DATE_COLUMN}", "${ROUTE_STOPS_TIME_COLUMN}"]) {
              id
              value
              text
              ... on BoardRelationValue {
                linked_item_ids
                linked_items {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const itemsResponse = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_TOKEN },
    body: JSON.stringify({ query: itemsQuery })
  });

  const itemsData = await itemsResponse.json();
  if (itemsData.errors) throw new Error(`Monday API error fetching items: ${JSON.stringify(itemsData.errors)}`);

  const allItems = itemsData.data.boards[0].items_page.items;
  console.log(`Fetched full data for ${allItems.length} items`);

  const filteredItems = allItems.filter(item => {
    const routeColumn = item.column_values.find(col => col.id === ROUTE_STOPS_ROUTE_COLUMN);

    console.log(`\n--- Checking item ${item.id} (${item.name}) ---`);
    console.log('Route column found:', !!routeColumn);
    console.log('Route column full object:', JSON.stringify(routeColumn, null, 2));

    if (!routeColumn) {
      console.log('No route column found');
      return false;
    }

    if (routeColumn.linked_item_ids) {
      console.log('Using linked_item_ids:', routeColumn.linked_item_ids);
      const match = routeColumn.linked_item_ids.some(id => id.toString() === routeId.toString());
      console.log('Match result:', match);
      return match;
    }

    console.log('Route column value (raw):', routeColumn.value);
    console.log('Route column text:', routeColumn.text);

    if (!routeColumn.value) {
      console.log('Route column value is null/empty');
      return false;
    }

    try {
      const parsedValue = JSON.parse(routeColumn.value);
      console.log('Parsed value:', JSON.stringify(parsedValue, null, 2));
      console.log('Looking for routeId:', routeId);

      if (parsedValue.linkedPulseIds) {
        console.log('Format 1: linkedPulseIds array detected');
        const match = parsedValue.linkedPulseIds.some(link => {
          console.log(`  Comparing ${link.linkedPulseId} === ${routeId}`);
          return link.linkedPulseId.toString() === routeId.toString();
        });
        console.log('Match result:', match);
        return match;
      }

      if (Array.isArray(parsedValue)) {
        console.log('Format 2: Direct array detected');
        const match = parsedValue.some(link => {
          console.log(`  Comparing ${link.id} === ${routeId}`);
          return link.id && link.id.toString() === routeId.toString();
        });
        console.log('Match result:', match);
        return match;
      }

      console.log('No recognized format found');
      return false;
    } catch (e) {
      console.error(`Error parsing route column for item ${item.id}:`, e);
      return false;
    }
  });

  console.log(`Found ${filteredItems.length} route stops connected to Route ${routeId}`);

  if (filteredItems.length > 0) {
    const firstItem = filteredItems[0];
    const routeCol = firstItem.column_values.find(c => c.id === ROUTE_STOPS_ROUTE_COLUMN);
    console.log('Sample route column value:', routeCol?.value);
  }

  const getLinkedId = (columnData) => {
    if (!columnData) return null;

    if (columnData.linked_item_ids && columnData.linked_item_ids.length > 0) {
      return columnData.linked_item_ids[0];
    }

    const columnValue = columnData.value;
    if (!columnValue) return null;

    if (columnValue.linkedPulseIds && columnValue.linkedPulseIds.length > 0) {
      return columnValue.linkedPulseIds[0].linkedPulseId;
    }

    if (Array.isArray(columnValue) && columnValue.length > 0) {
      return columnValue[0].id;
    }

    return null;
  };

  return filteredItems.map(item => {
    const columnData = {};
    item.column_values.forEach(col => {
      columnData[col.id] = {
        value: col.value ? JSON.parse(col.value) : null,
        text: col.text,
        linked_item_ids: col.linked_item_ids || null
      };
    });

    return {
      id: item.id,
      name: item.name,
      date: columnData[ROUTE_STOPS_DATE_COLUMN]?.text || '',
      time: columnData[ROUTE_STOPS_TIME_COLUMN]?.text || '',
      locationId: getLinkedId(columnData[ROUTE_STOPS_LOCATION_COLUMN]),
      columns: columnData
    };
  });
}

/**
 * Sort route stops by date and time
 */
function sortRouteStops(stops) {
  return stops.sort((a, b) => {
    const dateTimeA = new Date(`${a.date} ${a.time}`);
    const dateTimeB = new Date(`${b.date} ${b.time}`);
    return dateTimeA - dateTimeB;
  });
}

/**
 * Fetch address for a single location
 */
async function fetchLocationAddress(locationId) {
  if (!locationId) return null;

  const query = `
    query {
      items(ids: [${locationId}]) {
        id
        name
        column_values {
          id
          value
          text
          type
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
  if (data.errors) throw new Error(`Monday API error fetching location: ${JSON.stringify(data.errors)}`);

  const location = data.data.items[0];
  const addressCol = location.column_values.find(c => c.id === 'long_text_mm3vkzc6');

  return {
    id: location.id,
    name: location.name,
    address: addressCol?.text || location.name
  };
}

/**
 * Fetch addresses for all route stop locations
 */
async function enrichStopsWithAddresses(stops) {
  const locationIds = stops.map(stop => stop.locationId).filter(id => id !== null);

  if (locationIds.length === 0) {
    throw new Error('No locations found for route stops');
  }

  const query = `
    query {
      items(ids: [${locationIds.join(', ')}]) {
        id
        name
        column_values {
          id
          value
          text
          type
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
  if (data.errors) throw new Error(`Monday API error fetching locations: ${JSON.stringify(data.errors)}`);

  const locationMap = {};
  data.data.items.forEach(item => {
    const addressCol = item.column_values.find(c => c.id === 'long_text_mm3vkzc6');
    locationMap[item.id] = {
      name: item.name,
      address: addressCol?.text || item.name
    };
  });

  return stops.map(stop => ({
    ...stop,
    locationName: locationMap[stop.locationId]?.name || 'Unknown',
    address: locationMap[stop.locationId]?.address || 'Unknown'
  }));
}

/**
 * Build complete route sequence: Start → Stops → End
 */
function buildCompleteRoute(startLocation, stops, endLocation) {
  const route = [];

  if (startLocation) {
    route.push({
      id: 'start',
      name: startLocation.name,
      locationName: startLocation.name,
      address: startLocation.address,
      isStartLocation: true
    });
  }

  stops.forEach(stop => route.push(stop));

  if (endLocation) {
    route.push({
      id: 'end',
      name: endLocation.name,
      locationName: endLocation.name,
      address: endLocation.address,
      isEndLocation: true
    });
  }

  return route;
}

/**
 * Calculate distances and drive times using Google Routes API v2
 */
async function calculateDistancesAndTimes(waypoints) {
  const calculations = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const origin = waypoints[i];
    const destination = waypoints[i + 1];

    console.log(`Calculating distance: ${origin.locationName} → ${destination.locationName}`);

    const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';
    const requestBody = {
      origin: { address: origin.address },
      destination: { address: destination.address },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: false,
      units: 'IMPERIAL'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': ROUTES_V2_API_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      console.error(`Google Routes API error:`, data);
      if (!origin.isStartLocation && !origin.isEndLocation) {
        calculations.push({ stopId: origin.id, distanceToNext: 0, driveTimeToNext: 0, error: 'NO_ROUTE_FOUND' });
      }
      continue;
    }

    const route = data.routes[0];
    const distanceMiles = (route.distanceMeters / 1609.34).toFixed(1);
    const driveTimeHours = (parseInt(route.duration.replace('s', '')) / 3600).toFixed(2);

    if (!origin.isStartLocation && !origin.isEndLocation) {
      calculations.push({
        stopId: origin.id,
        distanceToNext: parseFloat(distanceMiles),
        driveTimeToNext: parseFloat(driveTimeHours)
      });
    }

    console.log(`  → ${distanceMiles} miles, ${driveTimeHours} hours`);
  }

  // ✅ Fix 2: only add a trailing 0 if there's NO end location (last stop is true terminus)
  // When an end location exists, the last stop's leg was already calculated in the loop above
  const lastWaypoint = waypoints[waypoints.length - 1];
  if (!lastWaypoint.isEndLocation && !lastWaypoint.isStartLocation) {
    calculations.push({ stopId: lastWaypoint.id, distanceToNext: 0, driveTimeToNext: 0 });
  }

  return calculations;
}

/**
 * Update Route Stops with distance and drive time to next stop
 */
async function updateRouteStops(calculations) {
  for (const calc of calculations) {
    const mutation = `
      mutation {
        change_multiple_column_values(
          item_id: ${calc.stopId},
          board_id: ${ROUTE_STOPS_BOARD_ID},
          column_values: "{\\"${ROUTE_STOPS_DISTANCE_COLUMN}\\": \\"${calc.distanceToNext}\\", \\"${ROUTE_STOPS_DRIVE_TIME_COLUMN}\\": \\"${calc.driveTimeToNext}\\"}"
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
      console.error(`Failed to update stop ${calc.stopId}:`, data.errors);
    }
  }
}

/**
 * Calculate total distance and drive time
 */
function calculateTotals(calculations) {
  const totalDistance = calculations.reduce((sum, calc) => sum + calc.distanceToNext, 0);
  const totalDriveTime = calculations.reduce((sum, calc) => sum + calc.driveTimeToNext, 0);

  return {
    totalDistance: totalDistance.toFixed(1),
    totalDriveTime: totalDriveTime.toFixed(2)
  };
}

/**
 * Update Route with total distance and drive time
 */
async function updateRouteTotals(routeId, totals) {
  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${routeId},
        board_id: ${ROUTES_BOARD_ID},
        column_values: "{\\"${ROUTES_TOTAL_DISTANCE_COLUMN}\\": \\"${totals.totalDistance}\\", \\"${ROUTES_TOTAL_DRIVE_TIME_COLUMN}\\": \\"${totals.totalDriveTime}\\"}"
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
  if (data.errors) throw new Error(`Failed to update route totals: ${JSON.stringify(data.errors)}`);
}
