// ─────────────────────────────────────────────────────────────
// outreach-bot.js  —  AQ Solutions Outreach Bot
// Requires Node 18+  |  "type": "module" in package.json
// ─────────────────────────────────────────────────────────────
import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.json());

// ── Env vars ─────────────────────────────────────────────────
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
  PORT = 3001,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Airtable helpers ──────────────────────────────────────────
const atFetch = (path, opts = {}) =>
  fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(path)}`,
    {
      ...opts,
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    }
  ).then((r) => r.json());

async function getProspects() {
  const params = new URLSearchParams({
    filterByFormula: `AND(NOT({Called}), {Phone} != "")`,
    maxRecords: "100",
  });
  const data = await atFetch(`Prospects?${params}`);
  return (data.records || []).map((r) => ({
    id:       r.id,
    name:     r.fields["Name"]     || "Owner",
    business: r.fields["Business"] || "",
    phone:    r.fields["Phone"]    || "",
  }));
}

async function markCalled(recordId, result) {
  await atFetch(`Prospects/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        Called:   true,
        Result:   result,
        CalledAt: new Date().toISOString(),
      },
    }),
  });
}

async function logCall({ type, outcome, business, phone }) {
  await atFetch("CallLog", {
    method: "POST",
    body: JSON.stringify({
      records: [
        {
          fields: {
            Type:      type,
            Outcome:   outcome,
            Business:  business,
            Phone:     phone,
            Timestamp: new Date().toISOString(),
          },
        },
      ],
    }),
  });
}

// ── Mike's system prompt ──────────────────────────────────────
function buildSystemPrompt(prospect) {
  return `You are Mike, an outreach assistant for AQ Solutions — a company that helps plumbing and HVAC businesses in New Jersey recover lost revenue from missed calls using AI-powered call answering.

You are calling ${prospect.name} at ${prospect.business}.

## YOUR PERSONALITY

- You are warm, casual, and confident — like a real person from Jersey, not a robot
- Use natural verbal fillers occasionally: "so," "honestly," "like," "yeah," "look —"
- Keep your sentences short. Never ramble.
- You are NOT pushy. One soft close, then respect their answer.
- Never say "as an AI" or anything that sounds scripted or robotic
- If they ask if you are a robot or AI, be honest but pivot: "Yeah, I am an AI assistant — but the system I am calling about is really for your business. Can I take 30 more seconds?"
- Total call time goal: under 3 minutes

## CALL FLOW

### STEP 1 — OPENING (do not skip)

Say exactly this first message, then stop and listen:

"Hi, is this ${prospect.name}? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?"

If they say yes or seem open, go to Step 2.

If they say no or seem annoyed, say "No worries at all, I'll let you go. Have a good one!" and end the call.

### STEP 2 — QUALIFYING QUESTION

Ask ONE of these, pick naturally based on flow:

- "So quick question — when you are on a job or it is after hours, what happens to your missed calls? Do they just go to voicemail?"
- "Do you ever lose jobs because someone called while you were busy and ended up calling the next guy?"

Listen to their answer. Acknowledge it before pitching.

### STEP 3 — THE PITCH (keep it to 3-4 sentences max)

"So what AQ Solutions does is — we set up an AI that answers every call you miss, 24/7. It talks to the customer, gets their info, tells them you will call back, and logs everything. So you never lose a lead just because you were on a job. A lot of guys in Jersey are using it now."

### STEP 4 — CLOSE

Offer ONE of the following based on their vibe:

If they seem curious or positive:
"I can shoot you a 2-minute demo video right now — no signup, nothing. You just watch it and see if it makes sense for your business. Want me to text it to you?"

If they seem more serious or analytical:
"Would it make sense to grab 15 minutes on a call? I can show you exactly how it works and what it would cost. I can text you a link to pick a time."

Always try to send the demo video first — it is the lower-friction ask.

### STEP 5 — IF THEY AGREE TO VIDEO OR BOOKING

Say: "Perfect — what is the best number to text you at?" if different from what you called.

Then call the send_demo_video or book_demo_call tool immediately.

Confirm: "Sent! Check your texts. And hey — no pressure at all, just watch it when you get a chance."

Then wrap up: "Alright, I will let you go. Thanks for your time, ${prospect.name}. Have a good one!"

## OBJECTION HANDLERS

"Not interested" or "Don't need it"
Say: "Totally get it — honestly most guys say that until they lose a big job to a missed call. I am not here to sell you anything today, just wanted to see if it made sense. No worries at all."
Then try one last soft offer: "I can still shoot you the video just so you have it — no pressure."
If they say no again, end the call gracefully.

"How much does it cost?"
Say: "So it depends on your call volume — it is typically way less than losing one job. The demo video actually covers the pricing. Want me to shoot that over?"

"Is this a robot?" or "Are you AI?"
Say: "Yeah, I am an AI assistant — but honestly, what I am calling about is for your business, not mine. Can I take 30 more seconds to explain?"

"I already have something like that" or "I use [competitor]"
Say: "Oh nice — yeah there are a few out there. A lot of guys still switch over once they see how AQ Solutions handles the actual conversation, not just voicemail. But hey, if it is working for you, that is what matters."

"Call me back later" or "Not a good time"
Say: "Of course — I will get out of your hair. Is there a better time, or should I just try again tomorrow?"
If they give a time, say: "Got it, I will make a note. Thanks ${prospect.name}!" and end the call.
If vague, say: "No problem at all, take care!" and end the call.

"How did you get my number?"
Say: "Your business info is listed publicly — we just reach out to local contractors in Jersey. Nothing weird, I promise."

## VOICEMAIL SCRIPT

If you reach voicemail, leave this message and hang up:

"Hey, this is Mike calling from AQ Solutions — we help plumbing and HVAC businesses in Jersey stop losing jobs to missed calls. I will shoot you a quick text with a short demo video. No obligation, just take a look when you get a chance. Have a good one!"

Then immediately call the log_call_result tool with outcome "voicemail".

## TOOLS — WHEN TO CALL THEM

- send_demo_video: call this when the prospect agrees to receive the video
- book_demo_call: call this when the prospect wants to schedule a call
- log_call_result: ALWAYS call this at the very end of every call, no exceptions

## RULES

- Never make up pricing numbers
- Never promise specific results or guarantees
- Never be rude or argue, even if they are dismissive
- If they hang up, do not call back
- Keep the total call under 3 minutes
- Always end on a positive, friendly note`;
}

