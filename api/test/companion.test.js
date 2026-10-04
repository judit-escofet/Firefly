// P1 companion: reply shaping (C3), check-in keyword rules (C9), calm-mode filters (C10), RSS parsing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { shapeReply, classifyCheckinKeywords, FORBIDDEN, CALM_FORBIDDEN, systemPrompt } = require('../lib/companion');
const { parseRss } = require('../lib/news');

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const questions = (s) => (s.match(/\?/g) || []).length;

test('replies: at most 2 sentences, under 35 words, at most one question, whole sentences', () => {
  const cases = [
    'That sounds rough. Do you want to talk about it? Or should we talk about music? Also, five minutes to go.',
    'Oh I am so sorry to hear that, exams can be so draining and honestly the whole week sounds like it has been a lot for you, what are you going to do to relax when you get in tonight after all that?',
    'Nice! About six minutes to go.',
    '',
  ];
  for (const c of cases) {
    const r = shapeReply(c);
    assert.ok(words(r) <= 35, `${r} (${words(r)} words)`);
    assert.ok(questions(r) <= 1, r);
    assert.ok((r.match(/[.!?…]/g) || []).length >= 1, r);
  }
  assert.equal(shapeReply('That sounds rough. Do you want to talk about it? Or music?'), 'That sounds rough. Do you want to talk about it?');
});

test('check-in keywords (C9): clear answers decided without the model', () => {
  const ok = ["yeah I'm fine", 'yes', "I'm okay, just tying my shoe", 'all good', "no, I'm fine", 'no worries', 'yep all good thanks'];
  const notOk = ['no', 'help', 'not really', "someone's following me", "I'm scared", 'please call someone', 'not okay'];
  for (const t of ok) assert.equal(classifyCheckinKeywords(t), true, t);
  for (const t of notOk) assert.equal(classifyCheckinKeywords(t), false, t);
  assert.equal(classifyCheckinKeywords(''), null);
  assert.equal(classifyCheckinKeywords('what time is it'), undefined); // → model
});

test('calm mode filters catch giveaway words (C10)', () => {
  for (const t of ['The police are on the way', 'Your alert went out', 'Stay safe!', 'Is someone behind you?']) {
    assert.ok(FORBIDDEN.test(t) || CALM_FORBIDDEN.test(t), t);
  }
  assert.ok(!FORBIDDEN.test('What was the best part of your day?'));
  assert.match(systemPrompt({ mode: 'calm', context: {} }), /Never say anything that would alert someone nearby/);
});

test('system prompt carries memory, news (with source) and ETA context', () => {
  const p = systemPrompt({ name: 'Priya', mode: 'chat', memory: ['Has an exam Friday'], news: [{ title: 'New album out', source: 'NPR' }], context: { eta_s: 420, remaining_m: 600 } });
  assert.match(p, /Has an exam Friday/);
  assert.match(p, /New album out \(NPR\)/);
  assert.match(p, /7 minutes to home, 0.4 miles left/);
  assert.match(p, /Never invent news/);
});

test('RSS parsing: title without source suffix, source, link, date', () => {
  const xml = `<rss><channel><item><title>Big Chip News - The Verge</title><link>https://news.google.com/a</link>
    <pubDate>Sat, 03 Oct 2026 12:00:00 GMT</pubDate><source url="https://theverge.com">The Verge</source></item>
    <item><title><![CDATA[Album &amp; Tour]]></title><link>https://x/b</link><source>NPR</source></item></channel></rss>`;
  const items = parseRss(xml, 'tech');
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].title, items[0].source, items[0].url], ['Big Chip News', 'The Verge', 'https://news.google.com/a']);
  assert.equal(items[0].published, '2026-10-03T12:00:00.000Z');
  assert.equal(items[1].title, 'Album & Tour');
});
