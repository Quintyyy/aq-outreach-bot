import express from "express";
import fetch from "node-fetch";
import Airtable from "airtable";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ─── ENV ────────────────────────────────────────────────────────────────────
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  VAPI_API_KEY,
  VAPI_PHONE_NUMBER_ID,
  VAPI_ASSISTANT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  DEMO_VIDEO_URL,
  CALENDLY_URL,
  PORT = 3000,
} = process.env;

// ─── AIRTABLE ────────────────────────────────────────────────────────────────
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const ProspectsTable = base("Prospects");
const CallLogTable   = base("CallLog");

// ─── PRIORITY LOGIC ──────────────────────────────────────────────────────────
/**
 * Derive a prospect's priority tier from their LastOutcome.
 *
 * HOT   – answered, got the demo, hasn't booked  → needs Andrew follow-up
 * WARM  – answered but asked for callback
 * NEW   – never called
 * RETRY – no answer / voicemail / busy / timed out
 * COLD  – explicitly not interested
 */
function getPriorityTier(lastOutcome, callCount) {
  if (!lastOutcome || callCount === 0) return "NEW";

  const o = (lastOutcome || "").toLowerCase();

  if (
    o.includes("demo-sent") ||
    o.includes("demo sent") ||
    o.includes("interested") ||
    o.includes("got demo")
  ) return "HOT";

  if (
    o.includes("call-back") ||
    o.includes("callback") ||
    o.includes("call back") ||
    o.includes("call me later") ||
    o.includes("later")
  ) return "WARM";

  if (
    o.includes("not-interested") ||
    o.includes("not interested") ||
    o.includes("no thanks") ||
    o.includes("remove")
  ) return "COLD";

  // voicemail / no-answer / silence / busy → RETRY
  if (
    o.includes("voicemail") ||
    o.includes("no-answer") ||
    o.includes("no answer") ||
    o.includes("silence") ||
    o.includes("busy") ||
    o.includes("customer-busy") ||
    o.includes("timed-out") ||
    o.includes("timeout")
  ) return "RETRY";

  return "NEW";
}

const PRIORITY_ORDER = { HOT: 0, WARM: 1, NEW: 2, RETRY: 3, COLD: 4 };

function sortProspects(prospects) {
  return prospects.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.fields.PriorityTier || "NEW"] ?? 99;
    const pb = PRIORITY_ORDER[b.fields.PriorityTier || "NEW"] ?? 99;
    return pa - pb;
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function updateProspectCallStats(airtableId, outcome) {
  // Fetch current record
  const record = await ProspectsTable.find(airtableId);
  const currentCount = record.fields.CallCount || 0;
  const newCount = currentCount + 1;
  const tier = getPriorityTier(outcome, newCount);

  await ProspectsTable.update(airtableId, {
    CallCount:    newCount,
    LastOutcome:  outcome,
    PriorityTier: tier,
    LastCalledAt: new Date().toISOString(),
  });

  return { newCount, tier };
}

async function logCall(airtableId, prospectName, phone, outcome, callId, attemptNumber) {
  await CallLogTable.create({
    ProspectId:     airtableId,
    ProspectName:   prospectName,
    Phone:          phone,
    Outcome:        outcome,
    CallId:         callId || "",
    AttemptNumber:  attemptNumber,
    CalledAt:       new Date().toISOString(),
  });
}

async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
}

