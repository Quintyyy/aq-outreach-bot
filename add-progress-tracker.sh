#!/bin/bash
# Run from ~/aq-outreach-bot
# Adds real-time call progress tracking

echo "Updating outreach-bot.js with call progress tracking..."

cat > outreach-bot.js << 'ENDOFFILE'
import express from "express";
import twilio from "twilio";
import { readFileSync } from "fs";

const app = express();
app.use(express.json());

const {
  VAPI_API_KEY,
  VAPI_PHONE_NUMBER_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE,
  CALENDLY_LINK,
  DEMO_VIDEO_URL,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  GOOGLE_PLACES_API_KEY,
  PORT = 3001,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Live call progress tracker ──────────────────────────────
var callProgress = {
  running: false,
  total: 0,
  completed: 0,
  current: null,
  results: [],
  startedAt: null,
};

// ── Airtable helpers ────────────────────────────────────────

const atFetch = (path, opts = {}) => {
  const qIdx = path.indexOf("?");
  const table = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? "" : path.slice(qIdx);
  const url = "https://api.airtable.com/v0/" + AIRTABLE_BASE_ID + "/" + encodeURIComponent(table) + query;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: "Bearer " + AIRTABLE_API_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  }).then((r) => r.json());
};

async function getProspects() {
  const params = new URLSearchParams({
    filterByFormula: 'AND(NOT({Called}), {Phone} != "")',
    maxRecords: "100",
  });
  const data = await atFetch("Prospects?" + params.toString());
  return (data.records || []).map((r) => ({
    id: r.id,
    name: r.fields["Name"] || "Owner",
    business: r.fields["Business"] || "",
    phone: r.fields["Phone"] || "",
  }));
}

async function getAllExistingPhones() {
  const params = new URLSearchParams({ pageSize: "100" });
  var phones = new Set();
  var offset;
  do {
    if (offset) params.set("offset", offset);
    var data = await atFetch("Prospects?" + params.toString());
    (data.records || []).forEach(function(r) {
      if (r.fields.Phone) phones.add(r.fields.Phone);
    });
    offset = data.offset;
  } while (offset);
  return phones;
}

async function markCalled(recordId, result) {
  await atFetch("Prospects/" + recordId, {
    method: "PATCH",
    body: JSON.stringify({
      fields: { Called: true, Result: result, CalledAt: new Date().toISOString() },
    }),
  });
}

async function logCall({ type, outcome, business, phone }) {
  await atFetch("CallLog", {
    method: "POST",
    body: JSON.stringify({
      records: [{ fields: { Type: type, Outcome: outcome, Business: business, Phone: phone, Timestamp: new Date().toISOString() } }],
    }),
  });
}

// ── Mike system prompt ──────────────────────────────────────

function buildSystemPrompt(p) {
  return "You are Mike, an outreach assistant for AQ Solutions — a company that helps plumbing and HVAC businesses in New Jersey recover lost revenue from missed calls using AI-powered call answering.\n\nYou are calling " + p.name + " at " + p.business + ".\n\n## YOUR PERSONALITY\n- You are warm, casual, and confident — like a real person from Jersey, not a robot\n- Use natural verbal fillers occasionally: so, honestly, like, yeah, look\n- Keep your sentences short. Never ramble.\n- You are NOT pushy. One soft close, then respect their answer.\n- Never say as an AI or anything that sounds scripted or robotic\n- If they ask if you are a robot or AI, be honest but pivot: Yeah, I am an AI assistant — but the system I am calling about is really for your business. Can I take 30 more seconds?\n- Total call time goal: under 3 minutes\n\n## CALL FLOW\n\n### STEP 1 — OPENING (do not skip)\nSay exactly this first message, then stop and listen:\nHi, is this " + p.name + "? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?\n\nIf they say yes or seem open, go to Step 2.\nIf they say no or seem annoyed, say No worries at all, I will let you go. Have a good one! and end the call.\n\n### STEP 2 — QUALIFYING QUESTION\nAsk ONE of these, pick naturally based on flow:\n- So quick question — when you are on a job or it is after hours, what happens to your missed calls? Do they just go to voicemail?\n- Do you ever lose jobs because someone called while you were busy and ended up calling the next guy?\n\nListen to their answer. Acknowledge it before pitching.\n\n### STEP 3 — THE PITCH (keep it to 3-4 sentences max)\nSo what AQ Solutions does is — we set up an AI that answers every call you miss, 24/7. It talks to the customer, gets their info, tells them you will call back, and logs everything. So you never lose a lead just because you were on a job. A lot of guys in Jersey are using it now.\n\n### STEP 4 — CLOSE\nOffer ONE of the following based on their vibe:\n\nIf they seem curious or positive:\nI can shoot you a 2-minute demo video right now — no signup, nothing. You just watch it and see if it makes sense for your business. Want me to text it to you?\n\nIf they seem more serious or analytical:\nWould it make sense to grab 15 minutes on a call? I can show you exactly how it works and what it would cost. I can text you a link to pick a time.\n\nAlways try to send the demo video first — it is the lower-friction ask.\n\n### STEP 5 — IF THEY AGREE TO VIDEO OR BOOKING\nSay: Perfect — what is the best number to text you at? if different from what you called.\nThen call the send_demo_video or book_demo_call tool immediately.\nConfirm: Sent! Check your texts. And hey — no pressure at all, just watch it when you get a chance.\nThen wrap up: Alright, I will let you go. Thanks for your time, " + p.name + ". Have a good one!\n\n## OBJECTION HANDLERS\n\nNot interested or Dont need it\nSay: Totally get it — honestly most guys say that until they lose a big job to a missed call. I am not here to sell you anything today, just wanted to see if it made sense. No worries at all.\nThen try one last soft offer: I can still shoot you the video just so you have it — no pressure.\nIf they say no again, end the call gracefully.\n\nHow much does it cost?\nSay: So it depends on your call volume — it is typically way less than losing one job. The demo video actually covers the pricing. Want me to shoot that over?\n\nIs this a robot? or Are you AI?\nSay: Yeah, I am an AI assistant — but honestly, what I am calling about is for your business, not mine. Can I take 30 more seconds to explain?\n\nI already have something like that or I use a competitor\nSay: Oh nice — yeah there are a few out there. A lot of guys still switch over once they see how AQ Solutions handles the actual conversation, not just voicemail. But hey, if it is working for you, that is what matters.\n\nCall me back later or Not a good time\nSay: Of course — I will get out of your hair. Is there a better time, or should I just try again tomorrow?\nIf they give a time, say: Got it, I will make a note. Thanks " + p.name + "! and end the call.\nIf vague, say: No problem at all, take care! and end the call.\n\nHow did you get my number?\nSay: Your business info is listed publicly — we just reach out to local contractors in Jersey. Nothing weird, I promise.\n\n## VOICEMAIL SCRIPT\nIf you reach voicemail, leave this message and hang up:\nHey, this is Mike calling from AQ Solutions — we help plumbing and HVAC businesses in Jersey stop losing jobs to missed calls. I will shoot you a quick text with a short demo video. No obligation, just take a look when you get a chance. Have a good one!\nThen immediately call the log_call_result tool with outcome voicemail.\n\n## TOOLS — WHEN TO CALL THEM\n- send_demo_video: call this when the prospect agrees to receive the video\n- book_demo_call: call this when the prospect wants to schedule a call\n- log_call_result: ALWAYS call this at the very end of every call, no exceptions\n\n## RULES\n- Never make up pricing numbers\n- Never promise specific results or guarantees\n- Never be rude or argue, even if they are dismissive\n- If they hang up, do not call back\n- Keep the total call under 3 minutes\n- Always end on a positive, friendly note";
}

