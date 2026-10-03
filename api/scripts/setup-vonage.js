// Interactive Vonage setup:  cd api && node scripts/setup-vonage.js
// Asks for your Vonage details (secrets are hidden), reads private.key from the file, checks
// everything with Vonage, saves it to api/local.settings.json (git-ignored), and can place one test
// call to the demo dispatch number. Nothing secret is printed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SETTINGS = path.join(__dirname, '..', 'local.settings.json');
const DISPATCH = '+13128262020';

function ask(question, { hidden = false, fallback = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write('*'); };
    const shown = fallback && !hidden ? `${question}[${fallback}] ` : question;
    rl.question(shown, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim() || fallback); });
  });
}
const yes = async (q) => /^y/i.test(await ask(`${q} [y/N] `));
const digits = (p) => String(p).replace(/\D/g, '');

// Newest private*.key in Downloads, Desktop or here.
function findKeyFile() {
  for (const dir of [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'), process.cwd()]) {
    try {
      const hit = fs.readdirSync(dir).filter((f) => /private.*\.key$/i.test(f))
        .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (hit) return hit;
    } catch {}
  }
  return '';
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const old = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).Values || {};
  const key = await ask('Vonage API key: ', { fallback: old.VONAGE_API_KEY || '' });
  const secret = await ask('Vonage API secret (hidden): ', { hidden: true });
  const basic = { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` };

  const bal = await getJson(`https://rest.nexmo.com/account/get-balance?api_key=${encodeURIComponent(key)}&api_secret=${encodeURIComponent(secret)}`);
  if (!bal.ok || bal.data.value == null) throw new Error(`Vonage rejected the API key/secret (${bal.status}). Check them on the dashboard home page.`);
  console.log(`OK: signed in. Balance: ${Number(bal.data.value).toFixed(2)} (free credit counts).`);

  const appId = await ask('Application ID: ', { fallback: old.VONAGE_APPLICATION_ID || '' });
  const appRes = await getJson(`https://api.nexmo.com/v2/applications/${encodeURIComponent(appId)}`, { headers: basic });
  if (!appRes.ok) throw new Error(`Couldn't find application ${appId} (${appRes.status}). Copy the ID from Applications on the dashboard.`);
  if (!appRes.data.capabilities?.voice) throw new Error(`Application "${appRes.data.name}" doesn't have Voice turned on. Edit it on the dashboard, enable Voice, save, and run this again.`);
  console.log(`OK: application "${appRes.data.name}" has Voice.`);

  const keyPath = (await ask('Path to private.key: ', { fallback: findKeyFile() })).replace(/^"|"$/g, '');
  let pem;
  try { pem = fs.readFileSync(keyPath, 'utf8').trim(); } catch { throw new Error(`Couldn't read ${keyPath}.`); }
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(pem)) throw new Error('That file is not a private key (it should start with -----BEGIN PRIVATE KEY-----).');

  const from = `+${digits(await ask('Your Vonage number: ', { fallback: old.VONAGE_FROM_NUMBER || '+17077376070' }))}`;
  const sigSecret = await ask('Signature secret (hidden, Enter to skip): ', { hidden: true });

  Object.assign(process.env, { VONAGE_API_KEY: key, VONAGE_API_SECRET: secret, VONAGE_APPLICATION_ID: appId, VONAGE_PRIVATE_KEY: pem, VONAGE_FROM_NUMBER: from });
  const vonage = require('../lib/vonage');
  const jwtCheck = await getJson('https://api.nexmo.com/v1/users?page_size=1', { headers: { Authorization: `Bearer ${vonage.appJwt()}` } });
  if (!jwtCheck.ok) throw new Error(`The private key doesn't match this application (${jwtCheck.status}). Use the private.key downloaded for "${appRes.data.name}", or generate a new key pair on the dashboard.`);
  console.log('OK: the private key belongs to this application.');

  const nums = await getJson(`https://rest.nexmo.com/account/numbers?api_key=${encodeURIComponent(key)}&api_secret=${encodeURIComponent(secret)}`);
  const mine = (nums.data.numbers || []).find((n) => n.msisdn === digits(from));
  if (!mine) {
    console.log(`!! ${from} isn't one of this account's numbers. Check Numbers > Your numbers.`);
  } else if (mine.app_id !== appId) {
    if (await yes(`${from} isn't linked to "${appRes.data.name}". Link it now?`)) {
      const link = await getJson('https://rest.nexmo.com/number/update', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_key: key, api_secret: secret, country: mine.country, msisdn: mine.msisdn, app_id: appId }),
      });
      console.log(link.ok && link.data['error-code'] === '200' ? 'OK: number linked.' : `!! Linking failed (${link.data['error-code-label'] || link.status}). Link it on the dashboard.`);
    }
  } else {
    console.log(`OK: ${from} is linked to the application.`);
  }

  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  settings.Values = { ...settings.Values, VONAGE_API_KEY: key, VONAGE_API_SECRET: secret, VONAGE_APPLICATION_ID: appId,
    VONAGE_PRIVATE_KEY: pem, VONAGE_FROM_NUMBER: from, DISPATCH_NUMBER: DISPATCH,
    ...(sigSecret ? { VONAGE_SIGNATURE_SECRET: sigSecret } : {}) };
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log('Saved to api/local.settings.json (git-ignored).');

  console.log(`\nIn-app calls also need the application's Voice webhooks to point at your live app:
  Answer URL: <live app URL>/api/voice/vonage/answer   (HTTP POST)
  Event URL:  <live app URL>/api/voice/vonage/event    (HTTP POST)`);

  if (await yes(`\nPlace ONE test call to ${DISPATCH} now? That phone will ring.`)) {
    try {
      const c = await vonage.createCall({ to: DISPATCH, ncco: [{ action: 'talk', language: 'en-US', loop: 2,
        text: 'This is a Firefly test call for the demo dispatch line. If you can hear this, emergency calling works. Goodbye.' }] });
      console.log(`OK: call started (${c.status}). ${DISPATCH} should ring in a few seconds.`);
    } catch (err) {
      console.log(`!! The call failed: ${err.message}`);
      if (/40[13]|whitelist|test number|demo/i.test(err.message)) console.log(`   On a trial account, add ${DISPATCH} under "Test numbers" on the dashboard first.`);
    }
  }
})().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
