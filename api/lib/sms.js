// Texts through Twilio, or Vonage when only Vonage is set up. With neither, the message is
// logged instead (mock mode for local dev).
let client;

function twilioClient() {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  if (!sid || !token || !process.env.TWILIO_FROM_NUMBER) return null;
  if (!client) client = require('twilio')(sid, token);
  return client;
}

// Texts every phone in parallel. Returns the numbers Twilio accepted.
async function textAll(phones, body, log = console) {
  const tw = twilioClient();
  if (!tw && require('./vonage').smsConfigured()) {
    const { sendSms } = require('./vonage');
    const results = await Promise.allSettled(phones.map((to) => sendSms(to, body)));
    const sent = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') sent.push(phones[i]);
      else log.error(`Vonage SMS failed for ${phones[i]}: ${r.reason && r.reason.message}`);
    });
    return sent;
  }
  if (!tw) {
    log.warn(`[sms mock] would text ${phones.join(', ')}: ${body}`);
    return phones;
  }
  const results = await Promise.allSettled(
    phones.map((to) => tw.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body })),
  );
  const sent = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent.push(phones[i]);
    else log.error(`Twilio failed for ${phones[i]}: ${r.reason && r.reason.message}`);
  });
  return sent;
}

module.exports = { textAll, twilioClient };
