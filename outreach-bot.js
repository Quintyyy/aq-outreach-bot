const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ═══════════════════════════════════════════
// AIRTABLE CONFIG
// ═══════════════════════════════════════════
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_PROSPECTS_TABLE = process.env.AIRTABLE_PROSPECTS_TABLE || 'Prospects';
const AIRTABLE_CALL_LOG_TABLE = process.env.AIRTABLE_CALL_LOG_TABLE || 'CallLog';

function airtableUrl(table, recordId) {
  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
  return recordId ? `${base}/${recordId}` : base;
}

function airtableHeaders() {
  return { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };
}

async function airtableFetch(table, options = {}) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
  const url = airtableUrl(table, options.recordId);
  const queryParams = options.params ? '?' + new URLSearchParams(options.params).toString() : '';
  const res = await fetch(url + queryParams, {
    method: options.method || 'GET',
    headers: airtableHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[AIRTABLE ERROR] ${res.status}: ${errText}`);
    return null;
  }
  return res.json();
}

// ═══════════════════════════════════════════
// LOAD PROSPECTS FROM AIRTABLE ON STARTUP
// ═══════════════════════════════════════════
let prospects = [];
let callLog = [];
let airtableReady = false;

const SEED_PROSPECTS = [
  { name: "Dave Cortes", business: "All Systems Heating", phone: "+17329080428", status: "pending", notes: "Closes 5pm, no weekend coverage" },
  { name: "Owner", business: "MyGuy Plumbing", phone: "+17328632775", status: "pending", notes: "Closes 5pm, Ryan is owner" },
  { name: "Owner", business: "A.D.E. Heating", phone: "+16096936050", status: "pending", notes: "Closes 4pm" },
  { name: "Owner", business: "BC Express", phone: "+17322402828", status: "pending", notes: "Closes 5pm" },
  { name: "Owner", business: "Mathis Bros Sewer", phone: "+17324587633", status: "pending", notes: "Closes 4pm" },
  { name: "Owner", business: "Proficient Plumbing", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Robert Garon", business: "Garon T Plumbing", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Chris Walton", business: "Chris Walton Sr Plumbing", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Owner", business: "Bailey Plumbing", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Jay", business: "Kettle's Heating", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Raymond", business: "Raymond James Hoben", phone: "", status: "pending", notes: "Has Facebook page" },
  { name: "Owner", business: "Lezgus Plumbing", phone: "+18005402618", status: "pending", notes: "No Facebook — call only" },
  { name: "Owner", business: "Care Temp LLC", phone: "+18557888367", status: "pending", notes: "No Facebook — call only" },
  { name: "Owner", business: "Murawski Plumbing", phone: "+17325262989", status: "pending", notes: "No Facebook — call only" },
  { name: "Will", business: "Comfort Zone Home Services", phone: "", status: "pending", notes: "Has Facebook page" },
];

async function loadProspectsFromAirtable() {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log('[AIRTABLE] No API key or Base ID — using in-memory data');
    prospects = SEED_PROSPECTS.map((p, i) => ({ id: i + 1, ...p, called: false, result: null, calledAt: null, airtableId: null }));
    return;
  }
  try {
    const data = await airtableFetch(AIRTABLE_PROSPECTS_TABLE);
    if (data && data.records && data.records.length > 0) {
      prospects = data.records.map((r, i) => ({
        id: i + 1, airtableId: r.id,
        name: r.fields.Name || 'Owner', business: r.fields.Business || '',
        phone: r.fields.Phone || '', status: r.fields.Status || 'pending',
        notes: r.fields.Notes || '', called: r.fields.Called || false,
        result: r.fields.Result || null, calledAt: r.fields.CalledAt || null,
      }));
      console.log(`[AIRTABLE] Loaded ${prospects.length} prospects`);
    } else {
      console.log('[AIRTABLE] Empty table — seeding...');
      for (const p of SEED_PROSPECTS) {
        const created = await airtableFetch(AIRTABLE_PROSPECTS_TABLE, {
          method: 'POST',
          body: { fields: { Name: p.name, Business: p.business, Phone: p.phone, Status: p.status, Notes: p.notes, Called: false } },
        });
        if (created) {
          prospects.push({ id: prospects.length + 1, airtableId: created.id, name: p.name, business: p.business, phone: p.phone, status: p.status, notes: p.notes, called: false, result: null, calledAt: null });
        }
      }
      console.log(`[AIRTABLE] Seeded ${prospects.length} prospects`);
    }
    airtableReady = true;
  } catch (err) {
    console.error('[AIRTABLE] Failed to load:', err.message);
    prospects = SEED_PROSPECTS.map((p, i) => ({ id: i + 1, ...p, called: false, result: null, calledAt: null, airtableId: null }));
  }
}

async function syncProspectToAirtable(prospect) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  const fields = { Name: prospect.name, Business: prospect.business, Phone: prospect.phone, Status: prospect.status, Notes: prospect.notes, Called: prospect.called, Result: prospect.result || '', CalledAt: prospect.calledAt || '' };
  if (prospect.airtableId) {
    await airtableFetch(AIRTABLE_PROSPECTS_TABLE, { method: 'PATCH', recordId: prospect.airtableId, body: { fields } });
  } else {
    const created = await airtableFetch(AIRTABLE_PROSPECTS_TABLE, { method: 'POST', body: { fields } });
    if (created) prospect.airtableId = created.id;
  }
}

async function logCallToAirtable(entry) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  await airtableFetch(AIRTABLE_CALL_LOG_TABLE, {
    method: 'POST',
    body: { fields: { Type: entry.type, Outcome: entry.outcome || '', Business: entry.business || '', Phone: entry.phone || '', Notes: entry.notes || '', Timestamp: entry.timestamp } },
  });
}

// ═══════════════════════════════════════════
// JOSH VOICE CONFIG
// ═══════════════════════════════════════════
const JOSH_SYSTEM_PROMPT = `You are Josh, a friendly and natural-sounding sales rep calling on behalf of AQ Solutions. You're based in Ocean County, New Jersey. Your boss Andrew built an AI system that answers business calls 24/7 for plumbing and HVAC companies.

## YOUR PERSONALITY
- You sound like a real local guy, NOT a robot or telemarketer
- You're warm, casual, and respectful of their time
- You speak naturally with small talk and verbal fillers like "yeah", "honestly", "you know"
- You NEVER sound scripted or pushy
- If they're busy, you're cool about it — offer to call back or text them info
- You have a slight New Jersey casual tone

## CALL FLOW

### 1. OPENING
- "Hey, is this [contact name]? My name's Josh, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds."

### 2. QUALIFYING QUESTION
- "So quick question — do you guys have somebody handling your phones after hours? Like nights and weekends, when calls come in?"

### 3. PITCH
- "Basically what it does is — when a call comes in that you'd miss, our AI picks up. It sounds like a real person, asks the right questions, figures out if it's an emergency, books the appointment if needed, and then texts you and emails you the full summary. You never miss a lead again."

### 4. CLOSE
- Option A: "I've got a quick 90-second video that shows exactly how it works. Want me to text it to this number?"
- Option B: "Would you want to hop on a quick 15-minute call with Andrew?"

### 5. OBJECTIONS
- "I'm not interested": "No worries at all. Mind if I ask — do you ever get calls after hours that you end up missing?"
- "How much?": "It starts at $497 a month — way less than an answering service, and it actually books appointments."
- "Is this a robot?": "Ha — I'm actually an AI assistant, yeah. But that's kind of the point, right?"

## RULES
- NEVER be pushy. If they say no twice, wrap up politely.
- ALWAYS try to at least send the demo video.
- Keep the total call under 3 minutes unless they're really engaged.
- If voicemail: leave short message then call send_demo_video function.
- ALWAYS call log_call_result at the end of every call.`;

const OUTBOUND_ASSISTANT_CONFIG = {
  name: "AQ Solutions - Sales Outreach",
  model: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.7,
    systemPrompt: JOSH_SYSTEM_PROMPT,
    tools: [
      { type: "function", function: { name: "send_demo_video", description: "Send the prospect a text message with the demo video link.", parameters: { type: "object", properties: { phone: { type: "string" }, businessName: { type: "string" }, contactName: { type: "string" } }, required: ["phone", "businessName"] } } },
      { type: "function", function: { name: "book_demo_call", description: "Book a demo call with Andrew.", parameters: { type: "object", properties: { phone: { type: "string" }, contactName: { type: "string" }, businessName: { type: "string" }, preferredTime: { type: "string" }, email: { type: "string" } }, required: ["phone", "contactName", "businessName"] } } },
      { type: "function", function: { name: "log_call_result", description: "Log the outcome of the call. ALWAYS call this at the end of every call.", parameters: { type: "object", properties: { outcome: { type: "string", enum: ["interested", "demo_sent", "demo_booked", "callback_requested", "not_interested", "voicemail", "no_answer", "wrong_number"] }, contactName: { type: "string" }, businessName: { type: "string" }, notes: { type: "string" }, hasAfterHoursCoverage: { type: "boolean" } }, required: ["outcome", "businessName"] } } },
    ],
  },
  voice: { provider: "11labs", voiceId: "TxGEqnHWrfWFTfGW9XjX", stability: 0.6, similarityBoost: 0.75 },
  firstMessage: "Hey, is this {{customerName}}? My name's Josh, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds.",
  serverUrl: process.env.WEBHOOK_URL || "https://YOUR-RAILWAY-URL.up.railway.app/vapi/outreach-webhook",
  endCallPhrases: ["goodbye", "have a good one", "take care"],
  maxDurationSeconds: 300,
};

let twilioClient;
try {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (e) { console.log('[TWILIO] Client not initialized:', e.message); }

// ═══════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════
app.get('/api/prospects', (req, res) => { res.json({ prospects, stats: getStats() }); });

app.post('/api/prospects', async (req, res) => {
  const { name, business, phone, notes } = req.body;
  const newProspect = { id: prospects.length + 1, airtableId: null, name: name || "Owner", business, phone: phone || '', status: "pending", notes: notes || "", called: false, result: null, calledAt: null };
  prospects.push(newProspect);
  await syncProspectToAirtable(newProspect);
  res.json({ success: true, prospect: newProspect });
});

app.put('/api/prospects/:id', async (req, res) => {
  const prospect = prospects.find(p => p.id === parseInt(req.params.id));
  if (!prospect) return res.status(404).json({ error: "Prospect not found" });
  const { name, business, phone, notes, status } = req.body;
  if (name !== undefined) prospect.name = name;
  if (business !== undefined) prospect.business = business;
  if (phone !== undefined) prospect.phone = phone;
  if (notes !== undefined) prospect.notes = notes;
  if (status !== undefined) prospect.status = status;
  await syncProspectToAirtable(prospect);
  res.json({ success: true, prospect });
});

app.delete('/api/prospects/:id', async (req, res) => {
  const idx = prospects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Prospect not found" });
  const prospect = prospects[idx];
  if (prospect.airtableId && AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
    await airtableFetch(AIRTABLE_PROSPECTS_TABLE, { method: 'DELETE', recordId: prospect.airtableId });
  }
  prospects.splice(idx, 1);
  res.json({ success: true });
});

app.post('/api/call/:id', async (req, res) => {
  const prospect = prospects.find(p => p.id === parseInt(req.params.id));
  if (!prospect) return res.status(404).json({ error: "Prospect not found" });
  if (!prospect.phone) return res.status(400).json({ error: "No phone number for this prospect" });
  try {
    const callResult = await triggerVapiCall(prospect);
    prospect.called = true;
    prospect.calledAt = new Date().toISOString();
    prospect.status = "calling";
    await syncProspectToAirtable(prospect);
    res.json({ success: true, call: callResult, prospect });
  } catch (err) {
    console.error('[CALL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/call-batch', async (req, res) => {
  const { delayBetweenCalls = 60 } = req.body;
  const pendingWithPhone = prospects.filter(p => !p.called && p.phone && p.status === 'pending');
  if (pendingWithPhone.length === 0) return res.json({ message: "No pending prospects with phone numbers" });
  const results = [];
  for (let i = 0; i < pendingWithPhone.length; i++) {
    const prospect = pendingWithPhone[i];
    setTimeout(async () => {
      try {
        await triggerVapiCall(prospect);
        prospect.called = true;
        prospect.calledAt = new Date().toISOString();
        prospect.status = "calling";
        await syncProspectToAirtable(prospect);
      } catch (err) { prospect.status = "call_failed"; await syncProspectToAirtable(prospect); }
    }, i * delayBetweenCalls * 1000);
    results.push({ id: prospect.id, business: prospect.business, scheduledIn: `${i * delayBetweenCalls}s` });
  }
  res.json({ message: `Queued ${pendingWithPhone.length} calls`, schedule: results });
});

app.post('/api/reset-prospect/:id', async (req, res) => {
  const prospect = prospects.find(p => p.id === parseInt(req.params.id));
  if (!prospect) return res.status(404).json({ error: "Prospect not found" });
  prospect.status = 'pending'; prospect.called = false; prospect.result = null; prospect.calledAt = null;
  await syncProspectToAirtable(prospect);
  res.json({ success: true, prospect });
});

// ═══════════════════════════════════════════
// VAPI WEBHOOK
// ═══════════════════════════════════════════
app.post('/vapi/outreach-webhook', async (req, res) => {
  const payload = req.body;
  const toolCalls = payload?.message?.toolCalls || [];
  const results = [];

  for (const toolCall of toolCalls) {
    const fnName = toolCall?.function?.name;
    const args = toolCall?.function?.arguments || {};

    switch (fnName) {
      case 'send_demo_video': {
        const demoUrl = process.env.DEMO_VIDEO_URL || 'https://aqsolutions.com/demo';
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/aqsolutions';
        const smsBody = `Hey${args.contactName ? ' ' + args.contactName : ''}! This is from AQ Solutions — here's the 90-second demo:\n\n🎥 ${demoUrl}\n\nWant to try it free for 7 days? Book a call:\n📅 ${calendlyLink}\n\nQuestions? Text Andrew: (848) 389-3351`;
        try {
          if (twilioClient && args.phone) await twilioClient.messages.create({ body: smsBody, from: process.env.TWILIO_PHONE, to: args.phone });
          const prospect = prospects.find(p => p.phone === args.phone);
          if (prospect) { prospect.status = "demo_sent"; prospect.result = "demo_sent"; await syncProspectToAirtable(prospect); }
          const logEntry = { type: 'demo_sent', phone: args.phone, business: args.businessName, timestamp: new Date().toISOString() };
          callLog.push(logEntry); await logCallToAirtable(logEntry);
          results.push({ name: fnName, result: "Demo SMS sent" });
        } catch (err) { results.push({ name: fnName, result: `SMS failed: ${err.message}` }); }
        break;
      }
      case 'book_demo_call': {
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/aqsolutions';
        const bookingSms = `Hey ${args.contactName || 'there'}! Here's the link to book your AQ Solutions demo with Andrew:\n\n📅 ${calendlyLink}\n\nPick any time that works!`;
        try {
          if (twilioClient && args.phone) await twilioClient.messages.create({ body: bookingSms, from: process.env.TWILIO_PHONE, to: args.phone });
          const prospect = prospects.find(p => p.phone === args.phone);
          if (prospect) { prospect.status = "demo_booked"; prospect.result = "demo_booked"; await syncProspectToAirtable(prospect); }
          const logEntry = { type: 'demo_booked', phone: args.phone, business: args.businessName, timestamp: new Date().toISOString() };
          callLog.push(logEntry); await logCallToAirtable(logEntry);
          results.push({ name: fnName, result: "Booking link sent" });
        } catch (err) { results.push({ name: fnName, result: `Booking SMS failed: ${err.message}` }); }
        break;
      }
      case 'log_call_result': {
        const prospect = prospects.find(p => p.business.toLowerCase().includes((args.businessName || '').toLowerCase()));
        if (prospect) {
          prospect.status = args.outcome; prospect.result = args.outcome;
          prospect.notes += ` | Result: ${args.outcome}. ${args.notes || ''}`;
          await syncProspectToAirtable(prospect);
        }
        const logEntry = { type: 'call_result', outcome: args.outcome, business: args.businessName, notes: args.notes, timestamp: new Date().toISOString() };
        callLog.push(logEntry); await logCallToAirtable(logEntry);
        results.push({ name: fnName, result: "Call logged" });
        break;
      }
      default: results.push({ name: fnName, result: "Unknown function" });
    }
  }
  res.json({ results });
});