function buildAssistant(prospect) {
  return {
    name: "Mike",
    model: {
      provider: "openai", model: "gpt-4o",
      messages: [{ role: "system", content: buildSystemPrompt(prospect) }],
      tools: [
        { type: "function", function: { name: "send_demo_video", description: "Send the prospect a text message with the AQ Solutions demo video link.", parameters: { type: "object", properties: { name: { type: "string", description: "The prospect first name" } }, required: ["name"] } } },
        { type: "function", function: { name: "book_demo_call", description: "Send the Calendly booking link via SMS.", parameters: { type: "object", properties: { name: { type: "string", description: "The prospect first name" } }, required: ["name"] } } },
        { type: "function", function: { name: "log_call_result", description: "Log the final outcome of the call. MUST be called at the end of every call.", parameters: { type: "object", properties: { outcome: { type: "string", enum: ["interested", "not interested", "voicemail", "no answer", "callback requested", "demo video sent", "booking link sent"], description: "The result of the call" }, notes: { type: "string", description: "Any relevant notes" } }, required: ["outcome"] } } },
      ],
    },
    voice: { provider: "11labs", voiceId: "eN7WPylhvgvOGdskN6bn" },
    firstMessage: "Hi, is this " + prospect.name + "? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?",
  };
}

async function createVapiCall(prospect) {
  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: { Authorization: "Bearer " + VAPI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: { number: prospect.phone },
      assistant: buildAssistant(prospect),
      metadata: { airtableId: prospect.id, business: prospect.business, name: prospect.name, phone: prospect.phone },
    }),
  });
  return res.json();
}

// ── Routes ──────────────────────────────────────────────────

app.get("/", function(req, res) { res.json({ status: "AQ Outreach Bot running", ts: new Date().toISOString() }); });
app.get("/dashboard", function(req, res) { res.setHeader("Content-Type", "text/html"); res.send(readFileSync("./dashboard.html", "utf-8")); });

