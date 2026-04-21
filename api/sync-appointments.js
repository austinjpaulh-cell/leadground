// /api/sync-appointments.js
// Vercel serverless function — pulls upcoming bookings from Square, writes to jsonbin
// Runs daily via Vercel Cron (see vercel.json)
// Manual trigger: visit https://leadground.vercel.app/api/sync-appointments

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";
const JSONBIN_BIN_ID = "69e3fe8a856a6821894b16fe";
const JSONBIN_MASTER_KEY = "$2a$10$qO.v2e/pmWupbGZ4QEk.heEUW2xxSOxb1yw.rfksRY9Rzv8xJvBo6";

export default async function handler(req, res) {
  const startTime = Date.now();
  const log = [];
  const logStep = (msg) => { console.log(msg); log.push(msg); };

  try {
    const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    if (!SQUARE_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN env var is not set in Vercel");
    }

    // === Step 1: Fetch upcoming bookings from Square ===
    logStep("Fetching bookings from Square...");
    const startAtMin = new Date().toISOString();
    const squareUrl = `https://connect.squareup.com/v2/bookings?location_id=${SQUARE_LOCATION_ID}&limit=200&start_at_min=${encodeURIComponent(startAtMin)}`;

    const squareRes = await fetch(squareUrl, {
      method: "GET",
      headers: {
        "Square-Version": SQUARE_API_VERSION,
        "Authorization": `Bearer ${SQUARE_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!squareRes.ok) {
      const errText = await squareRes.text();
      throw new Error(`Square API failed (${squareRes.status}): ${errText}`);
    }

    const squareData = await squareRes.json();
    const bookings = squareData.bookings || [];
    logStep(`Square returned ${bookings.length} bookings`);

    // === Step 2: Transform bookings into our appointment shape ===
    // Pass 1: store raw IDs for customer/service. Pass 2 will resolve names.
    const appointments = bookings
      .filter(b => {
        const status = (b.status || "").toLowerCase();
        return status !== "cancelled_by_customer"
            && status !== "cancelled_by_seller"
            && status !== "declined"
            && status !== "no_show";
      })
      .map(b => {
        const startAt = b.start_at || "";
        const date = startAt.substring(0, 10); // YYYY-MM-DD
        const timeUtc = startAt.substring(11, 16); // HH:MM in UTC

        // Convert UTC time to Mountain Time (UTC-6 standard, UTC-7 daylight)
        // Quick approximation — Mountain Daylight Time is UTC-6
        let displayTime = timeUtc;
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
            // fall back to raw time
          }
        }

        const segment = (b.appointment_segments && b.appointment_segments[0]) || {};

        return {
          "Appointment ID": b.id || "",
          "Date": date,
          "Time": displayTime,
          "Customer Name": b.customer_id || "",        // raw ID for now — Pass 2 resolves to name
          "Service": segment.service_variation_id || "", // raw ID for now — Pass 2 resolves to name
          "Lead Source": "Unknown",                      // Pass 2 resolves via customer groups
          "Estimated Value": 0,                          // Pass 2 fills from invoice/catalog
          "Status": (b.status || "").toLowerCase(),
        };
      });

    logStep(`Filtered to ${appointments.length} active appointments (excluding cancellations/no-shows)`);

    // === Step 3: Read existing jobs from jsonbin (preserve them) ===
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
    logStep(`Preserved ${existingJobs.length} existing jobs`);

    // === Step 4: Write combined data back to jsonbin ===
    logStep("Writing combined data to jsonbin...");
    const binWriteUrl = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
    const payload = {
      jobs: existingJobs,
      appointments: appointments,
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
