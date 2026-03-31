// ─────────────────────────────────────────────────────────────
// outreach-bot.js — AQ Solutions Outreach Bot
// Requires Node 18+ | "type": "module" in package.json
// ─────────────────────────────────────────────────────────────

import express from "express";
import twilio from "twilio";

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
  PORT = 3001,
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Airtable helpers (FIXED: split table name from query string before encoding)
const atFetch = (path, opts = {}) => {
  const qIdx = path.indexOf("?");
  const table = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? "" : path.slice(qIdx);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${query}`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
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

async function markCalled(recordId, result) {
  await atFetch("Prospects/" + recordId, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        Called: true,
        Result: result,
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
            Type: type,
            Outcome: outcome,
            Business: business,
            Phone: phone,
            Timestamp: new Date().toISOString(),
          },
        },
      ],
    }),
  });
}

// ── Mike system prompt ──────────────────────────────────────

function buildSystemPrompt(p) {
  return "You are Mike, an outreach assistant for AQ Solutions — a company that helps plumbing and HVAC businesses in New Jersey recover lost revenue from missed calls using AI-powered call answering.\n\nYou are calling " + p.name + " at " + p.business + ".\n\n## YOUR PERSONALITY\n- You are warm, casual, and confident — like a real person from Jersey, not a robot\n- Use natural verbal fillers occasionally: so, honestly, like, yeah, look\n- Keep your sentences short. Never ramble.\n- You are NOT pushy. One soft close, then respect their answer.\n- Never say as an AI or anything that sounds scripted or robotic\n- If they ask if you are a robot or AI, be honest but pivot: Yeah, I am an AI assistant — but the system I am calling about is really for your business. Can I take 30 more seconds?\n- Total call time goal: under 3 minutes\n\n## CALL FLOW\n\n### STEP 1 — OPENING (do not skip)\nSay exactly this first message, then stop and listen:\nHi, is this " + p.name + "? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?\n\nIf they say yes or seem open, go to Step 2.\nIf they say no or seem annoyed, say No worries at all, I will let you go. Have a good one! and end the call.\n\n### STEP 2 — QUALIFYING QUESTION\nAsk ONE of these, pick naturally based on flow:\n- So quick question — when you are on a job or it is after hours, what happens to your missed calls? Do they just go to voicemail?\n- Do you ever lose jobs because someone called while you were busy and ended up calling the next guy?\n\nListen to their answer. Acknowledge it before pitching.\n\n### STEP 3 — THE PITCH (keep it to 3-4 sentences max)\nSo what AQ Solutions does is — we set up an AI that answers every call you miss, 24/7. It talks to the customer, gets their info, tells them you will call back, and logs everything. So you never lose a lead just because you were on a job. A lot of guys in Jersey are using it now.\n\n### STEP 4 — CLOSE\nOffer ONE of the following based on their vibe:\n\nIf they seem curious or positive:\nI can shoot you a 2-minute demo video right now — no signup, nothing. You just watch it and see if it makes sense for your business. Want me to text it to you?\n\nIf they seem more serious or analytical:\nWould it make sense to grab 15 minutes on a call? I can show you exactly how it works and what it would cost. I can text you a link to pick a time.\n\nAlways try to send the demo video first — it is the lower-friction ask.\n\n### STEP 5 — IF THEY AGREE TO VIDEO OR BOOKING\nSay: Perfect — what is the best number to text you at? if different from what you called.\nThen call the send_demo_video or book_demo_call tool immediately.\nConfirm: Sent! Check your texts. And hey — no pressure at all, just watch it when you get a chance.\nThen wrap up: Alright, I will let you go. Thanks for your time, " + p.name + ". Have a good one!\n\n## OBJECTION HANDLERS\n\nNot interested or Dont need it\nSay: Totally get it — honestly most guys say that until they lose a big job to a missed call. I am not here to sell you anything today, just wanted to see if it made sense. No worries at all.\nThen try one last soft offer: I can still shoot you the video just so you have it — no pressure.\nIf they say no again, end the call gracefully.\n\nHow much does it cost?\nSay: So it depends on your call volume — it is typically way less than losing one job. The demo video actually covers the pricing. Want me to shoot that over?\n\nIs this a robot? or Are you AI?\nSay: Yeah, I am an AI assistant — but honestly, what I am calling about is for your business, not mine. Can I take 30 more seconds to explain?\n\nI already have something like that or I use a competitor\nSay: Oh nice — yeah there are a few out there. A lot of guys still switch over once they see how AQ Solutions handles the actual conversation, not just voicemail. But hey, if it is working for you, that is what matters.\n\nCall me back later or Not a good time\nSay: Of course — I will get out of your hair. Is there a better time, or should I just try again tomorrow?\nIf they give a time, say: Got it, I will make a note. Thanks " + p.name + "! and end the call.\nIf vague, say: No problem at all, take care! and end the call.\n\nHow did you get my number?\nSay: Your business info is listed publicly — we just reach out to local contractors in Jersey. Nothing weird, I promise.\n\n## VOICEMAIL SCRIPT\nIf you reach voicemail, leave this message and hang up:\nHey, this is Mike calling from AQ Solutions — we help plumbing and HVAC businesses in Jersey stop losing jobs to missed calls. I will shoot you a quick text with a short demo video. No obligation, just take a look when you get a chance. Have a good one!\nThen immediately call the log_call_result tool with outcome voicemail.\n\n## TOOLS — WHEN TO CALL THEM\n- send_demo_video: call this when the prospect agrees to receive the video\n- book_demo_call: call this when the prospect wants to schedule a call\n- log_call_result: ALWAYS call this at the very end of every call, no exceptions\n\n## RULES\n- Never make up pricing numbers\n- Never promise specific results or guarantees\n- Never be rude or argue, even if they are dismissive\n- If they hang up, do not call back\n- Keep the total call under 3 minutes\n- Always end on a positive, friendly note";
}

// ── Vapi assistant config ───────────────────────────────────

function buildAssistant(prospect) {
  return {
    name: "Mike",
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: buildSystemPrompt(prospect) }],
      tools: [
        {
          type: "function",
          function: {
            name: "send_demo_video",
            description: "Send the prospect a text message with the AQ Solutions demo video link. Call this when the prospect agrees to receive the video.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "The prospect first name" },
              },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "book_demo_call",
            description: "Send the Calendly booking link via SMS when the prospect wants to schedule a demo call.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "The prospect first name" },
              },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "log_call_result",
            description: "Log the final outcome of the call. MUST be called at the end of every call.",
            parameters: {
              type: "object",
              properties: {
                outcome: {
                  type: "string",
                  enum: ["interested", "not interested", "voicemail", "no answer", "callback requested", "demo video sent", "booking link sent"],
                  description: "The result of the call",
                },
                notes: { type: "string", description: "Any relevant notes from the conversation" },
              },
              required: ["outcome"],
            },
          },
        },
      ],
    },
    voice: {
      provider: "11labs",
      voiceId: "eN7WPylhvgvOGdskN6bn",
    },
    firstMessage: "Hi, is this " + prospect.name + "? Hey — this is Mike calling from AQ Solutions. Super quick — do you have like 30 seconds?",
  };
}

// ── Vapi: create outbound call ──────────────────────────────

async function createVapiCall(prospect) {
  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + VAPI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      customer: { number: prospect.phone },
      assistant: buildAssistant(prospect),
      metadata: {
        airtableId: prospect.id,
        business: prospect.business,
        name: prospect.name,
        phone: prospect.phone,
      },
    }),
  });
  return res.json();
}

// ── Routes ──────────────────────────────────────────────────

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
        console.log("Called " + prospect.name + " at " + prospect.business + " — callId: " + call.id);
      } catch (err) {
        console.error("Failed to call " + prospect.name + ": " + err.message);
      }
      if (i < prospects.length - 1) {
        await new Promise((r) => setTimeout(r, 90000));
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
    const callPhone = message.call?.customer?.number || "";
    const results = [];

    for (const toolCall of toolCallList) {
      const tname = toolCall.name || toolCall.function?.name;
      const parameters = toolCall.parameters || toolCall.function?.parameters || {};
      const id = toolCall.id;

      if (tname === "send_demo_video") {
        try {
          await twilioClient.messages.create({
            body: "Hey " + (parameters.name || "there") + "! Here is a quick 2-min demo of AQ Solutions: " + DEMO_VIDEO_URL + " — No pressure, just take a look when you get a chance!",
            from: "+1" + TWILIO_PHONE,
            to: callPhone,
          });
          console.log("Demo video SMS sent to " + callPhone);
          results.push({ toolCallId: id, name: tname, result: "Demo video sent via SMS successfully." });
        } catch (e) {
          console.error("SMS error (send_demo_video):", e.message);
          results.push({ toolCallId: id, name: tname, result: "SMS failed: " + e.message });
        }
      } else if (tname === "book_demo_call") {
        try {
          await twilioClient.messages.create({
            body: "Hey " + (parameters.name || "there") + "! Here is the link to book your free 15-min AQ Solutions demo: " + CALENDLY_LINK,
            from: "+1" + TWILIO_PHONE,
            to: callPhone,
          });
          console.log("Calendly SMS sent to " + callPhone);
          results.push({ toolCallId: id, name: tname, result: "Calendly booking link sent via SMS successfully." });
        } catch (e) {
          console.error("SMS error (book_demo_call):", e.message);
          results.push({ toolCallId: id, name: tname, result: "SMS failed: " + e.message });
        }
      } else if (tname === "log_call_result") {
        var outcome = parameters.outcome || "unknown";
        console.log("Call outcome logged mid-call: " + outcome);
        results.push({ toolCallId: id, name: tname, result: "Outcome " + outcome + " noted." });
      } else {
        results.push({ toolCallId: id, name: tname, result: "Unknown tool — ignored." });
      }
    }
    return res.json({ results });
  }

  if (message.type === "end-of-call-report") {
    const call = message.call || {};
    const meta = call.metadata || {};
    const outcome = message.endedReason || "unknown";
    try {
      if (meta.airtableId) {
        await markCalled(meta.airtableId, outcome);
      }
      await logCall({
        type: "outbound",
        outcome: outcome,
        business: meta.business || "",
        phone: meta.phone || call.customer?.number || "",
      });
      console.log("End-of-call logged — " + (meta.business || "unknown") + " — " + outcome);
    } catch (err) {
      console.error("Airtable update error:", err.message);
    }
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ── Dashboard API routes ────────────────────────────────────

app.get("/prospects", async (req, res) => {
  try {
    const params = new URLSearchParams({ pageSize: "100" });
    var allRecords = [];
    var offset;
    do {
      if (offset) params.set("offset", offset);
      var data = await atFetch("Prospects?" + params.toString());
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    const prospects = allRecords.map((r) => ({
      id: r.id,
      name: r.fields["Name"] || "",
      business: r.fields["Business"] || "",
      phone: r.fields["Phone"] || "",
      called: r.fields["Called"] || false,
      result: r.fields["Result"] || "",
      calledAt: r.fields["CalledAt"] || null,
    }));
    res.json({ total: prospects.length, prospects: prospects });
  } catch (err) {
    console.error("GET /prospects error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/call-log", async (req, res) => {
  try {
    const params = new URLSearchParams({
      pageSize: "100",
      "sort[0][field]": "Timestamp",
      "sort[0][direction]": "desc",
    });
    var allRecords = [];
    var offset;
    do {
      if (offset) params.set("offset", offset);
      var data = await atFetch("CallLog?" + params.toString());
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    const logs = allRecords.map((r) => ({
      id: r.id,
      type: r.fields["Type"] || "",
      outcome: r.fields["Outcome"] || "",
      business: r.fields["Business"] || "",
      phone: r.fields["Phone"] || "",
      timestamp: r.fields["Timestamp"] || null,
    }));
    res.json({ total: logs.length, log: logs });
  } catch (err) {
    console.error("GET /call-log error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("AQ Outreach Bot listening on port " + PORT);
});