app.post("/call", async function(req, res) {
  try {
    var phone = req.body.phone, name = req.body.name || "Owner", business = req.body.business || "your business";
    if (!phone) return res.status(400).json({ error: "phone is required" });
    var result = await createVapiCall({ id: null, phone: phone, name: name, business: business });
    res.json({ success: true, callId: result.id, result: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/run", async function(req, res) {
  try {
    var p = await getProspects();
    if (!p.length) return res.json({ message: "No uncalled prospects with phone numbers." });

    // Initialize progress
    callProgress.running = true;
    callProgress.total = p.length;
    callProgress.completed = 0;
    callProgress.current = null;
    callProgress.results = [];
    callProgress.startedAt = new Date().toISOString();

    res.json({ message: "Run started", total: p.length });

    for (var i = 0; i < p.length; i++) {
      callProgress.current = { index: i + 1, name: p[i].name, business: p[i].business, phone: p[i].phone, status: "dialing" };
      try {
        var call = await createVapiCall(p[i]);
        console.log("Called " + p[i].name + " at " + p[i].business + " — callId: " + call.id);
        callProgress.current.status = "in-call";
        callProgress.current.callId = call.id;
        callProgress.results.push({ name: p[i].name, business: p[i].business, phone: p[i].phone, status: "called", callId: call.id });
      } catch (err) {
        console.error("Failed to call " + p[i].name + ": " + err.message);
        callProgress.results.push({ name: p[i].name, business: p[i].business, phone: p[i].phone, status: "failed", error: err.message });
      }
      callProgress.completed = i + 1;

      if (i < p.length - 1) {
        callProgress.current = { index: i + 1, name: p[i].name, business: p[i].business, status: "waiting", nextIn: 90 };
        // Countdown the wait
        for (var s = 90; s > 0; s--) {
          callProgress.current.nextIn = s;
          await new Promise(function(r) { setTimeout(r, 1000); });
        }
      }
    }

    callProgress.running = false;
    callProgress.current = null;
  } catch (err) {
    console.error("Run error:", err);
    callProgress.running = false;
    callProgress.current = null;
  }
});

// ── Call Progress endpoint ──────────────────────────────────
app.get("/progress", function(req, res) {
  res.json(callProgress);
});

app.post("/vapi/outreach-webhook", async function(req, res) {
  var message = req.body.message;
  if (!message) return res.sendStatus(200);

  if (message.type === "tool-calls") {
    var toolCallList = message.toolCallList || [];
    var callPhone = message.call && message.call.customer ? message.call.customer.number : "";
    var results = [];
    for (var i = 0; i < toolCallList.length; i++) {
      var tc = toolCallList[i];
      var tname = tc.name || (tc.function ? tc.function.name : "");
      var params = tc.parameters || (tc.function ? tc.function.parameters : {}) || {};
      var id = tc.id;
      if (tname === "send_demo_video") {
        try { await twilioClient.messages.create({ body: "Hey " + (params.name || "there") + "! Here is a quick 2-min demo of AQ Solutions: " + DEMO_VIDEO_URL + " — No pressure, just take a look when you get a chance!", from: "+1" + TWILIO_PHONE, to: callPhone }); console.log("Demo video SMS sent to " + callPhone); results.push({ toolCallId: id, name: tname, result: "Demo video sent via SMS successfully." }); } catch (e) { results.push({ toolCallId: id, name: tname, result: "SMS failed: " + e.message }); }
      } else if (tname === "book_demo_call") {
        try { await twilioClient.messages.create({ body: "Hey " + (params.name || "there") + "! Here is the link to book your free 15-min AQ Solutions demo: " + CALENDLY_LINK, from: "+1" + TWILIO_PHONE, to: callPhone }); console.log("Calendly SMS sent to " + callPhone); results.push({ toolCallId: id, name: tname, result: "Calendly booking link sent via SMS successfully." }); } catch (e) { results.push({ toolCallId: id, name: tname, result: "SMS failed: " + e.message }); }
      } else if (tname === "log_call_result") {
        var outcome = params.outcome || "unknown"; console.log("Call outcome logged mid-call: " + outcome); results.push({ toolCallId: id, name: tname, result: "Outcome " + outcome + " noted." });
        // Update progress with outcome
        if (callProgress.current) callProgress.current.outcome = outcome;
      } else { results.push({ toolCallId: id, name: tname, result: "Unknown tool" }); }
    }
    return res.json({ results: results });
  }

  if (message.type === "end-of-call-report") {
    var call = message.call || {};
    var meta = call.metadata || {};
    var oc = message.endedReason || "unknown";
    try {
      if (meta.airtableId) await markCalled(meta.airtableId, oc);
      await logCall({ type: "outbound", outcome: oc, business: meta.business || "", phone: meta.phone || (call.customer ? call.customer.number : "") || "" });
      console.log("End-of-call logged — " + (meta.business || "unknown") + " — " + oc);
      // Update progress result with final outcome
      if (callProgress.results.length > 0) {
        for (var j = callProgress.results.length - 1; j >= 0; j--) {
          if (callProgress.results[j].phone === (meta.phone || "")) {
            callProgress.results[j].outcome = oc;
            break;
          }
        }
      }
    } catch (err) { console.error("Airtable update error:", err.message); }
    return res.sendStatus(200);
  }
  res.sendStatus(200);
});

// ── Dashboard API routes ────────────────────────────────────

app.get("/prospects", async function(req, res) {
  try {
    var params = new URLSearchParams({ pageSize: "100" });
    var allRecords = [], offset;
    do { if (offset) params.set("offset", offset); var data = await atFetch("Prospects?" + params.toString()); allRecords = allRecords.concat(data.records || []); offset = data.offset; } while (offset);
    var prospects = allRecords.map(function(r) { return { id: r.id, name: r.fields["Name"] || "", business: r.fields["Business"] || "", phone: r.fields["Phone"] || "", called: r.fields["Called"] || false, result: r.fields["Result"] || "", calledAt: r.fields["CalledAt"] || null }; });
    res.json({ total: prospects.length, prospects: prospects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/call-log", async function(req, res) {
  try {
    var params = new URLSearchParams({ pageSize: "100", "sort[0][field]": "Timestamp", "sort[0][direction]": "desc" });
    var allRecords = [], offset;
    do { if (offset) params.set("offset", offset); var data = await atFetch("CallLog?" + params.toString()); allRecords = allRecords.concat(data.records || []); offset = data.offset; } while (offset);
    var logs = allRecords.map(function(r) { return { id: r.id, type: r.fields["Type"] || "", outcome: r.fields["Outcome"] || "", business: r.fields["Business"] || "", phone: r.fields["Phone"] || "", timestamp: r.fields["Timestamp"] || null }; });
    res.json({ total: logs.length, log: logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Prospect Management ─────────────────────────────────────

app.post("/prospects", async function(req, res) {
  try {
    var business = req.body.business, name = req.body.name, phone = req.body.phone, notes = req.body.notes;
    if (!business) return res.status(400).json({ error: "business is required" });
    if (phone) {
      var checkParams = new URLSearchParams({ filterByFormula: '{Phone} = "' + phone + '"', maxRecords: "1" });
      var existing = await atFetch("Prospects?" + checkParams.toString());
      if (existing.records && existing.records.length > 0) return res.json({ success: false, duplicate: true, existing: existing.records[0].fields });
    }
    var result = await atFetch("Prospects", { method: "POST", body: JSON.stringify({ records: [{ fields: { Name: name || "Owner", Business: business, Phone: phone || "", Notes: notes || "", Called: false } }] }) });
    res.json({ success: true, record: result.records ? result.records[0] : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/prospects/bulk", async function(req, res) {
  try {
    var items = req.body.prospects;
    if (!items || !items.length) return res.status(400).json({ error: "No prospects provided" });
    var existingPhones = await getAllExistingPhones();
    var newItems = items.filter(function(i) { return !i.phone || !existingPhones.has(i.phone); });
    var dupes = items.length - newItems.length;
    if (newItems.length === 0) return res.json({ success: true, added: 0, duplicates: dupes, message: "All prospects already exist" });
    var added = 0;
    for (var i = 0; i < newItems.length; i += 10) {
      var batch = newItems.slice(i, i + 10);
      var records = batch.map(function(p) { return { fields: { Name: p.name || "Owner", Business: p.business || "", Phone: p.phone || "", Notes: p.notes || "", Called: false } }; });
      await atFetch("Prospects", { method: "POST", body: JSON.stringify({ records: records }) });
      added += batch.length;
    }
    res.json({ success: true, added: added, duplicates: dupes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Google Places Prospect Finder ───────────────────────────

app.get("/search-prospects", async function(req, res) {
  try {
    var query = req.query.q;
    if (!query) return res.status(400).json({ error: "q parameter is required" });
    if (!GOOGLE_PLACES_API_KEY) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY not set" });
    var searchUrl = "https://maps.googleapis.com/maps/api/place/textsearch/json?query=" + encodeURIComponent(query) + "&key=" + GOOGLE_PLACES_API_KEY;
    var searchRes = await fetch(searchUrl);
    var searchData = await searchRes.json();
    if (!searchData.results || searchData.results.length === 0) return res.json({ total: 0, prospects: [] });
    var existingPhones = await getAllExistingPhones();
    var prospects = [];
    for (var i = 0; i < Math.min(searchData.results.length, 20); i++) {
      var place = searchData.results[i];
      var detailUrl = "https://maps.googleapis.com/maps/api/place/details/json?place_id=" + place.place_id + "&fields=name,formatted_phone_number,international_phone_number,formatted_address,rating,business_status,opening_hours&key=" + GOOGLE_PLACES_API_KEY;
      var detailRes = await fetch(detailUrl);
      var detailData = await detailRes.json();
      var detail = detailData.result || {};
      var phone = (detail.international_phone_number || "").replace(/[\s\-()]/g, "");
      if (phone && !phone.startsWith("+")) phone = "+1" + phone;
      prospects.push({ business: detail.name || place.name || "", address: detail.formatted_address || place.formatted_address || "", phone: phone, rating: detail.rating || place.rating || null, status: detail.business_status || "", alreadyInList: phone ? existingPhones.has(phone) : false });
    }
    res.json({ total: prospects.length, prospects: prospects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start server ────────────────────────────────────────────
app.listen(PORT, function() { console.log("AQ Outreach Bot listening on port " + PORT); });
ENDOFFILE

echo "outreach-bot.js written with progress tracking."
echo ""
echo "Writing dashboard.html with live progress UI..."

cat > dashboard.html << 'DASHEOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AQ Solutions — Outreach Command Center</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#0a0b14;color:#e2e8f0;min-height:100vh}.mono{font-family:'JetBrains Mono',monospace}
.header{padding:24px 28px 18px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.header-left{display:flex;align-items:center;gap:12px}.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff}
.header h1{font-size:20px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em}.header .sub{font-size:11px;color:#64748b;font-family:'JetBrains Mono',monospace;letter-spacing:0.05em}
.status-dot{width:7px;height:7px;border-radius:50%;display:inline-block}.status-dot.on{background:#10b981;box-shadow:0 0 8px #10b98180}.status-dot.off{background:#ef4444;box-shadow:0 0 8px #ef444480}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;padding:18px 28px}.stat{padding:14px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05)}
.stat-val{font-size:24px;font-weight:700;font-family:'JetBrains Mono',monospace}.stat-label{font-size:10px;color:#64748b;font-weight:500;margin-top:3px;letter-spacing:0.05em;text-transform:uppercase}
.actions{padding:0 28px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{padding:10px 20px;border-radius:9px;border:none;font-weight:600;font-size:13px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.15s}.btn:hover{filter:brightness(1.1)}
.btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff}.btn-primary:disabled{background:rgba(255,255,255,0.04);color:#4a5568;cursor:default}
.btn-green{background:linear-gradient(135deg,#10b981,#059669);color:#fff}.btn-secondary{background:rgba(255,255,255,0.03);color:#94a3b8;border:1px solid rgba(255,255,255,0.07)}
.btn-orange{background:linear-gradient(135deg,#f97316,#ea580c);color:#fff}.btn-red{background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.2)}
.tabs{padding:0 28px 12px;display:flex;gap:4px}.tab{padding:8px 16px;border-radius:8px;border:none;font-size:12px;font-weight:500;cursor:pointer;background:transparent;color:#64748b;font-family:'DM Sans',sans-serif}.tab.active{background:rgba(59,130,246,0.15);color:#60a5fa}
.list{padding:0 28px 28px;display:flex;flex-direction:column;gap:5px}
.row{display:flex;align-items:center;gap:12px;padding:12px 16px;background:rgba(255,255,255,0.015);border:1px solid rgba(255,255,255,0.04);border-radius:9px}
.row-icon{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0}
.row-info{flex:1;min-width:0}.row-biz{font-size:13px;font-weight:600;color:#f1f5f9}.row-meta{font-size:11px;color:#64748b;margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
.badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:500}
.btn-call{padding:7px 16px;border-radius:7px;border:none;font-weight:600;font-size:11px;background:rgba(59,130,246,0.1);color:#60a5fa;cursor:pointer;white-space:nowrap}.btn-call:disabled{opacity:0.5}
.btn-import{padding:6px 14px;border-radius:7px;border:none;font-weight:600;font-size:11px;background:rgba(16,185,129,0.12);color:#34d399;cursor:pointer;white-space:nowrap}.btn-import:disabled{opacity:0.4}
.empty{text-align:center;padding:50px;color:#4a5568}
.toast{position:fixed;top:20px;right:20px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:500;max-width:340px;backdrop-filter:blur(12px);transition:opacity 0.3s}
.toast.success{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399}.toast.error{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171}.toast.hidden{opacity:0;pointer-events:none}
.search-box{padding:14px 28px;display:none}.search-box.show{display:block}
.search-input{display:flex;gap:8px}.search-input input{flex:1;padding:10px 14px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:9px;color:#e2e8f0;font-size:13px;outline:none;font-family:'DM Sans',sans-serif}
.search-results{margin-top:12px}.search-hint{font-size:12px;color:#64748b;margin-bottom:10px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;z-index:999;backdrop-filter:blur(4px)}.modal-bg.show{display:flex}
.modal{background:#141525;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px;width:520px;max-width:95vw;max-height:90vh;overflow-y:auto}
.modal h2{font-size:16px;font-weight:600;color:#f1f5f9;margin-bottom:20px}.modal label{font-size:12px;color:#94a3b8;display:block;margin-bottom:6px;font-weight:500}
.modal input{width:100%;padding:10px 12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#e2e8f0;font-size:13px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:14px}
.modal .btn-row{display:flex;gap:10px;margin-top:6px}.modal .btn-row .btn{flex:1}
/* Progress panel */
.progress-panel{margin:0 28px 16px;padding:20px;border-radius:12px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.15);display:none}
.progress-panel.show{display:block}
.progress-bar-bg{width:100%;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;margin:12px 0;overflow:hidden}
.progress-bar{height:100%;background:linear-gradient(90deg,#3b82f6,#818cf8);border-radius:4px;transition:width 0.5s ease}
.progress-status{font-size:13px;color:#c4b5fd;font-weight:500;margin-bottom:4px}
.progress-detail{font-size:12px;color:#94a3b8;margin-top:4px}
.progress-current{font-size:14px;font-weight:600;color:#f1f5f9;margin-top:8px}
.progress-results{margin-top:12px;max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.progress-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,0.02);font-size:12px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.pulsing{animation:pulse 1.5s infinite}
</style>
</head>
<body>
<div id="toast" class="toast hidden"></div>
<div class="modal-bg" id="addModal"><div class="modal"><h2>Add Prospect</h2><label>Business Name *</label><input id="addBiz" placeholder="e.g. Joe's Plumbing"><label>Contact Name</label><input id="addName" placeholder="e.g. Joe"><label>Phone</label><input id="addPhone" placeholder="+17321234567"><label>Notes</label><input id="addNotes" placeholder="Found on Google Maps"><div class="btn-row"><button class="btn btn-green" onclick="submitAdd()">Add Prospect</button><button class="btn btn-secondary" onclick="closeModal('addModal')">Cancel</button></div></div></div>
<div class="header"><div class="header-left"><div class="logo">AQ</div><div><h1>AQ Solutions</h1><div class="sub">OUTREACH COMMAND CENTER</div></div></div><div style="display:flex;align-items:center;gap:8px"><span id="statusDot" class="status-dot off"></span><span id="statusLabel" class="mono" style="font-size:11px;color:#ef4444">OFFLINE</span></div></div>
<div class="stats" id="statsRow"></div>

<!-- Live Progress Panel -->
<div class="progress-panel" id="progressPanel">
  <div class="progress-status" id="progressStatus">Preparing calls...</div>
  <div class="progress-bar-bg"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
  <div class="progress-detail" id="progressDetail"></div>
  <div class="progress-current" id="progressCurrent"></div>
  <div class="progress-results" id="progressResults"></div>
</div>

<div class="actions">
<button class="btn btn-primary" id="btnRun" disabled>📞 Call All (0)</button>
<button class="btn btn-orange" onclick="toggleSearch()">🔍 Find Prospects</button>
<button class="btn btn-green" onclick="openModal('addModal')">+ Add</button>
<button class="btn btn-secondary" onclick="refresh()">↻ Refresh</button>
</div>
<div class="search-box" id="searchBox"><div class="search-input"><input id="searchQuery" placeholder="e.g. plumber Monmouth County NJ" onkeydown="if(event.key==='Enter')searchPlaces()"><button class="btn btn-orange" onclick="searchPlaces()" id="searchBtn">Search</button><button class="btn btn-green" onclick="importAllResults()" id="importAllBtn" style="display:none">Import All New</button></div><div class="search-hint">Search Google Maps for plumbing, HVAC, electrical, or any service business.</div><div class="search-results list" id="searchResults"></div></div>
<div class="tabs"><button class="tab active" id="tabProspects" onclick="switchTab('prospects')">Prospects (0)</button><button class="tab" id="tabCalllog" onclick="switchTab('calllog')">Call Log (0)</button></div>
<div id="content" class="list"></div>
<script>
var API=window.location.origin,prospects=[],callLog=[],searchResults=[],currentTab="prospects",calling=null;
var sc={"pending":{i:"\u25CB",c:"#94a3b8",b:"rgba(148,163,184,0.10)"},"interested":{i:"\u2605",c:"#38bdf8",b:"rgba(56,189,248,0.12)"},"demo video sent":{i:"\u25B6",c:"#34d399",b:"rgba(52,211,153,0.12)"},"booking link sent":{i:"\u2713",c:"#10b981",b:"rgba(16,185,129,0.15)"},"callback requested":{i:"\u21A9",c:"#c084fc",b:"rgba(192,132,252,0.12)"},"not interested":{i:"\u2715",c:"#64748b",b:"rgba(100,116,139,0.10)"},"voicemail":{i:"\u2709",c:"#fb923c",b:"rgba(251,146,60,0.12)"},"no answer":{i:"\u2715",c:"#f87171",b:"rgba(248,113,113,0.12)"},"unknown":{i:"?",c:"#64748b",b:"rgba(100,116,139,0.10)"},"customer-ended-call":{i:"\u260E",c:"#94a3b8",b:"rgba(148,163,184,0.10)"},"silence-timed-out":{i:"\u23F1",c:"#f97316",b:"rgba(249,115,22,0.12)"},"customer-busy":{i:"\u26A0",c:"#fbbf24",b:"rgba(251,191,36,0.12)"},"pipeline-error-eleven-labs-voice-not-found":{i:"\u2717",c:"#ef4444",b:"rgba(239,68,68,0.12)"}};
function gs(s){return sc[(s||"pending").toLowerCase()]||sc.unknown}
function showToast(m,t){var e=document.getElementById("toast");e.textContent=m;e.className="toast "+(t||"success");setTimeout(function(){e.className="toast hidden"},3500)}
function openModal(id){document.getElementById(id).className="modal-bg show"}
function closeModal(id){document.getElementById(id).className="modal-bg"}
function toggleSearch(){var b=document.getElementById("searchBox");b.className=b.className.includes("show")?"search-box":"search-box show"}

async function fetchProspects(){try{var r=await fetch(API+"/prospects");var d=await r.json();prospects=d.prospects||[];document.getElementById("statusDot").className="status-dot on";document.getElementById("statusLabel").style.color="#10b981";document.getElementById("statusLabel").textContent="LIVE"}catch(e){document.getElementById("statusDot").className="status-dot off";document.getElementById("statusLabel").style.color="#ef4444";document.getElementById("statusLabel").textContent="OFFLINE"}}
async function fetchCallLog(){try{var r=await fetch(API+"/call-log");var d=await r.json();callLog=d.log||d.logs||[]}catch(e){}}

// ── Progress Tracking ───────────────────────────────────────
async function fetchProgress(){
  try{
    var r=await fetch(API+"/progress");var d=await r.json();
    var panel=document.getElementById("progressPanel");
    if(d.running){
      panel.className="progress-panel show";
      var pct=d.total>0?Math.round((d.completed/d.total)*100):0;
      document.getElementById("progressBar").style.width=pct+"%";
      document.getElementById("progressStatus").innerHTML=(d.completed<d.total?'<span class="pulsing">\u25CF</span> ':'\u2713 ')+"Calling prospects — "+d.completed+" / "+d.total+" complete";
      var detail="";
      if(d.current){
        if(d.current.status==="dialing") detail='\u260E Dialing <strong>'+d.current.business+'</strong> ('+d.current.name+')...';
        else if(d.current.status==="in-call") detail='\uD83D\uDDE3 In call with <strong>'+d.current.business+'</strong>...';
        else if(d.current.status==="waiting") detail='\u23F3 Next call in <strong>'+d.current.nextIn+'s</strong> — just finished '+d.current.business;
      }
      document.getElementById("progressDetail").innerHTML=detail;
      // Results list
      if(d.results&&d.results.length>0){
        document.getElementById("progressResults").innerHTML=d.results.map(function(r){
          var st=gs(r.outcome||r.status);
          return'<div class="progress-row"><span style="color:'+st.c+'">'+st.i+'</span><span style="color:#f1f5f9;font-weight:500">'+r.business+'</span><span style="color:#64748b">'+(r.outcome||r.status||"")+'</span></div>';
        }).join("");
      }
    }else{
      if(d.results&&d.results.length>0&&d.startedAt){
        // Show completed state briefly
        panel.className="progress-panel show";
        document.getElementById("progressBar").style.width="100%";
        document.getElementById("progressStatus").innerHTML="\u2713 All calls complete — "+d.completed+" / "+d.total;
        document.getElementById("progressDetail").innerHTML="";
        document.getElementById("progressResults").innerHTML=d.results.map(function(r){
          var st=gs(r.outcome||r.status);
          return'<div class="progress-row"><span style="color:'+st.c+'">'+st.i+'</span><span style="color:#f1f5f9;font-weight:500">'+r.business+'</span><span style="color:#64748b">'+(r.outcome||r.status||"")+'</span></div>';
        }).join("");
      }else{
        panel.className="progress-panel";
      }
    }
  }catch(e){}
}

function renderStats(){var t=prospects.length,u=prospects.filter(function(p){return!p.called&&p.phone}).length,c=prospects.filter(function(p){return p.called}).length,np=prospects.filter(function(p){return!p.phone}).length,rs={};
prospects.forEach(function(p){var r=(p.result||"pending").toLowerCase();rs[r]=(rs[r]||0)+1});
var s=[{l:"Total",v:t,c:"#e2e8f0"},{l:"Uncalled",v:u,c:"#fbbf24"},{l:"Called",v:c,c:"#a78bfa"},{l:"Interested",v:rs.interested||0,c:"#38bdf8"},{l:"Demos Sent",v:rs["demo video sent"]||0,c:"#34d399"},{l:"Voicemails",v:rs.voicemail||0,c:"#fb923c"},{l:"No Phone",v:np,c:"#64748b"}];
document.getElementById("statsRow").innerHTML=s.map(function(x){return'<div class="stat"><div class="stat-val" style="color:'+x.c+'">'+x.v+'</div><div class="stat-label">'+x.l+'</div></div>'}).join("");
document.getElementById("btnRun").textContent="\uD83D\uDCDE Call All ("+u+")";document.getElementById("btnRun").disabled=u===0;
document.getElementById("tabProspects").textContent="Prospects ("+t+")";document.getElementById("tabCalllog").textContent="Call Log ("+callLog.length+")"}

function renderProspects(){var el=document.getElementById("content");
if(!prospects.length){el.innerHTML='<div class="empty"><div style="font-size:28px;margin-bottom:8px">\uD83D\uDCED</div><div>No prospects — use Find Prospects or + Add</div></div>';return}
el.innerHTML=prospects.map(function(p){var st=gs(p.result||(p.called?"unknown":"pending")),hp=!!p.phone,ic=calling===p.phone;
return'<div class="row"><div class="row-icon" style="background:'+st.b+';color:'+st.c+'">'+st.i+'</div><div class="row-info"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="row-biz">'+(p.business||p.name)+'</span><span class="badge" style="background:'+st.b+';color:'+st.c+'">'+(p.result||"Pending")+'</span></div><div class="row-meta"><span>'+p.name+'</span>'+(hp?'<span class="mono" style="font-size:10px">'+p.phone+'</span>':'<span style="font-style:italic;color:#4a5568">No phone</span>')+'</div></div>'+(hp&&!p.called?'<button class="btn-call" onclick="callOne(\''+p.phone+"','"+((p.name||"").replace(/'/g,"\\'"))+"','"+((p.business||"").replace(/'/g,"\\'"))+'\')"'+(ic?" disabled":"")+">"+(!ic?"\uD83D\uDCDE Call":"Dialing...")+"</button>":"")+(p.called?'<span class="mono" style="font-size:10px;color:#4a5568">'+(p.calledAt?new Date(p.calledAt).toLocaleDateString():"called")+"</span>":"")+"</div>"}).join("")}

function renderCallLog(){var el=document.getElementById("content");
if(!callLog.length){el.innerHTML='<div class="empty"><div style="font-size:28px;margin-bottom:8px">\uD83D\uDCCB</div><div>No calls logged yet</div></div>';return}
el.innerHTML=callLog.map(function(l){var st=gs(l.outcome);return'<div class="row"><div class="row-icon" style="background:'+st.b+';color:'+st.c+'">'+st.i+'</div><div class="row-info"><div class="row-biz">'+(l.business||"Unknown")+'</div><div class="row-meta"><span class="badge" style="background:'+st.b+';color:'+st.c+'">'+(l.outcome||"unknown")+'</span><span class="mono" style="font-size:10px">'+(l.phone||"")+"</span></div></div>"+'<span class="mono" style="font-size:10px;color:#4a5568;white-space:nowrap">'+(l.timestamp?new Date(l.timestamp).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"")+"</span></div>"}).join("")}

function switchTab(t){currentTab=t;document.getElementById("tabProspects").className=t==="prospects"?"tab active":"tab";document.getElementById("tabCalllog").className=t==="calllog"?"tab active":"tab";render()}
function render(){renderStats();if(currentTab==="prospects")renderProspects();else renderCallLog()}

async function callOne(ph,nm,bz){calling=ph;render();try{var r=await fetch(API+"/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:ph,name:nm,business:bz})});var d=await r.json();if(d.success||d.callId)showToast("Calling "+nm+"...");else showToast(d.error||"Call failed","error")}catch(e){showToast("Call failed","error")}setTimeout(function(){calling=null;render()},3000)}

document.getElementById("btnRun").onclick=async function(){this.disabled=true;this.textContent="\u23F3 Starting...";try{var r=await fetch(API+"/run",{method:"POST"});var d=await r.json();showToast(d.message||"Batch started — "+d.total+" prospects")}catch(e){showToast("Batch failed","error")}};

async function submitAdd(){var bz=document.getElementById("addBiz").value.trim(),nm=document.getElementById("addName").value.trim(),ph=document.getElementById("addPhone").value.trim(),nt=document.getElementById("addNotes").value.trim();
if(!bz){showToast("Business name required","error");return}
try{var r=await fetch(API+"/prospects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({business:bz,name:nm,phone:ph,notes:nt})});var d=await r.json();
if(d.duplicate){showToast("Duplicate — already exists","error");return}if(d.success){showToast("Added "+bz);closeModal("addModal");document.getElementById("addBiz").value="";document.getElementById("addName").value="";document.getElementById("addPhone").value="";document.getElementById("addNotes").value="";refresh()}else showToast(d.error||"Failed","error")}catch(e){showToast("Error","error")}}

async function searchPlaces(){var q=document.getElementById("searchQuery").value.trim();if(!q){showToast("Enter a search","error");return}
document.getElementById("searchBtn").textContent="Searching...";document.getElementById("searchBtn").disabled=true;
try{var r=await fetch(API+"/search-prospects?q="+encodeURIComponent(q));var d=await r.json();searchResults=d.prospects||[];renderSearchResults();
document.getElementById("importAllBtn").style.display=searchResults.filter(function(p){return p.phone&&!p.alreadyInList}).length>0?"inline-block":"none";
showToast("Found "+searchResults.length+" businesses")}catch(e){showToast("Search failed","error")}
document.getElementById("searchBtn").textContent="Search";document.getElementById("searchBtn").disabled=false}

function renderSearchResults(){var el=document.getElementById("searchResults");
if(!searchResults.length){el.innerHTML='<div class="empty"><div>No results found.</div></div>';return}
var nc=searchResults.filter(function(p){return p.phone&&!p.alreadyInList}).length;
el.innerHTML='<div style="font-size:12px;color:#94a3b8;margin-bottom:8px">'+searchResults.length+' found — '+nc+' new with phone numbers</div>'+searchResults.map(function(p,i){
var hp=!!p.phone,du=p.alreadyInList;
return'<div class="row"><div class="row-icon" style="background:'+(du?"rgba(251,191,36,0.12)":"rgba(52,211,153,0.12)")+';color:'+(du?"#fbbf24":"#34d399")+'">'+(du?"\u2713":"+")+'</div><div class="row-info"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="row-biz">'+p.business+'</span>'+(p.rating?'<span class="badge" style="background:rgba(251,191,36,0.12);color:#fbbf24">\u2605 '+p.rating+'</span>':'')+(du?'<span class="badge" style="background:rgba(251,191,36,0.12);color:#fbbf24">Already in list</span>':'')+'</div><div class="row-meta">'+(hp?'<span class="mono" style="font-size:10px">'+p.phone+'</span>':'<span style="color:#4a5568">No phone</span>')+'<span>'+p.address+'</span></div></div>'+(hp&&!du?'<button class="btn-import" onclick="importOne('+i+')">Import</button>':'')+'</div>'}).join("")}

async function importOne(i){var p=searchResults[i];if(!p)return;
try{var r=await fetch(API+"/prospects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({business:p.business,name:"Owner",phone:p.phone,notes:"Google Maps — "+p.address+(p.rating?" — Rating: "+p.rating:"")})});
var d=await r.json();if(d.duplicate)showToast("Already exists","error");else if(d.success){showToast("Imported "+p.business);p.alreadyInList=true;renderSearchResults();refresh()}else showToast(d.error||"Failed","error")}catch(e){showToast("Error","error")}}

async function importAllResults(){var nw=searchResults.filter(function(p){return p.phone&&!p.alreadyInList});
if(!nw.length){showToast("No new prospects","error");return}
var items=nw.map(function(p){return{business:p.business,name:"Owner",phone:p.phone,notes:"Google Maps — "+p.address+(p.rating?" — Rating: "+p.rating:"")}});
try{var r=await fetch(API+"/prospects/bulk",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prospects:items})});
var d=await r.json();if(d.success){showToast("Imported "+d.added+(d.duplicates?" ("+d.duplicates+" dupes skipped)":""));nw.forEach(function(p){p.alreadyInList=true});renderSearchResults();refresh()}else showToast(d.error||"Failed","error")}catch(e){showToast("Error","error")}}

async function refresh(){await fetchProspects();await fetchCallLog();render()}
(async function(){await fetchProspects();await fetchCallLog();render();
// Poll progress every 2 seconds, everything else every 8
setInterval(fetchProgress,2000);
setInterval(async function(){await fetchProspects();await fetchCallLog();render()},8000)})();
</script>
</body>
</html>
DASHEOF

echo ""
echo "=== All done! ==="
echo ""
echo "Run:"
echo "  git add outreach-bot.js dashboard.html"
echo '  git commit -m "feat: real-time call progress tracking"'
echo "  git push origin main"
echo ""
echo "Your dashboard now shows:"
echo "  - Live progress bar during batch calls"
echo "  - Which prospect is being called RIGHT NOW"
echo "  - Countdown timer between calls (90s)"
echo "  - Results updating in real-time as calls complete"
echo "  - All previous features (Find Prospects, Import, Call All, Call Log)"
