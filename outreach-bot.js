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
const CallLogTable  = base("CallLog");

function getPriorityTier(lastOutcome, callCount) {
    if (!lastOutcome || !callCount || callCount === 0) return "NEW";
    const o = (lastOutcome || "").toLowerCase();
    if (o.includes("demo-sent") || o.includes("interested")) return "HOT";
    if (o.includes("callback") || o.includes("call back") || o.includes("later")) return "WARM";
    if (o.includes("not-interested") || o.includes("not interested")) return "COLD";
    if (o.includes("voicemail") || o.includes("no-answer") || o.includes("no answer") || o.includes("silence") || o.includes("busy") || o.includes("timed-out")) return "RETRY";
    return "NEW";
}

const PRIORITY_ORDER = { HOT: 0, WARM: 1, NEW: 2, RETRY: 3, COLD: 4 };

async function safeUpdate(id, fields) {
    try { await ProspectsTable.update(id, fields); }
    catch (e) {
          console.warn("Airtable update warning:", e.message);
          try {
                  const safe = {};
                  if (fields.Status) safe.Status = fields.Status;
                  if (fields.Result) safe.Result = fields.Result;
                  if (fields.CalledAt) safe.CalledAt = fields.CalledAt;
                  if (Object.keys(safe).length > 0) await ProspectsTable.update(id, safe);
          } catch (e2) { console.error("Fallback update failed:", e2.message); }
    }
}

async function makeVapiCall(phone, name, airtableId, businessName) {
    const isRealName = name && name !== "Owner" && name !== "" && name !== "undefined";
    const isRealBiz = businessName && businessName !== "" && businessName !== "undefined";
    const greeting = isRealName ? `Hey ${name}, how are you doing today?` : "Hey, how are you doing today?";
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) throw new Error("Invalid phone number: " + phone);
    console.log(`Calling ${name} at ${formattedPhone} (original: ${phone})`);
    const res = await fetch("https://api.vapi.ai/call/phone", {
          method: "POST",
          headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
                  phoneNumberId: VAPI_PHONE_NUMBER_ID,
                  assistantId: VAPI_ASSISTANT_ID,
                  customer: { number: formattedPhone, name: isRealName ? name : "" },
                  assistantOverrides: {
                            firstMessage: greeting,
                            variableValues: { prospectName: isRealName ? name : "", businessName: isRealBiz ? businessName : "", airtableId },
                  },
          }),
    });
    const data = await res.json();
    if (data.error || data.message) console.error("Vapi error:", JSON.stringify(data));
    return data;
}

async function sendSMS(to, body) {
    if (!TWILIO_ACCOUNT_SID) { console.log("SMS SKIP: No TWILIO_ACCOUNT_SID"); return; }
    if (!to) { console.log("SMS SKIP: No 'to' number"); return; }
    const formattedTo = to.startsWith("+") ? to : "+1" + to.replace(/\D/g, "").slice(-10);
    console.log("SMS SENDING to:", formattedTo, "from:", TWILIO_FROM_NUMBER);
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: formattedTo, From: "+17329367514", Body: body }),
    });
    const data = await res.json();
    if (data.sid) { console.log("SMS SUCCESS:", data.sid); }
    else { console.error("SMS ERROR:", JSON.stringify(data)); }
    return data;
}

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

