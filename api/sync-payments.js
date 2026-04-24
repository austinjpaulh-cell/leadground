// /api/sync-payments.js
// Vercel serverless function — pulls completed payments from Square, writes to jsonbin's jobs array
// Runs daily via Vercel Cron (see vercel.json)
// Manual trigger: visit https://leadground.vercel.app/api/sync-payments
//
// Behavior:
//  - Fetches payments from Square for last 7 days (Idaho location only)
//  - Resolves each payment's order, customer, and services via Square API
//  - Stores as a "job" record matching existing jsonbin schema:
//    { Date, Customer Name, Lead Source, Service, Payment Amount, Payment ID }
//  - Service = name of the primary (first) line item
//  - Payment Amount = full invoice total in dollars (all line items + tax - discounts)
//  - Deduplicates against existing jobs by Payment ID (safe to re-run)
//  - Reuses the lookups cache populated by sync-appointments.js
//  - Re-fetches cached customers whose leadSource is "Unknown" for up to 7 days,
//    so customer group changes in Square propagate automatically

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";
const JSONBIN_BIN_ID = "69e3fe8a856a6821894b16fe";
const JSONBIN_MASTER_KEY = "$2a$10$qO.v2e/pmWupbGZ4QEk.heEUW2xxSOxb1yw.rfksRY9Rzv8xJvBo6";
const LOOKBACK_DAYS = 7;
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

