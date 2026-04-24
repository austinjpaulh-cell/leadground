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

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";
const JSONBIN_BIN_ID = "69e3fe8a856a6821894b16fe";
const JSONBIN_MASTER_KEY = "$2a$10$qO.v2e/pmWupbGZ4QEk.heEUW2xxSOxb1yw.rfksRY9Rzv8xJvBo6";
const LOOKBACK_DAYS = 7;

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

    // === Step 2: Refresh customer groups cache (for lead source resolution) ===
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

    // === Step 3: Fetch recent payments from Square ===
    logStep(`Fetching payments from last ${LOOKBACK_DAYS} days...`);
    const beginTime = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const paymentsUrl = `/v2/payments?location_id=${SQUARE_LOCATION_ID}&begin_time=${encodeURIComponent(beginTime)}&limit=100&sort_order=DESC`;
    const paymentsData = await squareGet(paymentsUrl, SQUARE_TOKEN);
    squareCallCount++;
    const allPayments = paymentsData.payments || [];
    logStep(`Square returned ${allPayments.length} payments`);

    // Filter: only COMPLETED payments, and skip ones we already have
    const newPayments = allPayments.filter(p => {
      if ((p.status || "").toUpperCase() !== "COMPLETED") return false;
      if (existingPaymentIds.has(p.id)) return false;
      return true;
    });
    logStep(`${newPayments.length} new completed payments to process (${allPayments.length - newPayments.length} already in jsonbin or not completed).`);

    // === Step 4: Process each new payment ===
    const newJobs = [];
    for (const p of newPayments) {
      try {
        const orderId = p.order_id;
        if (!orderId) {
          logStep(`  SKIP: payment ${p.id} has no order_id`);
          continue;
        }

        // Fetch order for line items
        const orderData = await squareGet(`/v2/orders/${orderId}`, SQUARE_TOKEN);
        squareCallCount++;
        const order = orderData.order || {};
        const lineItems = order.line_items || [];
        const customerId = order.customer_id || p.customer_id || "";

        // Resolve customer name + lead source (from cache first)
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
              logStep(`    Cached new customer: ${customerName}`);
            } catch (e) {
              logStep(`    WARNING: could not fetch customer ${customerId}: ${e.message}`);
            }
          }
        }

        // Primary service = name of first line item
        let primaryService = "";
        if (lineItems.length > 0) {
          const firstItem = lineItems[0];
          primaryService = firstItem.name || "";
          // If the line item has a catalog reference, try cache for prettier name
          if (firstItem.catalog_object_id && lookups.services[firstItem.catalog_object_id]) {
            primaryService = lookups.services[firstItem.catalog_object_id].name;
          }
        }

        // Payment Amount = full order total in dollars (covers all line items + tax - discounts)
        // Fallback to payment amount_money if order total_money is missing
        const totalMoney = order.total_money || p.amount_money || {};
        const paymentAmountDollars = totalMoney.amount ? Math.round(totalMoney.amount / 100) : 0;

        // Date = payment created_at in YYYY-MM-DD
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

    // === Step 5: Merge and write back to jsonbin ===
    if (newJobs.length === 0) {
      logStep("No new jobs to write. Skipping jsonbin write.");
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      return res.status(200).json({
        success: true,
        paymentsScanned: allPayments.length,
        newJobsAdded: 0,
        totalJobs: existingJobs.length,
        squareApiCalls: squareCallCount,
        elapsedSeconds: elapsed,
        log,
      });
    }

    // Combine existing + new, sort by date ascending (oldest first, matching existing pattern)
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