async function makeVapiCall(phone, prospectName, airtableId) {
  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      assistantId:   VAPI_ASSISTANT_ID,
      customer: { number: phone, name: prospectName },
      assistantOverrides: {
        variableValues: { prospectName, airtableId },
      },
    }),
  });
  return res.json();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Dashboard
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ── GET /api/prospects ───────────────────────────────────────────────────────
app.get("/api/prospects", async (req, res) => {
  try {
    const records = await ProspectsTable.select({
      maxRecords: 500,
      fields: [
        "Name", "Phone", "Business", "Email", "City", "Status",
        "CallCount", "LastOutcome", "LastCalledAt", "PriorityTier",
        "Notes",
      ],
    }).all();

    // Recalculate PriorityTier on read for any records missing it
    const prospects = records.map((r) => {
      const callCount   = r.fields.CallCount || 0;
      const lastOutcome = r.fields.LastOutcome || "";
      const tier        = r.fields.PriorityTier || getPriorityTier(lastOutcome, callCount);
      return {
        id:     r.id,
        fields: { ...r.fields, CallCount: callCount, PriorityTier: tier },
      };
    });

    res.json({ prospects: sortProspects(prospects) });
  } catch (err) {
    console.error("GET /api/prospects error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/prospects (add single) ────────────────────────────────────────
app.post("/api/prospects", async (req, res) => {
  try {
    const { name, phone, businessName, email, city } = req.body;
    const record = await ProspectsTable.create({
      Name:         name,
      Phone:        phone,
      BusinessName: businessName || "",
      Email:        email || "",
      City:         city || "",
      Status:       "pending",
      CallCount:    0,
      PriorityTier: "NEW",
    });
    res.json({ success: true, id: record.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/prospects/bulk ─────────────────────────────────────────────────
app.post("/api/prospects/bulk", async (req, res) => {
  try {
    const { prospects } = req.body; // array of { name, phone, businessName, city }
    const chunks = [];
    for (let i = 0; i < prospects.length; i += 10) chunks.push(prospects.slice(i, i + 10));

    let created = 0;
    for (const chunk of chunks) {
      const records = chunk.map((p) => ({
        fields: {
          Name:         p.name || p.Name || "",
          Phone:        p.phone || p.Phone || "",
          BusinessName: p.businessName || p.BusinessName || "",
          City:         p.city || p.City || "",
          Status:       "pending",
          CallCount:    0,
          PriorityTier: "NEW",
        },
      }));
      await ProspectsTable.create(records);
      created += chunk.length;
    }
    res.json({ success: true, created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/call ───────────────────────────────────────────────────────────
app.post("/api/call", async (req, res) => {
  try {
    const { airtableId, phone, name } = req.body;

    // Mark as calling
    await ProspectsTable.update(airtableId, { Status: "calling" });

    const callRes = await makeVapiCall(phone, name, airtableId);
    res.json({ success: true, callId: callRes.id });
  } catch (err) {
    console.error("POST /api/call error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/retry ──────────────────────────────────────────────────────────
// Explicit retry for RETRY-tier prospects
app.post("/api/retry", async (req, res) => {
  try {
    const { airtableId, phone, name } = req.body;

    const record = await ProspectsTable.find(airtableId);
    const tier   = record.fields.PriorityTier;

    if (!["RETRY", "WARM", "NEW"].includes(tier)) {
      return res.status(400).json({ error: `Cannot retry a ${tier} prospect from this endpoint.` });
    }

    await ProspectsTable.update(airtableId, { Status: "calling" });
    const callRes = await makeVapiCall(phone, name, airtableId);
    res.json({ success: true, callId: callRes.id, message: `Retry call initiated (attempt #${(record.fields.CallCount || 0) + 1})` });
  } catch (err) {
    console.error("POST /api/retry error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/call-all ───────────────────────────────────────────────────────
app.post("/api/call-all", async (req, res) => {
  try {
    // Call NEW + RETRY prospects that aren't currently being called
    const records = await ProspectsTable.select({
      filterByFormula: `OR(
        AND({Status} = 'pending', OR({PriorityTier} = 'NEW', {PriorityTier} = '')),
        AND({Status} = 'pending', {PriorityTier} = 'RETRY')
      )`,
      maxRecords: 100,
    }).all();

    res.json({ success: true, queued: records.length, ids: records.map((r) => r.id) });

    // Fire calls asynchronously with stagger
    for (const record of records) {
      const { Name, Phone } = record.fields;
      if (!Phone) continue;
      try {
        await ProspectsTable.update(record.id, { Status: "calling" });
        await makeVapiCall(Phone, Name, record.id);
      } catch (e) {
        console.error(`Call failed for ${Name}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error("POST /api/call-all error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/places-search ──────────────────────────────────────────────────
app.post("/api/places-search", async (req, res) => {
  try {
    const { query, location } = req.body;
    const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
    if (!PLACES_KEY) return res.status(500).json({ error: "No Google Places API key configured" });

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}&key=${PLACES_KEY}`;
    const r   = await fetch(url);
    const data = await r.json();

    const results = (data.results || []).map((p) => ({
      name:    p.name,
      address: p.formatted_address,
      phone:   p.formatted_phone_number || "",
      placeId: p.place_id,
    }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/call-history/:airtableId ───────────────────────────────────────
app.get("/api/call-history/:airtableId", async (req, res) => {
  try {
    const { airtableId } = req.params;
    const records = await CallLogTable.select({
      filterByFormula: `{ProspectId} = '${airtableId}'`,
      sort: [{ field: "CalledAt", direction: "desc" }],
    }).all();

    res.json({
      history: records.map((r) => ({
        id:            r.id,
        outcome:       r.fields.Outcome,
        attemptNumber: r.fields.AttemptNumber,
        calledAt:      r.fields.CalledAt,
        callId:        r.fields.CallId,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/hot-leads ───────────────────────────────────────────────────────
app.get("/api/hot-leads", async (req, res) => {
  try {
    const records = await ProspectsTable.select({
      filterByFormula: `{PriorityTier} = 'HOT'`,
      maxRecords: 50,
    }).all();
    res.json({ hotLeads: records.map((r) => ({ id: r.id, fields: r.fields })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /vapi-webhook ───────────────────────────────────────────────────────
app.post("/vapi-webhook", async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const payload = req.body;
    const type    = payload?.message?.type;

    // Only handle end-of-call reports
    if (type !== "end-of-call-report") return;

    const msg        = payload.message;
    const callId     = msg.call?.id || "";
    const airtableId = msg.call?.customer?.metadata?.airtableId
                    || msg.assistantOverrides?.variableValues?.airtableId
                    || msg.call?.assistantOverrides?.variableValues?.airtableId;

    const phone   = msg.call?.customer?.number || "";
    const summary = (msg.summary || "").toLowerCase();
    const endedBy = msg.endedReason || "";

    // ── Outcome classification ─────────────────────────────────────────────
    let outcome = "unknown";

    if (endedBy === "customer-did-not-pick-up" || endedBy === "no-answer") {
      outcome = "no-answer";
    } else if (endedBy === "voicemail") {
      outcome = "voicemail";
    } else if (endedBy === "silence-timed-out") {
      outcome = "silence-timed-out";
    } else if (endedBy === "customer-busy") {
      outcome = "customer-busy";
    } else if (
      summary.includes("not interested") ||
      summary.includes("do not call") ||
      summary.includes("remove")
    ) {
      outcome = "not-interested";
    } else if (
      summary.includes("call back") ||
      summary.includes("call me later") ||
      summary.includes("callback")
    ) {
      outcome = "callback-requested";
    } else if (
      summary.includes("demo") ||
      summary.includes("video") ||
      summary.includes("interested") ||
      summary.includes("sent")
    ) {
      outcome = "demo-sent";
    } else if (endedBy === "assistant-ended-call") {
      outcome = "completed";
    }

    // ── Update Prospects table ─────────────────────────────────────────────
    if (airtableId) {
      const { newCount } = await updateProspectCallStats(airtableId, outcome);

      // Status update
      let status = "called";
      if (outcome === "demo-sent")         status = "demo-sent";
      if (outcome === "not-interested")    status = "not-interested";
      if (outcome === "callback-requested") status = "callback-requested";
      if (["no-answer", "voicemail", "silence-timed-out", "customer-busy"].includes(outcome)) {
        status = "no-answer";
      }
      await ProspectsTable.update(airtableId, { Status: status });

      // Log the call
      const record = await ProspectsTable.find(airtableId);
      await logCall(airtableId, record.fields.Name || "", phone, outcome, callId, newCount);

      // SMS for hot leads
      if (outcome === "demo-sent" && phone && DEMO_VIDEO_URL) {
        const smsBody = `Hi! This is Mike from AQ Solutions. Here's the AI demo we discussed: ${DEMO_VIDEO_URL}\n\nBook a free strategy call: ${CALENDLY_URL || ""}`;
        await sendSMS(phone, smsBody);
      }
    }

    console.log(`Webhook processed: ${outcome} | ID: ${airtableId} | Call: ${callId}`);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`AQ Outreach Bot running on port ${PORT}`));