// Decide whether a cached customer record should be re-fetched from Square
// Returns true if cached leadSource is "Unknown" AND we haven't given up on them yet
function shouldRecheckUnknownCustomer(cached) {
  if (!cached) return true;
  if ((cached.leadSource || "Unknown") !== "Unknown") return false;
  if (!cached.cachedAt) return true; // legacy entry = recheck once
  const cachedDate = new Date(cached.cachedAt);
  if (isNaN(cachedDate)) return true;
  const daysSince = (Date.now() - cachedDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince < UNKNOWN_RECHECK_DAYS;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const log = [];
  const logStep = (msg) => { console.log(msg); log.push(msg); };
  let squareCallCount = 0;

  try {
    const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    if (!SQUARE_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN env var is not set in Vercel");
    }

    // === Step 1: Read existing jsonbin data ===
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
    const existingAppointments = (existingData && existingData.appointments) || [];
    const lookups = (existingData && existingData.lookups) || {
      customers: {}, services: {}, groups: {},
    };
    if (!lookups.customers) lookups.customers = {};
    if (!lookups.services) lookups.services = {};
    if (!lookups.groups) lookups.groups = {};

    const existingPaymentIds = new Set(existingJobs.map(j => j["Payment ID"]).filter(Boolean));
    logStep(`Loaded ${existingJobs.length} existing jobs (${existingPaymentIds.size} with Payment IDs).`);
    logStep(`Cache: ${Object.keys(lookups.customers).length} customers, ${Object.keys(lookups.services).length} services, ${Object.keys(lookups.groups).length} groups.`);

    // === Step 2: Refresh customer groups cache ===
    try {
      const groupsData = await squareGet(`/v2/customers/groups`, SQUARE_TOKEN);
      squareCallCount++;
      const groups = groupsData.groups || [];
      lookups.groups = {};
      for (const g of groups) lookups.groups[g.id] = g.name;
      logStep(`Refreshed groups cache: ${groups.length} groups`);
    } catch (e) {
      logStep(`WARNING: could not refresh groups (${e.message}). Using cached values.`);
    }

    // === Step 3: Proactively recheck any existing Unknown-leadSource customers ===
    // This catches customers whose recent jobs are already in jsonbin but whose
    // Square group was updated after the initial cache write. Sync-payments handles
    // new payments; this block handles historical customers whose info we want to refresh.
    const unknownRecheckIds = [];
    const todayStamp = new Date().toISOString().substring(0, 10);
    for (const [cid, cached] of Object.entries(lookups.customers)) {
      if (shouldRecheckUnknownCustomer(cached)) {
        unknownRecheckIds.push(cid);
      }
    }
    if (unknownRecheckIds.length > 0) {
      logStep(`Rechecking ${unknownRecheckIds.length} Unknown-leadSource customers...`);
      for (const cid of unknownRecheckIds) {
        try {
          const custData = await squareGet(`/v2/customers/${cid}`, SQUARE_TOKEN);
          squareCallCount++;
          const c = custData.customer || {};
          const first = c.given_name || "";
          const last = c.family_name || "";
          const name = (first + " " + last).trim() || c.company_name || cid;
          let leadSource = "Unknown";
          const custGroupIds = c.group_ids || [];
          for (const gid of custGroupIds) {
            if (lookups.groups[gid]) { leadSource = lookups.groups[gid]; break; }
          }
          const existingCachedAt = (lookups.customers[cid] && lookups.customers[cid].cachedAt) || todayStamp;
          lookups.customers[cid] = { name, leadSource, cachedAt: existingCachedAt };
          // Also update any existing job records for this customer with the new lead source
          let updatedJobCount = 0;
          for (const j of existingJobs) {
            if (j["Customer Name"] === name && (j["Lead Source"] || "Unknown") === "Unknown" && leadSource !== "Unknown") {
              j["Lead Source"] = leadSource;
              updatedJobCount++;
            }
          }
          if (leadSource !== "Unknown") {
            logStep(`  ✓ ${name}: Unknown → ${leadSource}${updatedJobCount?` (updated ${updatedJobCount} existing jobs)`:""}`);
          } else {
            logStep(`  • ${name}: still Unknown`);
          }
        } catch (e) {
          logStep(`  WARNING: recheck failed for ${cid}: ${e.message}`);
        }
      }
    }

    // === Step 4: Fetch recent payments from Square ===
    logStep(`Fetching payments from last ${LOOKBACK_DAYS} days...`);
    const beginTime = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const paymentsUrl = `/v2/payments?location_id=${SQUARE_LOCATION_ID}&begin_time=${encodeURIComponent(beginTime)}&limit=100&sort_order=DESC`;
    const paymentsData = await squareGet(paymentsUrl, SQUARE_TOKEN);
    squareCallCount++;
    const allPayments = paymentsData.payments || [];
    logStep(`Square returned ${allPayments.length} payments`);

    const newPayments = allPayments.filter(p => {
      if ((p.status || "").toUpperCase() !== "COMPLETED") return false;
      if (existingPaymentIds.has(p.id)) return false;
      return true;
    });
    logStep(`${newPayments.length} new completed payments to process (${allPayments.length - newPayments.length} already in jsonbin or not completed).`);

    // === Step 5: Process each new payment ===
    const newJobs = [];
    for (const p of newPayments) {
      try {
        const orderId = p.order_id;
        if (!orderId) {
          logStep(`  SKIP: payment ${p.id} has no order_id`);
          continue;
        }

        const orderData = await squareGet(`/v2/orders/${orderId}`, SQUARE_TOKEN);
        squareCallCount++;
        const order = orderData.order || {};
        const lineItems = order.line_items || [];
        const customerId = order.customer_id || p.customer_id || "";

        let customerName = customerId;
        let leadSource = "Unknown";
        if (customerId) {
          const cached = lookups.customers[customerId];
          const needsRecheck = shouldRecheckUnknownCustomer(cached);

          if (cached && !needsRecheck) {
            customerName = cached.name;
            leadSource = cached.leadSource || "Unknown";
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

              const cachedAt = (cached && cached.cachedAt) ? cached.cachedAt : todayStamp;
              lookups.customers[customerId] = { name: customerName, leadSource, cachedAt };
              if (cached) {
                logStep(`    Rechecked ${customerName}: leadSource = "${leadSource}"`);
              } else {
                logStep(`    Cached new customer: ${customerName} (${leadSource})`);
              }
            } catch (e) {
              logStep(`    WARNING: could not fetch customer ${customerId}: ${e.message}`);
              if (cached) {
                customerName = cached.name;
                leadSource = cached.leadSource || "Unknown";
              }
            }
          }
        }

        let primaryService = "";
        if (lineItems.length > 0) {
          const firstItem = lineItems[0];
          primaryService = firstItem.name || "";
          if (firstItem.catalog_object_id && lookups.services[firstItem.catalog_object_id]) {
            primaryService = lookups.services[firstItem.catalog_object_id].name;
          }
        }

        const totalMoney = order.total_money || p.amount_money || {};
        const paymentAmountDollars = totalMoney.amount ? Math.round(totalMoney.amount / 100) : 0;

        const paymentDate = (p.created_at || "").substring(0, 10);

        newJobs.push({
          "Date": paymentDate,
          "Customer Name": customerName,
          "Lead Source": leadSource,
          "Service": primaryService,
          "Payment Amount": paymentAmountDollars,
          "Payment ID": p.id,
        });

        logStep(`  + ${paymentDate} · ${customerName} · ${primaryService} · $${paymentAmountDollars}`);
      } catch (e) {
        logStep(`  ERROR processing payment ${p.id}: ${e.message}`);
      }
    }

    logStep(`Processed ${newJobs.length} new jobs. Total Square API calls: ${squareCallCount}.`);

    // === Step 6: Merge and write back to jsonbin ===
    // We always write even if no new jobs, since we may have updated Lead Sources on existing jobs
    const combinedJobs = [...existingJobs, ...newJobs].sort((a, b) => {
      const da = new Date(a["Date"] || 0);
      const db = new Date(b["Date"] || 0);
      return da - db;
    });

    logStep("Writing combined data to jsonbin...");
    const binWriteUrl = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
    const payload = {
      jobs: combinedJobs,
      appointments: existingAppointments,
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
      paymentsScanned: allPayments.length,
      newJobsAdded: newJobs.length,
      unknownCustomersRechecked: unknownRecheckIds.length,
      totalJobs: combinedJobs.length,
      squareApiCalls: squareCallCount,
      elapsedSeconds: elapsed,
      log,
    });

  } catch (err) {
    console.error("Sync-payments failed:", err);
    log.push(`ERROR: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      log,
    });
  }
}
