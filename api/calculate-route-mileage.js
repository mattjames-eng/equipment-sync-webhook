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
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Board IDs
const ROUTES_BOARD_ID = '18415598386';
const ROUTE_STOPS_BOARD_ID = '18415570592';
const CONTACTS_COMPANIES_BOARD_ID = '18415573401';

// Column IDs - Routes Board
const ROUTES_START_LOCATION_COLUMN = 'board_relation_mm4dfw6d'; // Route Start Location
const ROUTES_END_LOCATION_COLUMN = 'board_relation_mm4d795a'; // Route End Location
const ROUTES_TOTAL_DISTANCE_COLUMN = 'numeric_mm3wwt5j'; // Total Distance on Routes
const ROUTES_TOTAL_DRIVE_TIME_COLUMN = 'numeric_mm3wens3'; // Total Drive Time on Routes

// Column IDs - Route Stops Board
const ROUTE_STOPS_ROUTE_COLUMN = 'board_relation_mm3w48fh'; // Route connection on Route Stops
const ROUTE_STOPS_LOCATION_COLUMN = 'board_relation_mm3vn6yb'; // Location connection
const ROUTE_STOPS_DATE_COLUMN = 'date_mm3v2kz1'; // Date for sorting
const ROUTE_STOPS_TIME_COLUMN = 'hour_mm3ws9gq'; // Time for sorting
const ROUTE_STOPS_DISTANCE_COLUMN = 'numeric_mm4eq22c'; // Distance to Next Stop
const ROUTE_STOPS_DRIVE_TIME_COLUMN = 'numeric_mm4ezw83'; // Drive Time to Next Stop

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
    // Extract data from Monday's webhook format
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
      return res.status(200).json({ 
        message: 'No route stops found for this route',
        routeId
      });
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
    return res.status(500).json({ 
      error: 'Failed to calculate route mileage', 
      details: error.message 
    });
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
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }

  const route = data.data.items[0];
  const columnData = {};
  route.column_values.forEach(col => {
    columnData[col.id] = {
      value: col.value ? JSON.parse(col.value) : null,
      text: col.text
    };
  });

  return {
    id: route.id,
    name: route.name,
    startLocationId: columnData[ROUTES_START_LOCATION_COLUMN]?.value?.linkedPulseIds?.[0]?.linkedPulseId || null,
    endLocationId: columnData[ROUTES_END_LOCATION_COLUMN]?.value?.linkedPulseIds?.[0]?.linkedPulseId || null
  };
}

/**
 * Fetch all Route Stops for a given route
 */
async function fetchRouteStops(routeId) {
  const stopsQuery = `
    query {
      items_page_by_column_values(
        board_id: ${ROUTE_STOPS_BOARD_ID},
        columns: [{column_id: "${ROUTE_STOPS_ROUTE_COLUMN}", column_values: ["${routeId}"]}]
        limit: 100
      ) {
        items {
          id
          name
          column_values {
            id
            value
            text
          }
        }
      }
    }
  `;

  const stopsResponse = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN
    },
    body: JSON.stringify({ query: stopsQuery })
  });

  const stopsData = await stopsResponse.json();
  
  if (stopsData.errors) {
    throw new Error(`Monday API error fetching stops: ${JSON.stringify(stopsData.errors)}`);
  }

  const items = stopsData.data.items_page_by_column_values.items;

  // Parse column values for each stop
  return items.map(item => {
    const columnData = {};
    item.column_values.forEach(col => {
      columnData[col.id] = {
        value: col.value ? JSON.parse(col.value) : null,
        text: col.text
      };
    });

    return {
      id: item.id,
      name: item.name,
      date: columnData[ROUTE_STOPS_DATE_COLUMN]?.text || '',
      time: columnData[ROUTE_STOPS_TIME_COLUMN]?.text || '',
      locationId: columnData[ROUTE_STOPS_LOCATION_COLUMN]?.value?.linkedPulseIds?.[0]?.linkedPulseId || null,
      columns: columnData
    };
  });
}

