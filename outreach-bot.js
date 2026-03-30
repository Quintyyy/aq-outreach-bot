const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

let prospects = [
  { id: 1,  name: "Dave Cortes",    business: "All Systems Heating",        phone: "+17329080428", status: "pending", notes: "Closes 5pm, no weekend coverage", called: false, result: null, calledAt: null },
  { id: 2,  name: "Owner",          business: "MyGuy Plumbing",             phone: "+17328632775", status: "pending", notes: "Closes 5pm, Ryan is owner",       called: false, result: null, calledAt: null },
  { id: 3,  name: "Owner",          business: "A.D.E. Heating",             phone: "+16096936050", status: "pending", notes: "Closes 4pm",                      called: false, result: null, calledAt: null },
  { id: 4,  name: "Owner",          business: "BC Express",                 phone: "+17322402828", status: "pending", notes: "Closes 5pm",                      called: false, result: null, calledAt: null },
  { id: 5,  name: "Owner",          business: "Mathis Bros Sewer",          phone: "+17324587633", status: "pending", notes: "Closes 4pm",                      called: false, result: null, calledAt: null },
  { id: 6,  name: "Owner",          business: "Proficient Plumbing",        phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 7,  name: "Robert Garon",   business: "Garon T Plumbing",           phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 8,  name: "Chris Walton",   business: "Chris Walton Sr Plumbing",   phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 9,  name: "Owner",          business: "Bailey Plumbing",            phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 10, name: "Jay",            business: "Kettle's Heating",           phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 11, name: "Raymond",        business: "Raymond James Hoben",        phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 12, name: "Owner",          business: "Lezgus Plumbing",            phone: "+18005402618", status: "pending", notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 13, name: "Owner",          business: "Care Temp LLC",              phone: "+18557888367", status: "pending", notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 14, name: "Owner",          business: "Murawski Plumbing",          phone: "+17325262989", status: "pending", notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 15, name: "Will",           business: "Comfort Zone Home Services", phone: "",             status: "pending", notes: "Has Facebook page",               called: false, result: null, calledAt: null },
];

