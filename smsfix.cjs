const fs = require('fs');
let code = fs.readFileSync('outreach-bot.js', 'utf8');

const oldSMS = `async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID) return;
  const auth = Buffer.from(\`\${TWILIO_ACCOUNT_SID}:\${TWILIO_AUTH_TOKEN}\`).toString("base64");
  await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${TWILIO_ACCOUNT_SID}/Messages.json\`, {
    method: "POST",
    headers: { Authorization: \`Basic \${auth}\`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
}`;

const newSMS = `async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID) { console.log("SMS SKIP: No TWILIO_ACCOUNT_SID"); return; }
  if (!to) { console.log("SMS SKIP: No 'to' number"); return; }
  const formattedTo = to.startsWith("+") ? to : "+1" + to.replace(/\\D/g, "").slice(-10);
  console.log("SMS SENDING to:", formattedTo, "from:", TWILIO_FROM_NUMBER);
  const auth = Buffer.from(\`\${TWILIO_ACCOUNT_SID}:\${TWILIO_AUTH_TOKEN}\`).toString("base64");
  const res = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${TWILIO_ACCOUNT_SID}/Messages.json\`, {
    method: "POST",
    headers: { Authorization: \`Basic \${auth}\`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: formattedTo, From: TWILIO_FROM_NUMBER, Body: body }),
  });
  const data = await res.json();
  if (data.sid) { console.log("SMS SUCCESS:", data.sid); }
  else { console.error("SMS ERROR:", JSON.stringify(data)); }
  return data;
}`;

if (code.includes(oldSMS)) {
  code = code.replace(oldSMS, newSMS);
  fs.writeFileSync('outreach-bot.js', code);
  console.log('SMS function replaced successfully!');
} else {
  console.log('Could not find exact match. Trying loose match...');
  code = code.replace(/async function sendSMS\(to, body\) \{[\s\S]*?\n\}/m, newSMS);
  fs.writeFileSync('outreach-bot.js', code);
  console.log('SMS function replaced with loose match!');
}
