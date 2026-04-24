// /api/sync-appointments.js
// Vercel serverless function — pulls upcoming bookings from Square, writes to jsonbin
// Runs daily via Vercel Cron (see vercel.json)
// Manual trigger: visit https://leadground.vercel.app/api/sync-appointments
//
// FEATURES:
//  - Pulls upcoming bookings from Square for Idaho location
//  - Resolves customer names, service names, lead sources via Square API
//  - Handles multi-segment appointments (bundled services)
//  - Caches lookups in jsonbin to minimize Square API calls
//  - Estimates value using (a) catalog prices when available, then
//    (b) historical averages from completed jobs, then (c) $0
//  - Flags whether each value is actual or estimated via Is Estimated boolean
//  - Re-fetches cached customers whose leadSource is "Unknown" for up to 7 days,
//    so customer group changes in Square propagate automatically

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";
const JSONBIN_BIN_ID = "69e3fe8a856a6821894b16fe";
const JSONBIN_MASTER_KEY = "$2a$10$qO.v2e/pmWupbGZ4QEk.heEUW2xxSOxb1yw.rfksRY9Rzv8xJvBo6";
const UNKNOWN_RECHECK_DAYS = 7;

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

function median(nums) {
  if (!nums || nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildHistoricalAverages(jobs) {
  const byService = {};
  for (const j of jobs) {
    const svc = j["Service"];
    const amt = Number(j["Payment Amount"]) || 0;
    if (!svc || amt <= 0) continue;
    if (!byService[svc]) byService[svc] = [];
    byService[svc].push(amt);
  }
  const averages = {};
  for (const svc of Object.keys(byService)) {
    const amounts = byService[svc];
    averages[svc] = {
      median: Math.round(median(amounts)),
      sampleSize: amounts.length,
    };
  }
  return averages;
}

// Decide whether a cached customer record should be re-fetched from Square
// Returns true if cached leadSource is "Unknown" AND we haven't given up on them yet
function shouldRecheckUnknownCustomer(cached) {
  if (!cached) return true; // no cache = must fetch
  if ((cached.leadSource || "Unknown") !== "Unknown") return false; // has a real source, stay cached
  // leadSource is Unknown. Recheck unless we've been checking for 7+ days.
  if (!cached.cachedAt) return true; // legacy entry with no timestamp = recheck once
  const cachedDate = new Date(cached.cachedAt);
  if (isNaN(cachedDate)) return true;
  const daysSince = (Date.now() - cachedDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince < UNKNOWN_RECHECK_DAYS;
}

async function resolveService(serviceVarId, lookups, token, logStep, squareCallCounter) {
  if (!serviceVarId) return { name: "", price: 0 };
  if (lookups.services[serviceVarId]) {
    return {
      name: lookups.services[serviceVarId].name,
      price: lookups.services[serviceVarId].price || 0,
    };
  }
  try {
    const catData = await squareGet(`/v2/catalog/object/${serviceVarId}`, token);
    squareCallCounter.count++;
    const obj = catData.object || {};
    const variation = obj.item_variation_data || {};
    let name = variation.name || serviceVarId;

    const parentItemId = variation.item_id;
    if (parentItemId) {
      try {
        const parentData = await squareGet(`/v2/catalog/object/${parentItemId}`, token);
        squareCallCounter.count++;
        const parent = parentData.object || {};
        const parentName = (parent.item_data && parent.item_data.name) || "";
        if (parentName) {
          if (variation.name && variation.name.toLowerCase() !== "regular") {
            name = `${parentName} — ${variation.name}`;
          } else {
            name = parentName;
          }
        }
      } catch (e) { /* parent fetch optional */ }
    }

    const priceMoney = variation.price_money || {};
    const price = priceMoney.amount ? Math.round(priceMoney.amount / 100) : 0;

    lookups.services[serviceVarId] = { name, price };
    logStep(`  Cached new service: ${name} ($${price})`);
    return { name, price };
  } catch (e) {
    logStep(`  WARNING: could not fetch service ${serviceVarId}: ${e.message}`);
    return { name: serviceVarId, price: 0 };
  }
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const log = [];
  const logStep = (msg) => { console.log(msg); log.push(msg); };
  const squareCallCounter = { count: 0 };

  try {
    const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    if (!SQUARE_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN env var is not set in Vercel");
    }

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
      customers: {}, services: {}, groups: {},
    };
    if (!lookups.customers) lookups.customers = {};
    if (!lookups.services) lookups.services = {};
    if (!lookups.groups) lookups.groups = {};

    logStep(`Preserved ${existingJobs.length} jobs. Cache: ${Object.keys(lookups.customers).length} customers, ${Object.keys(lookups.services).length} services, ${Object.keys(lookups.groups).length} groups.`);

    const historicalAverages = buildHistoricalAverages(existingJobs);
    logStep(`Built historical averages for ${Object.keys(historicalAverages).length} services.`);

    // === Step 2: Fetch upcoming bookings from Square ===
    logStep("Fetching bookings from Square...");
    const startAtMin = new Date().toISOString();
    const bookingsData = await squareGet(
      `/v2/bookings?location_id=${SQUARE_LOCATION_ID}&limit=200&start_at_min=${encodeURIComponent(startAtMin)}`,
      SQUARE_TOKEN
    );
    squareCallCounter.count++;
    const bookings = bookingsData.bookings || [];
    logStep(`Square returned ${bookings.length} bookings`);

    // === Step 3: Refresh customer groups cache ===
    try {
      const groupsData = await squareGet(`/v2/customers/groups`, SQUARE_TOKEN);
      squareCallCounter.count++;
      const groups = groupsData.groups || [];
      lookups.groups = {};
      for (const g of groups) {
        lookups.groups[g.id] = g.name;
      }
      logStep(`Refreshed groups cache: ${groups.length} groups`);
    } catch (e) {
      logStep(`WARNING: could not refresh groups (${e.message}). Using cached values.`);
    }

    // === Step 4: Process each booking ===
    const appointments = [];
    const activeBookings = bookings.filter(b => {
      const status = (b.status || "").toLowerCase();
      return status !== "cancelled_by_customer"
          && status !== "cancelled_by_seller"
          && status !== "declined"
          && status !== "no_show";
    });
    logStep(`Processing ${activeBookings.length} active bookings...`);
    const todayStamp = new Date().toISOString().substring(0, 10); // YYYY-MM-DD

    for (const b of activeBookings) {
      const customerId = b.customer_id || "";
      const segments = b.appointment_segments || [];

      // --- Resolve customer ---
      let customerName = customerId;
      let leadSource = "Unknown";
      if (customerId) {
        const cached = lookups.customers[customerId];
        const needsRecheck = shouldRecheckUnknownCustomer(cached);

        if (cached && !needsRecheck) {
          // Use cache as-is (either has a real lead source, or we gave up after 7 days)
          customerName = cached.name;
          leadSource = cached.leadSource || "Unknown";
        } else {
          // Either not cached, or cached as Unknown and still within recheck window
          try {
            const custData = await squareGet(`/v2/customers/${customerId}`, SQUARE_TOKEN);
            squareCallCounter.count++;
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

            // Preserve cachedAt if we already had one from a previous run,
            // so the 7-day clock keeps running across reruns.
            const cachedAt = (cached && cached.cachedAt) ? cached.cachedAt : todayStamp;
            lookups.customers[customerId] = { name: customerName, leadSource, cachedAt };
            if (cached) {
              logStep(`  Rechecked ${customerName}: leadSource = "${leadSource}"`);
            } else {
              logStep(`  Cached new customer: ${customerName} (${leadSource})`);
            }
          } catch (e) {
            logStep(`  WARNING: could not fetch customer ${customerId}: ${e.message}`);
            if (cached) {
              // Fall back to cached values if fetch failed
              customerName = cached.name;
              leadSource = cached.leadSource || "Unknown";
            }
          }
        }
      }

      // --- Resolve ALL segments ---
      const resolvedSegments = [];
      let catalogTotal = 0;
      for (const seg of segments) {
        const svcId = seg.service_variation_id;
        if (!svcId) continue;
        const resolved = await resolveService(svcId, lookups, SQUARE_TOKEN, logStep, squareCallCounter);
        resolvedSegments.push(resolved);
        catalogTotal += resolved.price;
      }

      // --- Build combined service name ---
      let serviceName = "";
      if (resolvedSegments.length === 0) {
        serviceName = "";
      } else if (resolvedSegments.length === 1) {
        serviceName = resolvedSegments[0].name;
      } else {
        serviceName = resolvedSegments.map(s => s.name).join(" + ");
      }

      // --- Compute estimated value ---
      let estimatedValue = 0;
      let isEstimated = false;
      let estimateSource = "none";

      if (catalogTotal > 0) {
        estimatedValue = catalogTotal;
        isEstimated = false;
        estimateSource = "catalog";
      } else if (resolvedSegments.length > 0) {
        const primary = resolvedSegments[0].name;
        let hist = historicalAverages[primary];
        if (!hist) {
          const primaryLower = primary.toLowerCase();
          for (const [svc, data] of Object.entries(historicalAverages)) {
            if (svc.toLowerCase() === primaryLower) { hist = data; break; }
          }
        }
        if (!hist) {
          const primaryLower = primary.toLowerCase();
          for (const [svc, data] of Object.entries(historicalAverages)) {
            const svcLower = svc.toLowerCase();
            if (primaryLower.includes(svcLower) || svcLower.includes(primaryLower)) {
              hist = data;
              break;
            }
          }
        }
        if (hist && hist.median > 0) {
          estimatedValue = hist.median;
          isEstimated = true;
          estimateSource = `historical (n=${hist.sampleSize})`;
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
        "Is Estimated": isEstimated,
        "Estimate Source": estimateSource,
        "Status": (b.status || "").toLowerCase(),
      });
    }

    logStep(`Built ${appointments.length} appointment records using ${squareCallCounter.count} Square API calls.`);

    // === Step 5: Write combined data back to jsonbin ===
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
      squareApiCalls: squareCallCounter.count,
      cacheStats: {
        customers: Object.keys(lookups.customers).length,
        services: Object.keys(lookups.services).length,
        groups: Object.keys(lookups.groups).length,
      },
      historicalAveragesBuilt: Object.keys(historicalAverages).length,
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
