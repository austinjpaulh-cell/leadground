// /api/debug-booking.js
// Diagnostic function — finds where Square stores the custom price on a booking
// Usage: https://leadground.vercel.app/api/debug-booking?id=inswtd3qtfn3wp
//
// This fetches:
//   1. The raw booking object (every field Square exposes)
//   2. Orders linked to the booking's customer (filtered to recent/open)
//   3. Invoices linked to the booking's customer
//   4. Booking custom attributes (if any)
// Then dumps it all in the response so we can find the $770.

const SQUARE_API_VERSION = "2026-01-22";
const SQUARE_LOCATION_ID = "DGPKQZ8GP2PV7";

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
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { rawText: text }; }
  return { ok: res.ok, status: res.status, data: json };
}

async function squarePost(path, body, token) {
  const url = `https://connect.squareup.com${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Square-Version": SQUARE_API_VERSION,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { rawText: text }; }
  return { ok: res.ok, status: res.status, data: json };
}

export default async function handler(req, res) {
  const result = {
    step1_booking: null,
    step2_booking_custom_attributes: null,
    step3_customer_orders: null,
    step4_customer_invoices: null,
    hints: [],
  };

  try {
    const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    if (!SQUARE_TOKEN) throw new Error("SQUARE_ACCESS_TOKEN not set");

    const bookingId = req.query.id;
    if (!bookingId) {
      return res.status(400).json({
        error: "Missing booking ID. Usage: /api/debug-booking?id=YOUR_BOOKING_ID",
        hint: "Get a booking ID from https://api.jsonbin.io/v3/b/69e3fe8a856a6821894b16fe/latest — look at appointments[].Appointment ID",
      });
    }

    // === Step 1: Fetch the full booking ===
    const bookingRes = await squareGet(`/v2/bookings/${bookingId}`, SQUARE_TOKEN);
    result.step1_booking = bookingRes;

    if (!bookingRes.ok) {
      result.hints.push(`Booking fetch failed: ${bookingRes.status}. Check the booking ID is correct.`);
      return res.status(200).json(result);
    }

    const booking = bookingRes.data.booking || {};
    const customerId = booking.customer_id;

    // Look for any price-like fields directly on the booking
    const bookingKeys = Object.keys(booking);
    const priceKeys = bookingKeys.filter(k =>
      k.toLowerCase().includes("price") ||
      k.toLowerCase().includes("amount") ||
      k.toLowerCase().includes("money") ||
      k.toLowerCase().includes("total") ||
      k.toLowerCase().includes("cost")
    );
    if (priceKeys.length > 0) {
      result.hints.push(`Found price-like fields directly on booking: ${priceKeys.join(", ")}`);
    } else {
      result.hints.push("No price fields directly on booking object (expected — Square stores them elsewhere).");
    }

    // === Step 2: Fetch booking's custom attributes ===
    const attrsRes = await squareGet(`/v2/bookings/${bookingId}/custom-attributes`, SQUARE_TOKEN);
    result.step2_booking_custom_attributes = attrsRes;

    // === Step 3: Search for orders linked to this customer ===
    if (customerId) {
      const ordersBody = {
        location_ids: [SQUARE_LOCATION_ID],
        query: {
          filter: {
            customer_filter: {
              customer_ids: [customerId],
            },
            state_filter: {
              states: ["OPEN", "DRAFT", "COMPLETED"],
            },
          },
          sort: {
            sort_field: "CREATED_AT",
            sort_order: "DESC",
          },
        },
        limit: 10,
      };
      const ordersRes = await squarePost(`/v2/orders/search`, ordersBody, SQUARE_TOKEN);
      result.step3_customer_orders = ordersRes;

      // Look for orders referencing this booking
      if (ordersRes.ok && ordersRes.data.orders) {
        const orders = ordersRes.data.orders;
        const bookingLinkedOrders = orders.filter(o => {
          const jsonStr = JSON.stringify(o);
          return jsonStr.includes(bookingId);
        });
        if (bookingLinkedOrders.length > 0) {
          result.hints.push(`FOUND: ${bookingLinkedOrders.length} order(s) reference this booking ID directly!`);
          for (const o of bookingLinkedOrders) {
            if (o.total_money) {
              result.hints.push(`  → Order ${o.id} total: $${(o.total_money.amount / 100).toFixed(2)} (${o.state})`);
            }
          }
        } else {
          result.hints.push(`Customer has ${orders.length} orders in the location, but none reference booking ID ${bookingId} directly. Check if any have a matching total.`);
          for (const o of orders) {
            if (o.total_money) {
              const created = o.created_at ? o.created_at.substring(0, 10) : "?";
              result.hints.push(`  → Order ${o.id} total: $${(o.total_money.amount / 100).toFixed(2)} (${o.state}, ${created})`);
            }
          }
        }
      }
    }

    // === Step 4: Search for invoices linked to this customer ===
    if (customerId) {
      const invoicesBody = {
        query: {
          filter: {
            location_ids: [SQUARE_LOCATION_ID],
            customer_ids: [customerId],
          },
          sort: {
            field: "INVOICE_SORT_DATE",
            order: "DESC",
          },
        },
        limit: 10,
      };
      const invoicesRes = await squarePost(`/v2/invoices/search`, invoicesBody, SQUARE_TOKEN);
      result.step4_customer_invoices = invoicesRes;

      if (invoicesRes.ok && invoicesRes.data.invoices) {
        const invoices = invoicesRes.data.invoices;
        result.hints.push(`Customer has ${invoices.length} invoice(s).`);
        for (const inv of invoices) {
          if (inv.payment_requests && inv.payment_requests[0] && inv.payment_requests[0].computed_amount_money) {
            const amt = inv.payment_requests[0].computed_amount_money.amount;
            result.hints.push(`  → Invoice ${inv.id} amount: $${(amt / 100).toFixed(2)} (${inv.status})`);
          }
        }
      }
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({
      error: err.message,
      partial_result: result,
    });
  }
}