const SARAH_SYSTEM_PROMPT = `You are Sarah, a friendly and natural-sounding sales rep calling on behalf of AQ Solutions. You're based in Ocean County, New Jersey. Your boss Andrew built an AI system that answers business calls 24/7 for plumbing and HVAC companies.

## YOUR PERSONALITY
- You sound like a real local person, NOT a robot or telemarketer
- You're warm, casual, and respectful of their time
- You speak naturally with small talk and verbal fillers like "yeah", "honestly", "you know"
- You NEVER sound scripted or pushy
- If they're busy, you're cool about it — offer to call back or text them info
- You have a slight New Jersey casual tone

## CALL FLOW

### 1. OPENING
- "Hey, is this [contact name]? My name's Sarah, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds."

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
    systemPrompt: SARAH_SYSTEM_PROMPT,
    tools: [
      {
        type: "function",
        function: {
          name: "send_demo_video",
          description: "Send the prospect a text message with the demo video link.",
          parameters: {
            type: "object",
            properties: {
              phone: { type: "string" },
              businessName: { type: "string" },
              contactName: { type: "string" }
            },
            required: ["phone", "businessName"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "book_demo_call",
          description: "Book a demo call with Andrew.",
          parameters: {
            type: "object",
            properties: {
              phone: { type: "string" },
              contactName: { type: "string" },
              businessName: { type: "string" },
              preferredTime: { type: "string" },
              email: { type: "string" }
            },
            required: ["phone", "contactName", "businessName"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "log_call_result",
          description: "Log the outcome of the call. ALWAYS call this at the end of every call.",
          parameters: {
            type: "object",
            properties: {
              outcome: { type: "string", enum: ["interested", "demo_sent", "demo_booked", "callback_requested", "not_interested", "voicemail", "no_answer", "wrong_number"] },
              contactName: { type: "string" },
              businessName: { type: "string" },
              notes: { type: "string" },
              hasAfterHoursCoverage: { type: "boolean" }
            },
            required: ["outcome", "businessName"]
          }
        }
      }
    ],
  },
  voice: {
    provider: "11labs",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    stability: 0.6,
    similarityBoost: 0.75,
  },
  firstMessage: "Hey, is this {{customerName}}? My name's Sarah, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds.",
  serverUrl: process.env.WEBHOOK_URL || "https://YOUR-RAILWAY-URL.up.railway.app/vapi/outreach-webhook",
  endCallPhrases: ["goodbye", "have a good one", "take care"],
  maxDurationSeconds: 300,
};

let twilioClient;
try {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (e) {
  console.log('[TWILIO] Client not initialized:', e.message);
}

let callLog = [];

app.get('/api/prospects', (req, res) => {
  res.json({ prospects, stats: getStats() });
});

app.post('/api/prospects', (req, res) => {
  const { name, business, phone, notes } = req.body;
  const newProspect = { id: prospects.length + 1, name: name || "Owner", business, phone, status: "pending", notes: notes || "", called: false, result: null, calledAt: null };
  prospects.push(newProspect);
  res.json({ success: true, prospect: newProspect });
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
      } catch (err) {
        prospect.status = "call_failed";
      }
    }, i * delayBetweenCalls * 1000);
    results.push({ id: prospect.id, business: prospect.business, scheduledIn: `${i * delayBetweenCalls}s` });
  }

  res.json({ message: `Queued ${pendingWithPhone.length} calls`, schedule: results });
});

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
          if (prospect) { prospect.status = "demo_sent"; prospect.result = "demo_sent"; }
          callLog.push({ type: 'demo_sent', phone: args.phone, business: args.businessName, timestamp: new Date().toISOString() });
          results.push({ name: fnName, result: "Demo SMS sent" });
        } catch (err) {
          results.push({ name: fnName, result: `SMS failed: ${err.message}` });
        }
        break;
      }

      case 'book_demo_call': {
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/aqsolutions';
        const bookingSms = `Hey ${args.contactName || 'there'}! Here's the link to book your AQ Solutions demo with Andrew:\n\n📅 ${calendlyLink}\n\nPick any time that works!`;

        try {
          if (twilioClient && args.phone) await twilioClient.messages.create({ body: bookingSms, from: process.env.TWILIO_PHONE, to: args.phone });
          const prospect = prospects.find(p => p.phone === args.phone);
          if (prospect) { prospect.status = "demo_booked"; prospect.result = "demo_booked"; }
          callLog.push({ type: 'demo_booked', phone: args.phone, business: args.businessName, timestamp: new Date().toISOString() });
          results.push({ name: fnName, result: "Booking link sent" });
        } catch (err) {
          results.push({ name: fnName, result: `Booking SMS failed: ${err.message}` });
        }
        break;
      }

      case 'log_call_result': {
        const prospect = prospects.find(p => p.business.toLowerCase().includes((args.businessName || '').toLowerCase()));
        if (prospect) {
          prospect.status = args.outcome;
          prospect.result = args.outcome;
          prospect.notes += ` | Result: ${args.outcome}. ${args.notes || ''}`;
        }
        callLog.push({ type: 'call_result', outcome: args.outcome, business: args.businessName, notes: args.notes, timestamp: new Date().toISOString() });
        results.push({ name: fnName, result: "Call logged" });
        break;
      }

      default:
        results.push({ name: fnName, result: "Unknown function" });
    }
  }

  res.json({ results });
});

app.get('/api/call-log', (req, res) => { res.json({ log: callLog, stats: getStats() }); });

app.get('/api/stats', (req, res) => { res.json(getStats()); });

app.get('/', (req, res) => { res.json({ service: "AQ Solutions Outreach Bot", status: "online", prospects: prospects.length, stats: getStats() }); });

async function triggerVapiCall(prospect) {
  const vapiApiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!vapiApiKey) throw new Error('VAPI_API_KEY not set');
  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID not set');

  const assistantConfig = { ...OUTBOUND_ASSISTANT_CONFIG };
  assistantConfig.firstMessage = assistantConfig.firstMessage.replace('{{customerName}}', prospect.name !== 'Owner' ? prospect.name : 'the owner');

  const response = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumberId, customer: { number: prospect.phone, name: prospect.name }, assistant: assistantConfig, metadata: { prospectId: prospect.id, businessName: prospect.business } }),
  });

  if (!response.ok) { const errText = await response.text(); throw new Error(`Vapi API error ${response.status}: ${errText}`); }
  const data = await response.json();
  return data;
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

app.listen(PORT, () => { console.log(`🚀 AQ Solutions Outreach Bot running on port ${PORT}`); });