// ── Vapi assistant config ─────────────────────────────────────
function buildAssistant(prospect) {
  return {
    name: "Mike",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(prospect),
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "send_demo_video",
            description:
              "Send the prospect a text message with the AQ Solutions demo video link. Call this when the prospect agrees to receive the video.",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The prospect first name",
                },
              },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "book_demo_call",
            description:
              "Send the Calendly booking link via SMS when the prospect wants to schedule a demo call.",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The prospect first name",
                },
              },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "log_call_result",
            description:
              "Log the final outcome of the call. MUST be called at the end of every call.",
            parameters: {
              type: "object",
              properties: {
                outcome: {
                  type: "string",
                  enum: [
                    "interested",
                    "not interested",
                    "voicemail",
                    "no answer",
                    "callback requested",
                    "demo video sent",
                    "booking link sent",
                  ],
                  description: "The result of the call",
                },
                notes: {
                  type: "string",
                  description: "Any relevant notes from the conversation",
                },
              },
              required: ["outcome"],
            },
          },
        },
      ],
    },
    voice: {
      provider: "11labs",
      voiceId: "TelnL2lJmhmJsbXVaz6M",
    },
    firstMessage: `Hi, is this ${prospect.name}? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?`,
  };
}

// ── Vapi: create outbound call ────────────────────────────────
async function createVapiCall(prospect) {
  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: { number: prospect.phone },
      assistant: buildAssistant(prospect),
      metadata: {
        airtableId: prospect.id,
        business:   prospect.business,
        name:       prospect.name,
        phone:      prospect.phone,
      },
    }),
  });
  return res.json();
}

