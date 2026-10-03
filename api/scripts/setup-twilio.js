// Interactive Twilio setup:  cd api && node scripts/setup-twilio.js
// Asks for your Account SID and Auth Token (typed or pasted; the token is hidden), checks them with
// Twilio, picks your Twilio phone number, checks that the demo dispatch number is verified, and
// saves everything to api/local.settings.json (git-ignored). Nothing is printed back.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SETTINGS = path.join(__dirname, '..', 'local.settings.json');
const DISPATCH = '+13128262020';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write('*'); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

(async () => {
  const sid = await ask('Twilio Account SID (starts with AC): ');
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error('That is not an Account SID: it should be AC followed by 32 letters/digits.');
  const token = await ask('Twilio Auth Token (hidden): ', { hidden: true });
  if (!/^[0-9a-f]{32}$/i.test(token)) throw new Error(`That is not an Auth Token: it should be 32 letters/digits (you entered ${token.length}).`);

  const client = require('twilio')(sid, token);
  let account;
  try {
    account = await client.api.v2010.accounts(sid).fetch();
  } catch (err) {
    throw new Error(`Twilio rejected these credentials (${err.status ?? ''} ${err.message}). Check the SID and Auth Token in the console.`);
  }
  console.log(`OK: signed in to Twilio account "${account.friendlyName}" (${account.type}).`);

  const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
  const voiceNumbers = numbers.filter((n) => n.capabilities?.voice);
  if (!voiceNumbers.length) throw new Error('This account has no Twilio phone number yet. Console: Phone Numbers > Buy a number (free on trial), then run this again.');
  let from = voiceNumbers[0].phoneNumber;
  if (voiceNumbers.length > 1) {
    voiceNumbers.forEach((n, i) => console.log(`  ${i + 1}. ${n.phoneNumber} ${n.friendlyName}`));
    const pick = Number(await ask(`Which number should calls and texts come from? [1-${voiceNumbers.length}]: `)) || 1;
    from = voiceNumbers[Math.min(Math.max(pick, 1), voiceNumbers.length) - 1].phoneNumber;
  }
  console.log(`OK: calls and texts will come from ${from}.`);

  if (account.type === 'Trial') {
    const verified = await client.outgoingCallerIds.list({ limit: 50 });
    if (verified.some((v) => v.phoneNumber === DISPATCH)) console.log(`OK: ${DISPATCH} is verified, so the trial account can call it.`);
    else console.log(`!! ${DISPATCH} is NOT verified yet. Trial accounts can only call verified numbers:\n   Console > Phone Numbers > Verified Caller IDs > add ${DISPATCH}.`);
  }

  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  settings.Values = { ...settings.Values, TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from, DISPATCH_NUMBER: DISPATCH };
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log('Saved to api/local.settings.json (git-ignored). Tell Claude it is done.');
})().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
