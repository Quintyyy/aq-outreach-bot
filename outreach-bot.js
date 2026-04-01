import express from "express";
import fetch from "node-fetch";
import Airtable from "airtable";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const {
  AIRTABLE_API_KEY, AIRTABLE_BASE_ID,
  VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
  DEMO_VIDEO_URL, CALENDLY_URL, GOOGLE_PLACES_API_KEY,
  PORT = 3000,
} = process.env;

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const ProspectsTable = base("Prospects");
const CallLogTable   = base("CallLog");

function getPriorityTier(lastOutcome, callCount) {
  if (!lastOutcome || !callCount || callCount === 0) return "NEW";
  const o = (lastOutcome || "").toLowerCase();
  if (o.includes("demo-sent") || o.includes("interested")) return "HOT";
  if (o.includes("callback") || o.includes("call back") || o.includes("later")) return "WARM";
  if (o.includes("not-interested") || o.includes("not interested")) return "COLD";
  if (o.includes("voicemail") || o.includes("no-answer") || o.includes("no answer") ||
      o.includes("silence") || o.includes("busy") || o.includes("timed-out")) return "RETRY";
  return "NEW";
}

const PRIORITY_ORDER = { HOT: 0, WARM: 1, NEW: 2, RETRY: 3, COLD: 4 };

async function safeUpdate(id, fields) {
  try {
    await ProspectsTable.update(id, fields);
  } catch (e) {
    console.warn("Airtable update warning:", e.message);
    try {
      const safe = {};
      if (fields.Status)  safe.Status  = fields.Status;
      if (fields.Result)  safe.Result  = fields.Result;
      if (fields.CalledAt) safe.CalledAt = fields.CalledAt;
      if (Object.keys(safe).length > 0) await ProspectsTable.update(id, safe);
    } catch (e2) { console.error("Fallback update failed:", e2.message); }
  }
}

async function makeVapiCall(phone, name, airtableId) {
  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      assistantId: VAPI_ASSISTANT_ID,
      customer: { number: phone, name },
      assistantOverrides: { variableValues: { prospectName: name, airtableId } },
    }),
  });
  return res.json();
}

async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID) return;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
}

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