/**
 * Sort route stops by date and time
 */
function sortRouteStops(stops) {
  return stops.sort((a, b) => {
    // Combine date and time for comparison
    const dateTimeA = new Date(`${a.date} ${a.time}`);
    const dateTimeB = new Date(`${b.date} ${b.time}`);
    return dateTimeA - dateTimeB;
  });
}

/**
 * Fetch address for a single location
 */
async function fetchLocationAddress(locationId) {
  if (!locationId) {
    return null;
  }

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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Monday API error fetching location: ${JSON.stringify(data.errors)}`);
  }

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
  const locationIds = stops
    .map(stop => stop.locationId)
    .filter(id => id !== null);

  if (locationIds.length === 0) {
    throw new Error('No locations found for route stops');
  }

  // Fetch all locations in one query
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Monday API error fetching locations: ${JSON.stringify(data.errors)}`);
  }

  // Build a map of location ID to address
  const locationMap = {};
  data.data.items.forEach(item => {
    // Find address column (long_text_mm3vkzc6)
    const addressCol = item.column_values.find(c => c.id === 'long_text_mm3vkzc6');
    locationMap[item.id] = {
      name: item.name,
      address: addressCol?.text || item.name // Fallback to name if no address
    };
  });

  // Enrich stops with addresses
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

  // Add start location if it exists
  if (startLocation) {
    route.push({
      id: 'start',
      name: startLocation.name,
      locationName: startLocation.name,
      address: startLocation.address,
      isStartLocation: true
    });
  }

  // Add all route stops
  stops.forEach(stop => {
    route.push(stop);
  });

  // Add end location if it exists
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
 * Calculate distances and drive times using Google Maps Distance Matrix API
 */
async function calculateDistancesAndTimes(waypoints) {
  const calculations = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const origin = waypoints[i];
    const destination = waypoints[i + 1];

    console.log(`Calculating distance: ${origin.locationName} → ${destination.locationName}`);

    // Call Google Maps Distance Matrix API
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin.address)}&destinations=${encodeURIComponent(destination.address)}&units=imperial&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      console.error(`Google Maps API error: ${data.status}`);
      // Skip start/end locations in calculations array (they don't get updated)
      if (!origin.isStartLocation && !origin.isEndLocation) {
        calculations.push({
          stopId: origin.id,
          distanceToNext: 0,
          driveTimeToNext: 0,
          error: data.status
        });
      }
      continue;
    }

    const element = data.rows[0].elements[0];

    if (element.status !== 'OK') {
      console.error(`Route calculation error: ${element.status}`);
      // Skip start/end locations in calculations array
      if (!origin.isStartLocation && !origin.isEndLocation) {
        calculations.push({
          stopId: origin.id,
          distanceToNext: 0,
          driveTimeToNext: 0,
          error: element.status
        });
      }
      continue;
    }

    // Extract distance in miles and time in hours
    const distanceMiles = (element.distance.value / 1609.34).toFixed(1); // meters to miles
    const driveTimeHours = (element.duration.value / 3600).toFixed(2); // seconds to hours

    // Only add to calculations if this is a route stop (not start/end location)
    if (!origin.isStartLocation && !origin.isEndLocation) {
      calculations.push({
        stopId: origin.id,
        distanceToNext: parseFloat(distanceMiles),
        driveTimeToNext: parseFloat(driveTimeHours)
      });
    }

    console.log(`  → ${distanceMiles} miles, ${driveTimeHours} hours`);
  }

  // Last stop has no "next stop" (or it goes to end location, which we don't store on the stop)
  const lastStop = waypoints[waypoints.length - 2]; // Second to last (before end location)
  if (lastStop && !lastStop.isStartLocation && !lastStop.isEndLocation) {
    calculations.push({
      stopId: lastStop.id,
      distanceToNext: 0,
      driveTimeToNext: 0
    });
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_TOKEN
      },
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN
    },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Failed to update route totals: ${JSON.stringify(data.errors)}`);
  }
}