// ── Routes ────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ status: "AQ Outreach Bot running", ts: new Date().toISOString() })
);

app.post("/call", async (req, res) => {
  try {
    const { phone, name = "Owner", business = "your business" } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });
    const prospect = { id: null, phone, name, business };
    const result = await createVapiCall(prospect);
    res.json({ success: true, callId: result.id, result });
  } catch (err) {
    console.error("Call error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/run", async (req, res) => {
  try {
    const prospects = await getProspects();
    if (!prospects.length) {
      return res.json({ message: "No uncalled prospects with phone numbers." });
    }
    res.json({ message: "Run started", total: prospects.length });

    for (let i = 0; i < prospects.length; i++) {
      const prospect = prospects[i];
      try {
        const call = await createVapiCall(prospect);
        console.log(`Called ${prospect.name} at ${prospect.business} — callId: ${call.id}`);
      } catch (err) {
        console.error(`Failed to call ${prospect.name}:`, err.message);
      }
      if (i < prospects.length - 1) {
        await new Promise((r) => setTimeout(r, 90_000));
      }
    }
  } catch (err) {
    console.error("Run error:", err);
  }
});

app.post("/vapi/outreach-webhook", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.sendStatus(200);

  if (message.type === "tool-calls") {
    const toolCallList = message.toolCallList || [];
    const results = [];

    // Fix 4: read phone from the call object, not from tool parameters
    const callPhone =
      message.call?.customer?.number || "";

    for (const toolCall of toolCallList) {
      const name       = toolCall.name       || toolCall.function?.name;
      const parameters = toolCall.parameters || toolCall.function?.parameters || {};
      const id         = toolCall.id;

      if (name === "send_demo_video") {
        try {
          await twilioClient.messages.create({
            body: `Hey ${parameters.name}! Here is a quick 2-min demo of AQ Solutions: ${DEMO_VIDEO_URL} — No pressure, just take a look when you get a chance!`,
            from: `+1${TWILIO_PHONE}`,
            to:   callPhone,
          });
          console.log(`Demo video SMS sent to ${callPhone}`);
          results.push({
            toolCallId: id,
            name,
            result: "Demo video sent via SMS successfully.",
          });
        } catch (e) {
          console.error("SMS error (send_demo_video):", e.message);
          results.push({ toolCallId: id, name, result: `SMS failed: ${e.message}` });
        }

      } else if (name === "book_demo_call") {
        try {
          await twilioClient.messages.create({
            body: `Hey ${parameters.name}! Here is the link to book your free 15-min AQ Solutions demo: ${CALENDLY_LINK}`,
            from: `+1${TWILIO_PHONE}`,
            to:   callPhone,
          });
          console.log(`Calendly SMS sent to ${callPhone}`);
          results.push({
            toolCallId: id,
            name,
            result: "Calendly booking link sent via SMS successfully.",
          });
        } catch (e) {
          console.error("SMS error (book_demo_call):", e.message);
          results.push({ toolCallId: id, name, result: `SMS failed: ${e.message}` });
        }

      } else if (name === "log_call_result") {
        // Fix 5: fallback for undefined outcome
        const outcome = parameters.outcome || "unknown";
        console.log(`Call outcome logged mid-call: ${outcome}`);
        results.push({
          toolCallId: id,
          name,
          result: `Outcome "${outcome}" noted.`,
        });

      } else {
        results.push({ toolCallId: id, name, result: "Unknown tool — ignored." });
      }
    }

    return res.json({ results });
  }

  if (message.type === "end-of-call-report") {
    const { call, endedReason } = message;
    const meta    = call?.metadata || {};
    const outcome = endedReason || "unknown";

    try {
      if (meta.airtableId) {
        await markCalled(meta.airtableId, outcome);
      }
      await logCall({
        type:     "outbound",
        outcome,
        business: meta.business || "",
        phone:    meta.phone    || call?.customer?.number || "",
      });
      console.log(`End-of-call logged — ${meta.business} — ${outcome}`);
    } catch (err) {
      console.error("Airtable update error:", err.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AQ Outreach Bot listening on port ${PORT}`);
});