app.get("/api/prospects", async (req, res) => {
  try {
    const records = await ProspectsTable.select({ maxRecords: 500 }).all();
    const prospects = records.map(r => {
      const f = r.fields;
      const callCount   = f.CallCount || 0;
      const lastOutcome = f.LastOutcome || f.Result || "";
      const tier        = f.PriorityTier || getPriorityTier(lastOutcome, callCount);
      return {
        id: r.id,
        fields: {
          Name: f.Name || "", Business: f.Business || "", Phone: f.Phone || "",
          Notes: f.Notes || "", Status: f.Status || "", Result: f.Result || "",
          CalledAt: f.CalledAt || "", CallCount: callCount,
          LastOutcome: lastOutcome, PriorityTier: tier,
          LastCalledAt: f.LastCalledAt || f.CalledAt || "",
        },
      };
    });
    prospects.sort((a, b) => (PRIORITY_ORDER[a.fields.PriorityTier] ?? 99) - (PRIORITY_ORDER[b.fields.PriorityTier] ?? 99));
    res.json({ prospects });
  } catch (err) {
    console.error("GET /api/prospects:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hot-leads", async (req, res) => {
  try {
    const records = await ProspectsTable.select({ maxRecords: 500 }).all();
    const hot = records.filter(r => {
      const tier    = r.fields.PriorityTier;
      const outcome = (r.fields.LastOutcome || r.fields.Result || "").toLowerCase();
      return tier === "HOT" || outcome.includes("demo-sent") || outcome.includes("interested");
    });
    res.json({ hotLeads: hot.map(r => ({ id: r.id, fields: r.fields })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dedup helper ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "").slice(-10);
}
async function getExistingPhones() {
  const records = await ProspectsTable.select({ fields: ["Phone"], maxRecords: 500 }).all();
  const set = new Set();
  for (const r of records) { const n = normalizePhone(r.fields.Phone); if (n) set.add(n); }
  return set;
}

app.post("/api/prospects", async (req, res) => {
  try {
    const { name, phone, businessName, business, city, notes } = req.body;
    const existing = await getExistingPhones();
    if (phone && existing.has(normalizePhone(phone))) {
      return res.json({ success: false, duplicate: true, message: "This phone number already exists in your prospect list." });
    }
    const record = await ProspectsTable.create({
      Name: name || "", Business: businessName || business || "",
      Phone: phone || "", Notes: notes || (city ? `City: ${city}` : ""), Status: "pending",
    });
    res.json({ success: true, id: record.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/prospects/bulk", async (req, res) => {
  try {
    const { prospects } = req.body;
    const existing = await getExistingPhones();
    const toAdd = []; const skipped = [];
    for (const p of prospects) {
      const phone = p.phone || p.Phone || "";
      const norm = normalizePhone(phone);
      if (!norm || existing.has(norm)) { skipped.push(p.businessName || p.Business || phone); }
      else { existing.add(norm); toAdd.push(p); }
    }
    const chunks = [];
    for (let i = 0; i < toAdd.length; i += 10) chunks.push(toAdd.slice(i, i + 10));
    let created = 0;
    for (const chunk of chunks) {
      await ProspectsTable.create(chunk.map(p => ({
        fields: {
          Name: p.name || p.Name || "", Business: p.businessName || p.business || p.Business || "",
          Phone: p.phone || p.Phone || "", Notes: p.city ? `City: ${p.city}` : "", Status: "pending",
        },
      })));
      created += chunk.length;
    }
    res.json({ success: true, created, skipped: skipped.length, skippedNames: skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/call", async (req, res) => {
  try {
    const { airtableId, phone, name } = req.body;
    await safeUpdate(airtableId, { Status: "calling" });
    const callRes = await makeVapiCall(phone, name, airtableId);
    res.json({ success: true, callId: callRes.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/retry", async (req, res) => {
  try {
    const { airtableId, phone, name } = req.body;
    await safeUpdate(airtableId, { Status: "calling" });
    const callRes = await makeVapiCall(phone, name, airtableId);
    res.json({ success: true, callId: callRes.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Live session state ───────────────────────────────────────────────────────
let callSession = { active: false, total: 0, current: 0, currentName: "", startedAt: null, results: [] };
let dispatchHistory = [];

app.get("/api/call-progress", (req, res) => res.json({ ...callSession }));
app.get("/api/dispatch-history", (req, res) => res.json({ history: dispatchHistory.slice(0, 50) }));

app.post("/api/call-all", async (req, res) => {
  try {
    if (callSession.active) return res.json({ success: false, message: "A call session is already running." });

    const records = await ProspectsTable.select({ maxRecords: 100 }).all();
    const callable = records.filter(r => {
      const s    = r.fields.Status || "";
      const tier = r.fields.PriorityTier || "NEW";
      return !!r.fields.Phone && s !== "calling" && s !== "demo-sent" &&
             s !== "not-interested" && tier !== "COLD" && tier !== "HOT";
    });

    if (callable.length === 0) return res.json({ success: true, queued: 0, message: "No prospects to call." });

    callSession = { active: true, total: callable.length, current: 0, currentName: "", startedAt: new Date().toISOString(), results: [] };
    res.json({ success: true, queued: callable.length });

    for (const record of callable) {
      const name = record.fields.Business || record.fields.Name || "Owner";
      callSession.current++;
      callSession.currentName = name;
      try {
        await safeUpdate(record.id, { Status: "calling" });
        await makeVapiCall(record.fields.Phone, name, record.id);
        callSession.results.push({ name, status: "called" });
      } catch (e) {
        console.error("Call failed for " + name + ":", e.message);
        callSession.results.push({ name, status: "failed" });
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    const done = {
      total: callSession.total,
      called: callSession.results.filter(r => r.status === "called").length,
      failed: callSession.results.filter(r => r.status === "failed").length,
      results: callSession.results,
      startedAt: callSession.startedAt,
      completedAt: new Date().toISOString(),
    };
    dispatchHistory.unshift(done);
    callSession = { active: false, total: 0, current: 0, currentName: "", startedAt: null, results: [] };

  } catch (err) {
    callSession.active = false;
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/call-history/:airtableId", async (req, res) => {
  try {
    const records = await CallLogTable.select({
      filterByFormula: `{ProspectId} = '${req.params.airtableId}'`,
      sort: [{ field: "CalledAt", direction: "desc" }],
    }).all();
    res.json({ history: records.map(r => ({
      id: r.id, outcome: r.fields.Outcome || "", attemptNumber: r.fields.AttemptNumber || 1,
      calledAt: r.fields.CalledAt || "", callId: r.fields.CallId || "",
    }))});
  } catch (err) { res.json({ history: [] }); }
});

app.post("/api/places-search", async (req, res) => {
  try {
    const { query, location } = req.body;
    if (!GOOGLE_PLACES_API_KEY) return res.status(500).json({ error: "No Google Places API key" });

    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + " " + location)}&key=${GOOGLE_PLACES_API_KEY}`;
    const searchData = await (await fetch(searchUrl)).json();

    const results = [];
    for (const place of (searchData.results || []).slice(0, 10)) {
      try {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,formatted_address&key=${GOOGLE_PLACES_API_KEY}`;
        const detail = await (await fetch(detailUrl)).json();
        const d = detail.result || {};
        results.push({ name: d.name || place.name, address: d.formatted_address || place.formatted_address, phone: d.formatted_phone_number || "", placeId: place.place_id });
      } catch(e) {
        results.push({ name: place.name, address: place.formatted_address, phone: "", placeId: place.place_id });
      }
    }
    res.json({ results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/vapi-webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (msg?.type !== "end-of-call-report") return;

    const callId     = msg.call?.id || "";
    const airtableId = msg.call?.assistantOverrides?.variableValues?.airtableId || msg.assistantOverrides?.variableValues?.airtableId;
    const phone      = msg.call?.customer?.number || "";
    const summary    = (msg.summary || "").toLowerCase();
    const endedBy    = msg.endedReason || "";

    let outcome = "unknown";
    if (["customer-did-not-pick-up","no-answer"].includes(endedBy)) outcome = "no-answer";
    else if (endedBy === "voicemail")         outcome = "voicemail";
    else if (endedBy === "silence-timed-out") outcome = "silence-timed-out";
    else if (endedBy === "customer-busy")     outcome = "customer-busy";
    else if (summary.includes("not interested")) outcome = "not-interested";
    else if (summary.includes("call back") || summary.includes("callback")) outcome = "callback-requested";
    else if (summary.includes("demo") || summary.includes("interested")) outcome = "demo-sent";
    else if (endedBy === "assistant-ended-call") outcome = "completed";

    if (airtableId) {
      const record = await ProspectsTable.find(airtableId);
      const newCount = (record.fields.CallCount || 0) + 1;
      const now = new Date().toISOString();
      const tier = getPriorityTier(outcome, newCount);

      const statusMap = { "demo-sent": "demo-sent", "not-interested": "not-interested", "callback-requested": "callback-requested" };
      const noAnswerOutcomes = ["no-answer","voicemail","silence-timed-out","customer-busy"];
      const status = statusMap[outcome] || (noAnswerOutcomes.includes(outcome) ? "no-answer" : "called");

      await safeUpdate(airtableId, { Status: status, Result: outcome, CalledAt: now, CallCount: newCount, LastOutcome: outcome, PriorityTier: tier, LastCalledAt: now });

      try {
        await CallLogTable.create({ ProspectId: airtableId, ProspectName: record.fields.Name || "", Phone: phone, Outcome: outcome, CallId: callId, AttemptNumber: newCount, CalledAt: now });
      } catch(e) { console.warn("CallLog insert warning:", e.message); }

      if (outcome === "demo-sent" && phone && DEMO_VIDEO_URL) {
        await sendSMS(phone, `Hi! This is Mike from AQ Solutions. Here's the AI demo: ${DEMO_VIDEO_URL}\nBook a call: ${CALENDLY_URL || ""}`).catch(e => console.warn("SMS failed:", e.message));
      }
    }
    console.log(`Webhook: ${outcome} | ${airtableId}`);
  } catch (err) { console.error("Webhook error:", err); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.listen(PORT, () => console.log(`AQ Outreach Bot running on port ${PORT}`));

// ─── SCHEDULER ───────────────────────────────────────────────────────────────
let autoCallEnabled = false;
let schedulerInterval = null;

function getNextCallTime() {
  // Fire at 8:00 AM Eastern Time (UTC-4 during EDT, UTC-5 during EST)
  // We use UTC+12 offset: 8am ET = 12:00 UTC (EDT) or 13:00 UTC (EST)
  const now = new Date();
  const nowET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const nextET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  nextET.setHours(8, 0, 0, 0);
  if (nowET >= nextET) nextET.setDate(nextET.getDate() + 1);
  // Convert back to UTC by finding the difference
  const diff = nextET - nowET;
  return new Date(now.getTime() + diff);
}

function msUntil8am() {
  return getNextCallTime().getTime() - Date.now();
}

function scheduleAutoCall() {
  if (schedulerInterval) { clearTimeout(schedulerInterval); schedulerInterval = null; }
  if (!autoCallEnabled) return;

  const ms = msUntil8am();
  const hoursUntil = (ms / 1000 / 60 / 60).toFixed(1);
  console.log(`Auto-call scheduled — firing in ${hoursUntil} hours (8:00 AM)`);

  schedulerInterval = setTimeout(async () => {
    if (!autoCallEnabled) return;
    console.log("⏰ Auto-call firing at 8am...");
    try {
      const records = await ProspectsTable.select({ maxRecords: 100 }).all();
      const callable = records.filter(r => {
        const s    = r.fields.Status || "";
        const tier = r.fields.PriorityTier || "NEW";
        return !!r.fields.Phone && s !== "calling" && s !== "demo-sent" &&
               s !== "not-interested" && tier !== "COLD" && tier !== "HOT";
      });
      console.log(`Auto-call: firing ${callable.length} calls`);
      for (const record of callable) {
        try {
          await safeUpdate(record.id, { Status: "calling" });
          await makeVapiCall(record.fields.Phone, record.fields.Name || "Owner", record.id);
        } catch (e) { console.error(`Auto-call failed for ${record.fields.Name}:`, e.message); }
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) { console.error("Auto-call error:", e.message); }
    // Reschedule for next day
    scheduleAutoCall();
  }, ms);
}

// Toggle auto-call on/off
app.post("/api/scheduler/toggle", (req, res) => {
  autoCallEnabled = !autoCallEnabled;
  if (autoCallEnabled) {
    scheduleAutoCall();
    const next = getNextCallTime();
    res.json({ enabled: true, nextCall: next.toISOString(), message: `Auto-call enabled — fires at 8:00 AM` });
  } else {
    if (schedulerInterval) { clearTimeout(schedulerInterval); schedulerInterval = null; }
    res.json({ enabled: false, message: "Auto-call disabled" });
  }
});

// Get scheduler status
app.get("/api/scheduler/status", (req, res) => {
  const next = autoCallEnabled ? getNextCallTime().toISOString() : null;
  res.json({ enabled: autoCallEnabled, nextCall: next });
});
