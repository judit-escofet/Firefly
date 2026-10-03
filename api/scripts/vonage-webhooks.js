// Points the Vonage Application's Voice webhooks at a deployed Firefly:
//   node scripts/vonage-webhooks.js https://<live app URL>
// Reads VONAGE_API_KEY / VONAGE_API_SECRET / VONAGE_APPLICATION_ID from api/local.settings.json.
// deploy/aws/deploy.sh runs this after every deploy. Skips quietly when Vonage isn't set up.
const fs = require('fs');
const path = require('path');

(async () => {
  const base = String(process.argv[2] || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('usage: node scripts/vonage-webhooks.js https://<live app URL>');
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local.settings.json'), 'utf8')).Values || {};
  if (!v.VONAGE_API_KEY || !v.VONAGE_API_SECRET || !v.VONAGE_APPLICATION_ID) {
    console.log('   Vonage not set up (run node scripts/setup-vonage.js); skipping webhooks');
    return;
  }
  const url = `https://api.nexmo.com/v2/applications/${encodeURIComponent(v.VONAGE_APPLICATION_ID)}`;
  const headers = { Authorization: `Basic ${Buffer.from(`${v.VONAGE_API_KEY}:${v.VONAGE_API_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' };

  const got = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!got.ok) throw new Error(`couldn't read the Vonage application (${got.status})`);
  const appCfg = await got.json();

  const voice = appCfg.capabilities?.voice ?? {};
  const capabilities = {
    ...appCfg.capabilities,
    voice: {
      ...voice,
      webhooks: {
        ...(voice.webhooks ?? {}),
        answer_url: { address: `${base}/api/voice/vonage/answer`, http_method: 'POST' },
        event_url: { address: `${base}/api/voice/vonage/event`, http_method: 'POST' },
      },
    },
  };
  const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ name: appCfg.name, capabilities }), signal: AbortSignal.timeout(10000) });
  if (!put.ok) throw new Error(`Vonage refused the webhook update (${put.status}): ${(await put.text()).slice(0, 200)}`);
  console.log(`   Vonage "${appCfg.name}" answer/event webhooks → ${base}/api/voice/vonage/*`);
})().catch((err) => {
  console.error(`   !! ${err.message}. Set them by hand: Answer URL ${process.argv[2]}/api/voice/vonage/answer, Event URL .../event (POST).`);
  process.exitCode = 0; // never fail the deploy over this
});