app.get("/api/prospects", async (req, res) => {
    try {
          const records = await ProspectsTable.select({ maxRecords: 500 }).all();
          const prospects = records.map(r => {
                  const f = r.fields;
                  const callCount = f.CallCount || 0;
                  const lastOutcome = f.LastOutcome || f.Result || "";
                  const tier = f.PriorityTier || getPriorityTier(lastOutcome, callCount);
                  return { id: r.id, fields: { Name: f.Name || "", Business: f.Business || "", Phone: f.Phone || "", Notes: f.Notes || "", Status: f.Status || "", Result: f.Result || "", CalledAt: f.CalledAt || "", CallCount: callCount, LastOutcome: lastOutcome, PriorityTier: tier, LastCalledAt: f.LastCalledAt || f.CalledAt || "" } };
          });
          prospects.sort((a, b) => (PRIORITY_ORDER[a.fields.PriorityTier] ?? 99) - (PRIORITY_ORDER[b.fields.PriorityTier] ?? 99));
          res.json({ prospects });
    } catch (err) { console.error("GET /api/prospects:", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/api/hot-leads", async (req, res) => {
    try {
          const records = await ProspectsTable.select({ maxRecords: 500 }).all();
          const hot = records.filter(r => {
                  const tier = r.fields.PriorityTier;
                  const outcome = (r.fields.LastOutcome || r.fields.Result || "").toLowerCase();
                  return tier === "HOT" || outcome.includes("demo-sent") || outcome.includes("interested");
          });
          res.json({ hotLeads: hot.map(r => ({ id: r.id, fields: r.fields })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dedup helper ──────────────────────────────────────────────────────────
function normalizePhone(phone) { return (phone || "").replace(/\D/g, "").slice(-10); }

function formatPhone(phone) {
    const digits = (phone || "").replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
    if (digits.length === 10) return "+1" + digits;
    if ((phone || "").trim().startsWith("+")) return "+" + digits;
    return "+1" + digits.slice(-10);
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
          const record = await ProspectsTable.create({ Name: name || "", Business: businessName || business || "", Phone: phone || "", Notes: notes || (city ? `City: ${city}` : ""), Status: "pending" });
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
                  await ProspectsTable.create(chunk.map(p => ({ fields: { Name: p.name || p.Name || "", Business: p.businessName || p.business || p.Business || "", Phone: p.phone || p.Phone || "", Notes: p.city ? `City: ${p.city}` : "", Status: "pending" } })));
                  created += chunk.length;
          }
          res.json({ success: true, created, skipped: skipped.length, skippedNames: skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/call", async (req, res) => {
    try {
          const { airtableId, phone, name } = req.body;
          if (!phone) return res.status(400).json({ error: "No phone number for this prospect. Add one in Airtable first." });
          const formatted = formatPhone(phone);
          if (!formatted) return res.status(400).json({ error: "Invalid phone number: " + phone });
          await safeUpdate(airtableId, { Status: "calling" });
          const callRes = await makeVapiCall(phone, name, airtableId);
          if (callRes.error || callRes.message) { await safeUpdate(airtableId, { Status: "pending" }); return res.status(500).json({ error: callRes.message || callRes.error || "Vapi call failed" }); }
          res.json({ success: true, callId: callRes.id });
    } catch (err) { console.error("Call error:", err.message); res.status(500).json({ error: err.message }); }
});

app.post("/api/retry", async (req, res) => {
    try {
          const { airtableId, phone, name } = req.body;
          await safeUpdate(airtableId, { Status: "calling" });
          const callRes = await makeVapiCall(phone, name, airtableId);
          res.json({ success: true, callId: callRes.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Live session state ────────────────────────────────────────────────────
let callSession = { active: false, total: 0, current: 0, currentName: "", startedAt: null, results: [] };
let dispatchHistory = [];

app.get("/api/call-progress", (req, res) => res.json({ ...callSession }));
app.get("/api/dispatch-history", (req, res) => res.json({ history: dispatchHistory.slice(0, 50) }));

app.post("/api/call-all", async (req, res) => {
    try {
          if (callSession.active) return res.json({ success: false, message: "A call session is already running." });
          const records = await ProspectsTable.select({ maxRecords: 100 }).all();
          const callable = records.filter(r => {
                  const s = r.fields.Status || "";
                  const tier = r.fields.PriorityTier || "NEW";
                  return !!r.fields.Phone && s !== "calling" && s !== "demo-sent" && s !== "not-interested" && tier !== "COLD" && tier !== "HOT";
          });
          if (callable.length === 0) return res.json({ success: true, queued: 0, message: "No prospects to call." });
          callSession = { active: true, total: callable.length, current: 0, currentName: "", startedAt: new Date().toISOString(), results: [] };
          // Store queue for live monitor
      callSession.queue = callable.map(r => ({ id: r.id, name: r.fields.Business || r.fields.Name || "Unknown", phone: r.fields.Phone || "" }));
          callSession.currentBusiness = "";
          callSession.currentPhone = "";
          callSession.currentStatus = "";
          callSession.currentStartedAt = null;
          res.json({ success: true, queued: callable.length });
          for (const record of callable) {
                  const name = record.fields.Name || "Owner";
                  const business = record.fields.Business || name;
                  callSession.current++;
                  callSession.currentName = name;
                  callSession.currentBusiness = business;
                  callSession.currentPhone = record.fields.Phone || "";
                  callSession.currentStatus = "ringing";
                  callSession.currentStartedAt = new Date().toISOString();
                  // Remove from queue
            callSession.queue = callSession.queue.filter(q => q.id !== record.id);
                  try {
                            await safeUpdate(record.id, { Status: "calling" });
                            await makeVapiCall(record.fields.Phone, name, record.id, business);
                            callSession.currentStatus = "connected";
                            callSession.results.push({ name: business, phone: record.fields.Phone || "", status: "called", startedAt: callSession.currentStartedAt });
                  } catch (e) {
                            console.error("Call failed for " + name + ":", e.message);
                            callSession.currentStatus = "failed";
                            callSession.results.push({ name: business, phone: record.fields.Phone || "", status: "failed", startedAt: callSession.currentStartedAt });
                  }
                  await new Promise(r => setTimeout(r, 1500));
          }
          callSession.currentStatus = "ended";
          callSession.currentStartedAt = null;
          const done = {
                  total: callSession.total,
                  called: callSession.results.filter(r => r.status === "called").length,
                  failed: callSession.results.filter(r => r.status === "failed").length,
                  results: callSession.results,
                  startedAt: callSession.startedAt,
                  completedAt: new Date().toISOString(),
          };
          dispatchHistory.unshift(done);
          callSession = { active: false, total: 0, current: 0, currentName: "", startedAt: null, results: [], queue: [], currentBusiness: "", currentPhone: "", currentStatus: "", currentStartedAt: null };
    } catch (err) { callSession.active = false; res.status(500).json({ error: err.message }); }
});

// ── Live Call Monitor API ─────────────────────────────────────────────────
app.get("/api/call-monitor", async (req, res) => {
    try {
          // Get today's call logs from Airtable
      const today = new Date();
          today.setHours(0, 0, 0, 0);
          const todayISO = today.toISOString();

      let callLogs = [];
          try {
                  const logRecords = await CallLogTable.select({
                            sort: [{ field: "CalledAt", direction: "desc" }],
                            maxRecords: 200
                  }).all();
                  callLogs = logRecords
                    .map(r => ({
                                id: r.id,
                                prospectName: r.fields.ProspectName || "",
                                phone: r.fields.Phone || "",
                                outcome: r.fields.Outcome || "",
                                calledAt: r.fields.CalledAt || "",
                                callId: r.fields.CallId || "",
                                attemptNumber: r.fields.AttemptNumber || 1,
                    }))
                    .filter(log => log.calledAt && new Date(log.calledAt) >= today);
          } catch (e) {
                  console.warn("CallLog fetch warning:", e.message);
          }

      // Get prospects with calling status
      let prospects = [];
          try {
                  const records = await ProspectsTable.select({ maxRecords: 500 }).all();
                  prospects = records.map(r => ({
                            id: r.id,
                            name: r.fields.Business || r.fields.Name || "",
                            phone: r.fields.Phone || "",
                            status: r.fields.Status || "",
                            tier: r.fields.PriorityTier || "NEW",
                  }));
          } catch (e) {
                  console.warn("Prospects fetch warning:", e.message);
          }

      // Compute stats
      const totalToday = callLogs.length;
          const answered = callLogs.filter(l => ["completed", "demo-sent", "callback-requested", "not-interested"].includes(l.outcome)).length;
          const voicemails = callLogs.filter(l => l.outcome === "voicemail").length;
          const busyFailed = callLogs.filter(l => ["customer-busy", "no-answer", "silence-timed-out"].includes(l.outcome)).length;
          const hotLeads = callLogs.filter(l => ["demo-sent", "interested"].includes(l.outcome)).length;

      // Average call duration estimate (use 45s default if no data)
      const avgDuration = totalToday > 0 ? 45 : 45;

      res.json({
              session: {
                        active: callSession.active,
                        total: callSession.total,
                        current: callSession.current,
                        currentBusiness: callSession.currentBusiness || callSession.currentName || "",
                        currentPhone: callSession.currentPhone || "",
                        currentStatus: callSession.currentStatus || "",
                        currentStartedAt: callSession.currentStartedAt || null,
                        queue: callSession.queue || [],
                        startedAt: callSession.startedAt,
              },
              completedCalls: callLogs.map(l => ({
                        name: l.prospectName,
                        outcome: l.outcome,
                        calledAt: l.calledAt,
                        phone: l.phone,
              })),
              stats: {
                        totalToday,
                        answered,
                        voicemails,
                        busyFailed,
                        avgDuration,
                        hotLeads,
              },
      });
    } catch (err) {
          console.error("GET /api/call-monitor:", err.message);
          res.status(500).json({ error: err.message });
    }
});

app.get("/api/call-history/:airtableId", async (req, res) => {
    try {
          const records = await CallLogTable.select({
                  filterByFormula: `{ProspectId} = '${req.params.airtableId}'`,
                  sort: [{ field: "CalledAt", direction: "desc" }],
          }).all();
          res.json({ history: records.map(r => ({ id: r.id, outcome: r.fields.Outcome || "", attemptNumber: r.fields.AttemptNumber || 1, calledAt: r.fields.CalledAt || "", callId: r.fields.CallId || "" })) });
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
                  } catch(e) { results.push({ name: place.name, address: place.formatted_address, phone: "", placeId: place.place_id }); }
          }
          res.json({ results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/vapi-webhook", async (req, res) => {
    res.sendStatus(200);
    try {
          const msg = req.body?.message;
          if (msg?.type !== "end-of-call-report") return;
          const callId = msg.call?.id || "";
          const airtableId = msg.call?.assistantOverrides?.variableValues?.airtableId || msg.assistantOverrides?.variableValues?.airtableId;
          const phone = msg.call?.customer?.number || "";
          const summary = (msg.summary || "").toLowerCase();
          const endedBy = msg.endedReason || "";
          let outcome = "unknown";
          if (["customer-did-not-pick-up","no-answer"].includes(endedBy)) outcome = "no-answer";
          else if (endedBy === "voicemail") outcome = "voicemail";
          else if (endedBy === "silence-timed-out") outcome = "silence-timed-out";
          else if (endedBy === "customer-busy") outcome = "customer-busy";
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
                  if ((outcome === "demo-sent" || outcome === "completed") && phone && DEMO_VIDEO_URL) {
                            console.log(`SENDING SMS to ${phone}...`);
                            await sendSMS(phone, `Hey! This is Andrew from AQ Solutions. Here's the 2-min AI demo I mentioned: ${DEMO_VIDEO_URL}\nBook a call: ${CALENDLY_URL || ""}`).catch(e => console.warn("SMS failed:", e.message));
                  }
          }
          console.log(`Webhook: outcome=${outcome} | phone=${phone} | airtableId=${airtableId} | summary=${summary} | endedBy=${endedBy} | DEMO_VIDEO_URL=${DEMO_VIDEO_URL}`);
    } catch (err) { console.error("Webhook error:", err); }
});

app.get("/api/test-sms", async (req, res) => {
    try {
          const to = req.query.phone;
          if (!to) return res.json({ error: "Add ?phone=+1XXXXXXXXXX" });
          console.log("TEST SMS to", to, "DEMO_VIDEO_URL=", DEMO_VIDEO_URL);
          if (!TWILIO_ACCOUNT_SID) return res.json({ error: "No TWILIO_ACCOUNT_SID set" });
          if (!DEMO_VIDEO_URL) return res.json({ error: "No DEMO_VIDEO_URL set" });
          await sendSMS(to, "Test from AQ Solutions: " + (DEMO_VIDEO_URL || "NO URL SET"));
          res.json({ success: true, sent_to: to });
    } catch (err) { res.json({ error: err.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`AQ Outreach Bot running on port ${PORT}`));

// ─── SCHEDULER ──────────────────────────────────────────────────────────────
let autoCallEnabled = false;
let schedulerInterval = null;

function getNextCallTime() {
    const now = new Date();
    const nowET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const nextET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    nextET.setHours(8, 0, 0, 0);
    if (nowET >= nextET) nextET.setDate(nextET.getDate() + 1);
    const diff = nextET - nowET;
    return new Date(now.getTime() + diff);
}

function msUntil8am() { return getNextCallTime().getTime() - Date.now(); }

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
                            const s = r.fields.Status || "";
                            const tier = r.fields.PriorityTier || "NEW";
                            return !!r.fields.Phone && s !== "calling" && s !== "demo-sent" && s !== "not-interested" && tier !== "COLD" && tier !== "HOT";
                  });
                  console.log(`Auto-call: firing ${callable.length} calls`);
                  for (const record of callable) {
                            try {
                                        await safeUpdate(record.id, { Status: "calling" });
                                        await makeVapiCall(record.fields.Phone, record.fields.Name || "Owner", record.id, record.fields.Business || "");
                            } catch (e) { console.error(`Auto-call failed for ${record.fields.Name}:`, e.message); }
                            await new Promise(r => setTimeout(r, 1500));
                  }
          } catch (e) { console.error("Auto-call error:", e.message); }
          scheduleAutoCall();
    }, ms);
}

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

app.get("/api/scheduler/status", (req, res) => {
    const next = autoCallEnabled ? getNextCallTime().toISOString() : null;
    res.json({ enabled: autoCallEnabled, nextCall: next });
});