app.get('/api/call-log', (req, res) => { res.json({ log: callLog, stats: getStats() }); });
app.get('/api/stats', (req, res) => { res.json(getStats()); });

// ═══════════════════════════════════════════
// SERVE DASHBOARD
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  } else {
    res.json({ service: "AQ Solutions Outreach Bot", status: "online", prospects: prospects.length, stats: getStats(), airtable: airtableReady });
  }
});

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
async function triggerVapiCall(prospect) {
  const vapiApiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!vapiApiKey) throw new Error('VAPI_API_KEY not set');
  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID not set');
  const assistantConfig = JSON.parse(JSON.stringify(OUTBOUND_ASSISTANT_CONFIG));
  assistantConfig.firstMessage = assistantConfig.firstMessage.replace('{{customerName}}', prospect.name !== 'Owner' ? prospect.name : 'the owner');
  const response = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumberId, customer: { number: prospect.phone, name: prospect.name }, assistant: assistantConfig, metadata: { prospectId: prospect.id, businessName: prospect.business } }),
  });
  if (!response.ok) { const errText = await response.text(); throw new Error(`Vapi API error ${response.status}: ${errText}`); }
  return response.json();
}

function getStats() {
  return {
    totalProspects: prospects.length,
    pending: prospects.filter(p => p.status === 'pending').length,
    called: prospects.filter(p => p.called).length,
    interested: prospects.filter(p => ['interested', 'demo_sent', 'demo_booked'].includes(p.status)).length,
    demosSent: prospects.filter(p => p.status === 'demo_sent').length,
    demosBooked: prospects.filter(p => p.status === 'demo_booked').length,
    notInterested: prospects.filter(p => p.status === 'not_interested').length,
    voicemails: prospects.filter(p => p.status === 'voicemail').length,
  };
}

loadProspectsFromAirtable().then(() => {
  app.listen(PORT, () => { console.log(`🚀 AQ Solutions Outreach Bot running on port ${PORT}`); });
});
