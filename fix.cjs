const fs = require('fs');
let code = fs.readFileSync('outreach-bot.js', 'utf8');

// Add test-sms endpoint before health endpoint
const testSms = `
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

`;

if (!code.includes('test-sms')) {
  code = code.replace('app.get("/health"', testSms + 'app.get("/health"');
}

fs.writeFileSync('outreach-bot.js', code);
console.log('Done! test-sms endpoint added.');
