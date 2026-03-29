// ============================================================
// AQ Solutions — Outreach Bot (Vapi Outbound Calling Engine)
// ============================================================
// Deploy alongside your existing estimate-recovery on Railway,
// or as a separate Railway service.
//
// ENV VARS NEEDED:
//   VAPI_API_KEY        — from vapi.ai dashboard
//   TWILIO_ACCOUNT_SID  — from console.twilio.com
//   TWILIO_AUTH_TOKEN    — from console.twilio.com
//   TWILIO_PHONE        — +17329367514
//   VAPI_PHONE_NUMBER_ID — from Vapi dashboard (Phone Numbers section)
//   CALENDLY_LINK       — your Calendly booking URL
//   DEMO_VIDEO_URL      — link to your demo video (YouTube/Loom/etc)
//   PORT                — defaults to 3001
// ============================================================

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ─── PROSPECT DATABASE (in-memory, persists via Railway volume or replace with Airtable) ───
let prospects = [
  // Pre-loaded with your Ocean County prospect list
  { id: 1,  name: "Dave Cortes",    business: "All Systems Heating",     phone: "+17329080428", status: "pending",  notes: "Closes 5pm, no weekend coverage", called: false, result: null, calledAt: null },
  { id: 2,  name: "Owner",          business: "MyGuy Plumbing",          phone: "+17328632775", status: "pending",  notes: "Closes 5pm, Ryan is owner",       called: false, result: null, calledAt: null },
  { id: 3,  name: "Owner",          business: "A.D.E. Heating",          phone: "+16096936050", status: "pending",  notes: "Closes 4pm",                      called: false, result: null, calledAt: null },
  { id: 4,  name: "Owner",          business: "BC Express",              phone: "+17322402828", status: "pending",  notes: "Closes 5pm",                      called: false, result: null, calledAt: null },
  { id: 5,  name: "Owner",          business: "Mathis Bros Sewer",       phone: "+17324587633", status: "pending",  notes: "Closes 4pm",                      called: false, result: null, calledAt: null },
  { id: 6,  name: "Owner",          business: "Proficient Plumbing",     phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 7,  name: "Robert Garon",   business: "Garon T Plumbing",       phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 8,  name: "Chris Walton",   business: "Chris Walton Sr Plumbing",phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 9,  name: "Owner",          business: "Bailey Plumbing",         phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 10, name: "Jay",            business: "Kettle's Heating",        phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 11, name: "Raymond",        business: "Raymond James Hoben",     phone: "",             status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
  { id: 12, name: "Owner",          business: "Lezgus Plumbing",         phone: "+18005402618", status: "pending",  notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 13, name: "Owner",          business: "Care Temp LLC",           phone: "+18557888367", status: "pending",  notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 14, name: "Owner",          business: "Murawski Plumbing",       phone: "+17325262989", status: "pending",  notes: "No Facebook — call only",         called: false, result: null, calledAt: null },
  { id: 15, name: "Will",           business: "Comfort Zone Home Services", phone: "",          status: "pending",  notes: "Has Facebook page",               called: false, result: null, calledAt: null },
];

// ─── VAPI OUTBOUND ASSISTANT CONFIG ───
// You'll create this assistant in Vapi dashboard OR via API
const OUTBOUND_ASSISTANT_CONFIG = {
  name: "AQ Solutions - Sales Outreach",
  model: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.7,
    systemPrompt: `You are Sarah, a friendly and natural-sounding sales rep calling on behalf of AQ Solutions. You're based in Ocean County, New Jersey. Your boss Andrew built an AI system that answers business calls 24/7 for plumbing and HVAC companies.

## YOUR PERSONALITY
- You sound like a real local person, NOT a robot or telemarketer
- You're warm, casual, and respectful of their time
- You speak naturally with small talk and verbal fillers like "yeah", "honestly", "you know"
- You NEVER sound scripted or pushy
- If they're busy, you're cool about it — offer to call back or text them info
- You have a slight New Jersey casual tone

## CALL FLOW

### 1. OPENING (keep it casual, under 10 seconds)
- "Hey, is this [contact name or 'the owner']? My name's Sarah, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds."
- If they say they're busy: "No worries at all, I can text you the info or call back whenever works. What's better?"

### 2. QUALIFYING QUESTION
- "So quick question — do you guys have somebody handling your phones after hours? Like nights and weekends, when calls come in?"
- Listen to their answer carefully.

If YES (they have coverage):
- "Oh nice, that's great — most companies around here don't. Just out of curiosity, is that a live person or an answering service?"
- If answering service: Pivot to "Yeah, a lot of companies are moving away from those because callers hate talking to generic operators. Our system actually sounds like a real employee and can book appointments, handle emergencies, text you details — way more than an answering service."
- If live person: "That's solid. Well if you ever want a backup or want to save on that cost, we built something pretty cool. Can I send you a quick 90-second demo?"

If NO (no after-hours coverage):
- "Yeah that's super common around here. So here's why I'm calling — we built a system that basically answers your calls 24/7 when you can't pick up. It handles emergencies, books appointments, takes quote requests, and texts you all the details instantly."
- "We're working with plumbing and HVAC companies specifically here in Ocean County."

### 3. PITCH (only if they're engaged — keep it under 30 seconds)
- "Basically what it does is — when a call comes in that you'd miss, our AI picks up. It sounds like a real person, asks the right questions, figures out if it's an emergency, books the appointment if needed, and then texts you and emails you the full summary. You never miss a lead again."
- "The cool part is it costs way less than hiring someone or using an answering service."

### 4. CLOSE (try one of these based on the vibe)

Option A — Send demo video:
- "I've got a quick 90-second video that shows exactly how it works. Want me to text it to this number?"
- If yes: call the send_demo_video function with their phone number

Option B — Book a demo call:
- "Would you want to hop on a quick 15-minute call with Andrew? He can set up a free trial for you to test it out. He's got some time [tomorrow/this week]."
- If yes: call the book_demo_call function with their info

Option C — They want to think about it:
- "Totally get it. Let me text you the demo video and my info so you've got it whenever you're ready. No pressure at all."
- Call send_demo_video function

### 5. HANDLING OBJECTIONS

"I'm not interested":
- "No worries at all. Mind if I ask — do you ever get calls after hours that you end up missing? Just curious."
- If they engage, circle back. If firm no: "Totally understand. If you ever want to check it out, just Google AQ Solutions. Have a good one!"

"How much does it cost?":
- "It starts at $497 a month, which honestly is way less than what most companies pay for an answering service. And the AI actually books appointments and handles emergencies — it doesn't just take messages."
- "Andrew usually does a free 7-day trial so you can see it work on your real calls before paying anything."

"Is this a robot calling me?":
- Be honest: "Ha — I'm actually an AI assistant, yeah. But that's kind of the point, right? If I sound this natural on a sales call, imagine how good our system sounds when it's answering your customers' calls. Want me to send you the demo so you can hear it?"

"I already have a system":
- "Oh nice, what do you use? ... Yeah our system is a bit different because [differentiate]. But hey, if you're covered you're covered. Want me to send the demo just in case you ever want to compare?"

"Call me back later":
- "Sure thing. When's a good time? ... Perfect, I'll have Andrew give you a call then. And let me text you the demo video in the meantime so you can check it out when you get a chance."

## IMPORTANT RULES
- NEVER be pushy. If they say no twice, respect it and wrap up politely.
- ALWAYS try to at least send the demo video — it's the lowest commitment ask.
- Keep the total call under 3 minutes unless they're really engaged.
- Sound HUMAN. Use contractions, casual language, and be conversational.
- If you reach a voicemail, leave a short message: "Hey, this is Sarah calling from AQ Solutions here in Ocean County. We help plumbing and HVAC companies catch every call 24/7. I'll text you a quick demo — check it out when you get a chance. Have a great day!"
- After leaving a voicemail, call the send_demo_video function to text them the demo.
- Reference Ocean County / local NJ to build trust.
- NEVER make up information about the product. Stick to what's described above.`,
  },
  voice: {
    provider: "11labs",
    voiceId: "21m00Tcm4TlvDq8ikWAM", // "Rachel" — natural female voice. Change if you prefer another.
    stability: 0.6,
    similarityBoost: 0.75,
  },
  firstMessage: "Hey, is this {{customerName}}? My name's Sarah, I work with a company called AQ Solutions right here in Ocean County. Got a real quick question for you if you've got 30 seconds.",
  // ─── TOOL DEFINITIONS (Vapi will call your webhook when these trigger) ───
  tools: [
    {
      type: "function",
      function: {
        name: "send_demo_video",
        description: "Send the prospect a text message with the demo video link and Andrew's contact info. Call this whenever the prospect agrees to receive the demo or when leaving a voicemail.",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "The prospect's phone number to text the demo to"
            },
            businessName: {
              type: "string",
              description: "The name of the prospect's business"
            },
            contactName: {
              type: "string",
              description: "The name of the person on the call"
            }
          },
          required: ["phone", "businessName"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "book_demo_call",
        description: "Book a demo call with Andrew. Collect the prospect's preferred day/time and contact info.",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "The prospect's phone number"
            },
            contactName: {
              type: "string",
              description: "The name of the person to meet with"
            },
            businessName: {
              type: "string",
              description: "The business name"
            },
            preferredTime: {
              type: "string",
              description: "When they want to meet (e.g., 'tomorrow morning', 'Thursday afternoon')"
            },
            email: {
              type: "string",
              description: "Their email address if provided"
            }
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
            outcome: {
              type: "string",
              enum: ["interested", "demo_sent", "demo_booked", "callback_requested", "not_interested", "voicemail", "no_answer", "wrong_number"],
              description: "The result of the call"
            },
            contactName: {
              type: "string",
              description: "Name of person spoken to"
            },
            businessName: {
              type: "string",
              description: "Business name"
            },
            notes: {
              type: "string",
              description: "Any relevant notes about the call (objections, interests, callback time, etc.)"
            },
            hasAfterHoursCoverage: {
              type: "boolean",
              description: "Whether they currently have after-hours phone coverage"
            }
          },
          required: ["outcome", "businessName"]
        }
      }
    }
  ],
  // Webhook where Vapi sends tool call requests
  serverUrl: "https://YOUR-RAILWAY-URL.up.railway.app/vapi/outreach-webhook",
  endCallPhrases: ["goodbye", "have a good one", "take care"],
  maxDurationSeconds: 300, // 5 min max per call
};

