// /api/sync-appointments.js
// Vercel serverless function — pulls upcoming bookings from Square, writes to jsonbin
// Runs daily via Vercel Cron (see vercel.json)
// Manual trigger: visit https://leadground.vercel.app/api/sync-appointments
//
// PASS 2: Resolves customer names, service names, lead sources, and pricing via Square APIs.
// Uses a "lookups" cache stored in jsonbin to avoid redundant Square API calls.

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";
const JSONBIN_BIN_ID = "69e3fe8a856a6821894b16fe";
const JSONBIN_MASTER_KEY = "$2a$10$qO.v2e/pmWupbGZ4QEk.heEUW2xxSOxb1yw.rfksRY9Rzv8xJvBo6";

// Helper: call Square API
async function squareGet(path, token) {
  const url = `https://connect.squareup.com${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Square-Version": SQUARE_API_VERSION,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Square ${path} failed (${res.status}): ${errText}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const log = [];
  const logStep = (msg) => { console.log(msg); log.push(msg); };

  try {
    const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    if (!SQUARE_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN env var is not set in Vercel");
    }

    let squareCallCount = 0;

    // === Step 1: Read existing data + lookups cache from jsonbin ===
    logStep("Reading existing data from jsonbin...");
    const binReadUrl = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
    const binReadRes = await fetch(binReadUrl, {
      headers: { "X-Bin-Meta": "false" },
    });
    if (!binReadRes.ok) {
      throw new Error(`jsonbin read failed (${binReadRes.status})`);
    }
    const existingData = await binReadRes.json();
    const existingJobs = Array.isArray(existingData) ? existingData : (existingData.jobs || []);
    const lookups = (existingData && existingData.lookups) || {
      customers: {},
      services: {},
      groups: {},
    };
    if (!lookups.customers) lookups.customers = {};
    if (!lookups.services) lookups.services = {};
    if (!lookups.groups) lookups.groups = {};

    logStep(`Preserved ${existingJobs.length} jobs. Cache: ${Object.keys(lookups.customers).length} customers, ${Object.keys(lookups.services).length} services, ${Object.keys(lookups.groups).length} groups.`);

    // === Step 2: Fetch upcoming bookings from Square ===
    logStep("Fetching bookings from Square...");
    const startAtMin = new Date().toISOString();
    const bookingsData = await squareGet(
      `/v2/bookings?location_id=${SQUARE_LOCATION_ID}&limit=200&start_at_min=${encodeURIComponent(startAtMin)}`,
      SQUARE_TOKEN
    );
    squareCallCount++;
    const bookings = bookingsData.bookings || [];
    logStep(`Square returned ${bookings.length} bookings`);

    // === Step 3: Refresh customer groups cache (1 call, returns all groups) ===
    try {
      const groupsData = await squareGet(`/v2/customers/groups`, SQUARE_TOKEN);
      squareCallCount++;
      const groups = groupsData.groups || [];
      lookups.groups = {};
      for (const g of groups) {
        lookups.groups[g.id] = g.name;
      }
      logStep(`Refreshed groups cache: ${groups.length} groups`);
    } catch (e) {
      logStep(`WARNING: could not refresh groups (${e.message}). Using cached values.`);
    }

    // === Step 4: For each booking, resolve customer + service from cache or Square ===
    const appointments = [];
    const activeBookings = bookings.filter(b => {
      const status = (b.status || "").toLowerCase();
      return status !== "cancelled_by_customer"
          && status !== "cancelled_by_seller"
          && status !== "declined"
          && status !== "no_show";
    });
    logStep(`Processing ${activeBookings.length} active bookings...`);

    for (const b of activeBookings) {
      const segment = (b.appointment_segments && b.appointment_segments[0]) || {};
      const customerId = b.customer_id || "";
      const serviceVarId = segment.service_variation_id || "";

      // --- Resolve customer ---
      let customerName = customerId;
      let leadSource = "Unknown";
      if (customerId) {
        if (lookups.customers[customerId]) {
          customerName = lookups.customers[customerId].name;
          leadSource = lookups.customers[customerId].leadSource || "Unknown";
        } else {
          try {
            const custData = await squareGet(`/v2/customers/${customerId}`, SQUARE_TOKEN);
            squareCallCount++;
            const c = custData.customer || {};
            const first = c.given_name || "";
            const last = c.family_name || "";
            customerName = (first + " " + last).trim() || c.company_name || customerId;

            const custGroupIds = c.group_ids || [];
            for (const gid of custGroupIds) {
              if (lookups.groups[gid]) {
                leadSource = lookups.groups[gid];
                break;
              }
            }

            lookups.customers[customerId] = { name: customerName, leadSource };
            logStep(`  Cached new customer: ${customerName}`);
          } catch (e) {
            logStep(`  WARNING: could not fetch customer ${customerId}: ${e.message}`);
          }
        }
      }

      // --- Resolve service variation ---
      let serviceName = serviceVarId;
      let estimatedValue = 0;
      if (serviceVarId) {
        if (lookups.services[serviceVarId]) {
          serviceName = lookups.services[serviceVarId].name;
          estimatedValue = lookups.services[serviceVarId].price || 0;
        } else {
          try {
            const catData = await squareGet(`/v2/catalog/object/${serviceVarId}`, SQUARE_TOKEN);
            squareCallCount++;
            const obj = catData.object || {};
            const variation = obj.item_variation_data || {};
            serviceName = variation.name || serviceVarId;

            const parentItemId = variation.item_id;
            if (parentItemId) {
              try {
                const parentData = await squareGet(`/v2/catalog/object/${parentItemId}`, SQUARE_TOKEN);
                squareCallCount++;
                const parent = parentData.object || {};
                const parentName = (parent.item_data && parent.item_data.name) || "";
                if (parentName) {
                  if (variation.name && variation.name.toLowerCase() !== "regular") {
                    serviceName = `${parentName} — ${variation.name}`;
                  } else {
                    serviceName = parentName;
                  }
                }
              } catch (e) { /* parent fetch optional */ }
            }

            const priceMoney = variation.price_money || {};
            if (priceMoney.amount) {
              estimatedValue = Math.round(priceMoney.amount / 100);
            }

            lookups.services[serviceVarId] = { name: serviceName, price: estimatedValue };
            logStep(`  Cached new service: ${serviceName} ($${estimatedValue})`);
          } catch (e) {
            logStep(`  WARNING: could not fetch service ${serviceVarId}: ${e.message}`);
          }
        }
      }

      // --- Format date/time in Mountain Time ---
      const startAt = b.start_at || "";
      const date = startAt.substring(0, 10);
      let displayTime = "";
      if (startAt) {
        try {
          const d = new Date(startAt);
          displayTime = d.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "America/Denver",
          });
        } catch (e) {
          displayTime = startAt.substring(11, 16);
        }
      }

      appointments.push({
        "Appointment ID": b.id || "",
        "Date": date,
        "Time": displayTime,
        "Customer Name": customerName,
        "Service": serviceName,
        "Lead Source": leadSource,
        "Estimated Value": estimatedValue,
        "Status": (b.status || "").toLowerCase(),
      });
    }

    logStep(`Built ${appointments.length} appointment records using ${squareCallCount} Square API calls.`);

    // === Step 5: Write combined data + updated cache back to jsonbin ===
    logStep("Writing combined data to jsonbin...");
    const binWriteUrl = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
    const payload = {
      jobs: existingJobs,
      appointments: appointments,
      lookups: lookups,
    };
    const binWriteRes = await fetch(binWriteUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": JSONBIN_MASTER_KEY,
      },
      body: JSON.stringify(payload),
    });
    if (!binWriteRes.ok) {
      const errText = await binWriteRes.text();
      throw new Error(`jsonbin write failed (${binWriteRes.status}): ${errText}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logStep(`Done in ${elapsed}s`);

    return res.status(200).json({
      success: true,
      jobsPreserved: existingJobs.length,
      appointmentsWritten: appointments.length,
      squareApiCalls: squareCallCount,
      cacheStats: {
        customers: Object.keys(lookups.customers).length,
        services: Object.keys(lookups.services).length,
        groups: Object.keys(lookups.groups).length,
      },
      elapsedSeconds: elapsed,
      log,
    });

  } catch (err) {
    console.error("Sync failed:", err);
    log.push(`ERROR: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      log,
    });
  }
}