// ─── TWILIO CLIENT ───
let twilioClient;
try {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (e) {
  console.log('[TWILIO] Client not initialized:', e.message);
}

// ─── CALL LOG ───
let callLog = [];

// ============================================================
// API ROUTES
// ============================================================

// ─── GET /api/prospects — List all prospects ───
app.get('/api/prospects', (req, res) => {
  res.json({ prospects, stats: getStats() });
});

// ─── POST /api/prospects — Add a new prospect ───
app.post('/api/prospects', (req, res) => {
  const { name, business, phone, notes } = req.body;
  const newProspect = {
    id: prospects.length + 1,
    name: name || "Owner",
    business,
    phone,
    status: "pending",
    notes: notes || "",
    called: false,
    result: null,
    calledAt: null,
  };
  prospects.push(newProspect);
  res.json({ success: true, prospect: newProspect });
});

// ─── POST /api/call/:id — Trigger outbound call to a specific prospect ───
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

// ─── POST /api/call-batch — Call all pending prospects with phone numbers ───
app.post('/api/call-batch', async (req, res) => {
  const { delayBetweenCalls = 60 } = req.body; // seconds between calls
  const pendingWithPhone = prospects.filter(p => !p.called && p.phone && p.status === 'pending');

  if (pendingWithPhone.length === 0) {
    return res.json({ message: "No pending prospects with phone numbers to call" });
  }

  // Start first call immediately, queue the rest
  const results = [];
  for (let i = 0; i < pendingWithPhone.length; i++) {
    const prospect = pendingWithPhone[i];
    setTimeout(async () => {
      try {
        console.log(`[BATCH] Calling ${prospect.business} (${prospect.phone})...`);
        await triggerVapiCall(prospect);
        prospect.called = true;
        prospect.calledAt = new Date().toISOString();
        prospect.status = "calling";
      } catch (err) {
        console.error(`[BATCH ERROR] ${prospect.business}:`, err.message);
        prospect.status = "call_failed";
      }
    }, i * delayBetweenCalls * 1000);
    results.push({ id: prospect.id, business: prospect.business, scheduledIn: `${i * delayBetweenCalls}s` });
  }

  res.json({
    message: `Queued ${pendingWithPhone.length} calls`,
    delayBetweenCalls: `${delayBetweenCalls} seconds`,
    schedule: results
  });
});

// ─── POST /vapi/outreach-webhook — Handle Vapi tool calls during outreach calls ───
app.post('/vapi/outreach-webhook', async (req, res) => {
  const payload = req.body;
  console.log('[WEBHOOK] Received:', JSON.stringify(payload, null, 2));

  // Vapi sends tool calls in message.toolCalls
  const toolCalls = payload?.message?.toolCalls || [];
  const results = [];

  for (const toolCall of toolCalls) {
    const fnName = toolCall?.function?.name;
    const args = toolCall?.function?.arguments || {};

    console.log(`[TOOL CALL] ${fnName}`, args);

    switch (fnName) {
      case 'send_demo_video': {
        const demoUrl = process.env.DEMO_VIDEO_URL || 'https://aqsolutions.com/demo';
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/aqsolutions';
        const smsBody = `Hey${args.contactName ? ' ' + args.contactName : ''}! This is from AQ Solutions — here's the 90-second demo showing how our AI answers your calls 24/7:\n\n🎥 ${demoUrl}\n\nWant to try it free for 7 days? Book a quick call with Andrew:\n📅 ${calendlyLink}\n\nQuestions? Text or call Andrew directly: (848) 389-3351`;

        try {
          if (twilioClient && args.phone) {
            await twilioClient.messages.create({
              body: smsBody,
              from: process.env.TWILIO_PHONE,
              to: args.phone,
            });
            console.log(`[SMS] Demo sent to ${args.phone}`);
          }
          // Update prospect status
          const prospect = prospects.find(p => p.phone === args.phone);
          if (prospect) {
            prospect.status = "demo_sent";
            prospect.result = "demo_sent";
          }
          // Log it
          callLog.push({
            type: 'demo_sent',
            phone: args.phone,
            business: args.businessName,
            contact: args.contactName,
            timestamp: new Date().toISOString(),
          });
          results.push({ name: fnName, result: "Demo video SMS sent successfully" });
        } catch (err) {
          console.error('[SMS ERROR]', err.message);
          results.push({ name: fnName, result: `SMS failed: ${err.message}. Let the prospect know you'll have Andrew text them directly.` });
        }
        break;
      }

      case 'book_demo_call': {
        const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/aqsolutions';
        // Send booking link via SMS
        const bookingSms = `Hey ${args.contactName || 'there'}! Here's the link to book your AQ Solutions demo with Andrew:\n\n📅 ${calendlyLink}\n\nPick any time that works for you. Talk soon!`;

        try {
          if (twilioClient && args.phone) {
            await twilioClient.messages.create({
              body: bookingSms,
              from: process.env.TWILIO_PHONE,
              to: args.phone,
            });
            console.log(`[SMS] Booking link sent to ${args.phone}`);
          }
          // Update prospect
          const prospect = prospects.find(p => p.phone === args.phone);
          if (prospect) {
            prospect.status = "demo_booked";
            prospect.result = "demo_booked";
          }
          callLog.push({
            type: 'demo_booked',
            phone: args.phone,
            business: args.businessName,
            contact: args.contactName,
            preferredTime: args.preferredTime,
            email: args.email,
            timestamp: new Date().toISOString(),
          });
          results.push({ name: fnName, result: `Demo booking link sent. ${args.contactName} prefers: ${args.preferredTime || 'no preference given'}` });
        } catch (err) {
          console.error('[SMS ERROR]', err.message);
          results.push({ name: fnName, result: `Booking SMS failed. Tell them Andrew will reach out directly at (848) 389-3351.` });
        }
        break;
      }

      case 'log_call_result': {
        const prospect = prospects.find(p =>
          p.business.toLowerCase().includes((args.businessName || '').toLowerCase())
        );
        if (prospect) {
          prospect.status = args.outcome;
          prospect.result = args.outcome;
          prospect.notes += ` | Result: ${args.outcome}. ${args.notes || ''}`;
          if (args.hasAfterHoursCoverage !== undefined) {
            prospect.notes += ` | Has after-hours coverage: ${args.hasAfterHoursCoverage}`;
          }
        }
        callLog.push({
          type: 'call_result',
          outcome: args.outcome,
          business: args.businessName,
          contact: args.contactName,
          notes: args.notes,
          hasAfterHoursCoverage: args.hasAfterHoursCoverage,
          timestamp: new Date().toISOString(),
        });
        console.log(`[CALL RESULT] ${args.businessName}: ${args.outcome}`);
        results.push({ name: fnName, result: "Call logged successfully" });
        break;
      }

      default:
        results.push({ name: fnName, result: "Unknown function" });
    }
  }

  // Vapi expects this response format
  res.json({ results });
});

// ─── GET /api/call-log — View all call activity ───
app.get('/api/call-log', (req, res) => {
  res.json({ log: callLog, stats: getStats() });
});

// ─── GET /api/stats — Dashboard stats ───
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ─── Health check ───
app.get('/', (req, res) => {
  res.json({
    service: "AQ Solutions Outreach Bot",
    status: "online",
    prospects: prospects.length,
    called: prospects.filter(p => p.called).length,
    stats: getStats()
  });
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function triggerVapiCall(prospect) {
  const vapiApiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!vapiApiKey) throw new Error('VAPI_API_KEY not set');
  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID not set');

  // Replace the template variable in firstMessage
  const assistantConfig = { ...OUTBOUND_ASSISTANT_CONFIG };
  assistantConfig.firstMessage = assistantConfig.firstMessage.replace(
    '{{customerName}}',
    prospect.name !== 'Owner' ? prospect.name : 'the owner'
  );

  const response = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${vapiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phoneNumberId: phoneNumberId,
      customer: {
        number: prospect.phone,
        name: prospect.name,
      },
      assistant: assistantConfig,
      // Metadata to track which prospect this call is for
      metadata: {
        prospectId: prospect.id,
        businessName: prospect.business,
      }
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vapi API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  console.log(`[VAPI] Call initiated to ${prospect.business} (${prospect.phone}): ${data.id}`);
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
    callbackRequested: prospects.filter(p => p.status === 'callback_requested').length,
  };
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 AQ Solutions Outreach Bot running on port ${PORT}`);
  console.log(`📋 ${prospects.length} prospects loaded`);
  console.log(`📞 ${prospects.filter(p => p.phone).length} have phone numbers`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /api/prospects     — View all prospects`);
  console.log(`  POST /api/prospects     — Add a prospect`);
  console.log(`  POST /api/call/:id      — Call a specific prospect`);
  console.log(`  POST /api/call-batch    — Call all pending prospects`);
  console.log(`  GET  /api/call-log      — View call activity log`);
  console.log(`  GET  /api/stats         — Dashboard stats`);
  console.log(`  POST /vapi/outreach-webhook — Vapi tool call handler\n`);
});
