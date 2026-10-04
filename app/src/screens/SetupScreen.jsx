import React, { useRef, useState } from 'react';
import { hashPin, getOrCreateUserId } from '../crypto';
import { api, normalizePhone } from '../services/api';
import { startPhraseTest } from '../services/phraseTest';
import { MOCK_HOME } from '../services/mockData';
import HomePicker from '../components/HomePicker';
import { ArrowLeft, ArrowRight, Check, Mic, AlertCircle, X } from 'lucide-react';

// Chip label → the interest the companion's /api/news searches for.
const NEWS_TOPICS = [
  ['Tech', 'tech'], ['Music', 'music'], ['Basketball', 'basketball'], ['Movies', 'movies'],
  ['Science', 'science'], ['Space', 'space'], ['Books', 'books'], ['Food', 'food'],
  ['Fashion', 'fashion'], ['Gaming', 'gaming'], ['Football', 'football'], ['Art', 'art'],
];

export default function SetupScreen({ onComplete, onBack, initialProfile = null }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 1: Name and Trusted Contacts
  const [name, setName] = useState(initialProfile?.name || '');
  const [contacts, setContacts] = useState(
    initialProfile?.contacts || [
      { id: '1', name: '', phone: '' }
    ]
  );

  // Step 2: Code Phrase & PINs
  const [codePhrase, setCodePhrase] = useState(initialProfile?.code_phrase || 'i think i left the oven on');
  const [phraseTest, setPhraseTest] = useState(null); // {state, heard, score, message}
  const phraseTestRef = useRef(null);
  const isTestingMic = phraseTest?.state === 'listening';
  const micTestPassed = phraseTest?.state === 'passed';

  const [cancelPin, setCancelPin] = useState('');
  const [confirmCancelPin, setConfirmCancelPin] = useState('');

  // Step 3: News Interests and Home Address
  const [newsInterests, setNewsInterests] = useState(initialProfile?.news_interests || ['tech', 'music']);
  const [home, setHome] = useState(initialProfile?.home || MOCK_HOME);

  const addContact = () => {
    if (contacts.length < 3) {
      setContacts([...contacts, { id: Date.now().toString(), name: '', phone: '' }]);
    }
  };

  const removeContact = (id) => {
    if (contacts.length > 1) {
      setContacts(contacts.filter(c => c.id !== id));
    }
  };

  const updateContact = (id, field, value) => {
    setContacts(contacts.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const toggleNewsInterest = (topic) => {
    if (newsInterests.includes(topic)) {
      setNewsInterests(newsInterests.filter(t => t !== topic));
    } else {
      setNewsInterests([...newsInterests, topic]);
    }
  };

  // Runs synchronously in the tap (the mic must open inside it on iOS).
  const handleTestMic = () => {
    if (isTestingMic) {
      phraseTestRef.current?.cancel();
      return;
    }
    if (codePhrase.trim().split(/\s+/).length < 3) {
      setError('Make the code phrase at least 3 words, so it is never said by accident.');
      return;
    }
    setError('');
    phraseTestRef.current = startPhraseTest(codePhrase.trim(), setPhraseTest);
  };

  const handleNextFromStep1 = () => {
    if (!name.trim()) {
      setError('What should I call you?');
      return;
    }
    const validContacts = contacts.filter(c => c.name.trim() && c.phone.trim());
    if (validContacts.length === 0) {
      setError('Add at least one person, with a name and a phone number.');
      return;
    }
    const bad = validContacts.find(c => !normalizePhone(c.phone));
    if (bad) {
      setError(`${bad.name || 'That contact'}'s number doesn't look like a US phone number (10 digits).`);
      return;
    }
    const phones = validContacts.map(c => normalizePhone(c.phone));
    if (new Set(phones).size !== phones.length) {
      setError('Each contact needs a different phone number.');
      return;
    }
    setError('');
    setStep(2);
  };

  const handleNextFromStep2 = () => {
    if (codePhrase.trim().split(/\s+/).length < 3) {
      setError('Make the code phrase at least 3 words, so it is never said by accident.');
      return;
    }

    if (!/^\d{4}$/.test(cancelPin)) {
      setError('The PIN needs to be 4 digits.');
      return;
    }
    if (cancelPin !== confirmCancelPin) {
      setError("The two PINs don't match. Try again?");
      return;
    }


    setError('');
    setStep(3);
  };

  const handleSaveProfile = async () => {
    if (!home || !Number.isFinite(home.lat)) {
      setError('Tap the map to set home.');
      return;
    }
    if (newsInterests.length === 0) {
      setError('Pick at least one thing to chat about.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const userId = getOrCreateUserId();
      const cancelPinHash = await hashPin(cancelPin, userId);

      // Only hashes leave this screen: raw PINs are never stored or sent (A1).
      const profilePayload = {
        user_id: userId,
        name: name.trim(),
        contacts: contacts
          .filter(c => c.name.trim() && c.phone.trim())
          .map(c => ({ id: c.id, name: c.name.trim(), phone: normalizePhone(c.phone) })),
        code_phrase: codePhrase.trim().toLowerCase(),
        pin_hash: cancelPinHash,
        news_interests: newsInterests,
        home: { lat: home.lat, lng: home.lng, label: (home.label || 'Home').trim() },
      };

      const { profile: saved } = await api.saveProfile(profilePayload);
      setIsSubmitting(false);
      onComplete(saved);
    } catch (err) {
      setIsSubmitting(false);
      setError("Couldn't save that: " + err.message);
    }
  };

  const input = 'w-full px-4 h-12 rounded-xl bg-night-950 border border-parchment-100/15 text-[16px] text-parchment-50 placeholder:text-lichen-500 focus:outline-none focus:border-lantern-400';
  const label = 'block text-[15px] font-bold text-parchment-100 mb-1.5';
  const help = 'text-[14px] leading-relaxed text-lichen-300';
  const titles = ['', 'First, a little about you', 'Your secret signal', 'Small talk, and home'];

  return (
    <div className="min-h-[100dvh] flex flex-col night-sky select-none">
      <header className="px-5 pt-[max(1rem,env(safe-area-inset-top))] max-w-md w-full mx-auto">
        <div className="flex items-center gap-3 h-11">
          <button
            onClick={step > 1 ? () => setStep(step - 1) : onBack}
            aria-label="Back"
            className="w-10 h-10 -ml-2 rounded-full flex items-center justify-center text-lichen-300 hover:text-parchment-50"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* three little lights: lit for done, glowing for this step */}
          <div className="flex gap-2" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((n) => (
              <span key={n} className={`h-1.5 rounded-full transition-all duration-300 ${n === step ? 'w-8 bg-lantern-400 shadow-firefly' : n < step ? 'w-4 bg-lantern-400/60' : 'w-4 bg-parchment-100/15'}`} />
            ))}
          </div>
          <span className="ml-auto text-sm text-lichen-400">{step} of 3</span>
        </div>
        <h2 key={step} className="mt-5 font-display text-[2rem] leading-tight font-medium text-parchment-50 animate-rise-in">
          {titles[step]}
        </h2>
      </header>

      <main className="flex-1 px-5 pt-5 pb-4 max-w-md w-full mx-auto">
        {error && (
          <div className="mb-5 px-4 py-3 rounded-xl bg-ember-600/15 border border-ember-500/40 text-[15px] text-parchment-50 flex items-start gap-2.5 animate-shake" role="alert">
            <AlertCircle className="w-4 h-4 text-ember-400 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <label htmlFor="setup-name" className={label}>Your name</label>
              <input id="setup-name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="What should I call you?" autoComplete="given-name" className={input} />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className={label}>Who should I text if something's wrong?</span>
              </div>
              <p className={`${help} mb-3`}>Up to three people. They only hear from me if you need help, and when you get home.</p>

              <div className="space-y-3">
                {contacts.map((contact, idx) => (
                  <div key={contact.id} className="grid grid-cols-[1fr_1.15fr_auto] gap-2 items-center">
                    <input type="text" placeholder={['Mom', 'Roommate', 'Best friend'][idx] ?? 'Name'} aria-label={`Contact ${idx + 1} name`}
                      value={contact.name} onChange={e => updateContact(contact.id, 'name', e.target.value)} className={input} />
                    <input type="tel" inputMode="tel" placeholder="Phone" aria-label={`Contact ${idx + 1} phone`}
                      value={contact.phone} onChange={e => updateContact(contact.id, 'phone', e.target.value)} className={input} />
                    {contacts.length > 1 ? (
                      <button onClick={() => removeContact(contact.id)} aria-label={`Remove contact ${idx + 1}`} className="w-9 h-9 rounded-full text-lichen-400 hover:text-ember-400 flex items-center justify-center">
                        <X className="w-4 h-4" />
                      </button>
                    ) : <span className="w-9" />}
                  </div>
                ))}
              </div>
              {contacts.length < 3 && (
                <button onClick={addContact} className="mt-3 text-[15px] text-lantern-300 hover:text-lantern-200 underline decoration-lantern-300/30 underline-offset-4">
                  Add someone else
                </button>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-7 animate-fade-in">
            <div>
              <label htmlFor="setup-phrase" className={label}>Code phrase</label>
              <p className={`${help} mb-3`}>
                Something you'd say on a normal phone call, so nobody nearby notices. When I hear it, I start a quiet 10-second countdown.
              </p>
              <input id="setup-phrase" type="text" value={codePhrase} onChange={e => setCodePhrase(e.target.value)}
                placeholder="the moon is bright tonight" className={`${input} font-display italic text-[17px]`} />
              <div className="mt-3 flex items-center gap-3">
                <button type="button" onClick={handleTestMic}
                  className={`h-11 px-4 rounded-full text-[15px] font-bold flex items-center gap-2 transition-colors ${
                    micTestPassed ? 'bg-moss-500/25 text-moss-300 border border-moss-400/50'
                      : isTestingMic ? 'bg-lantern-400 text-night-950'
                      : 'btn-quiet'}`}>
                  {micTestPassed ? <Check className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  <span>{isTestingMic ? 'Listening… tap to stop' : micTestPassed ? 'Got it' : 'Say it once'}</span>
                </button>
                {!phraseTest && <span className="text-[14px] text-lichen-400">to check I can hear it</span>}
              </div>
              {phraseTest && (
                <p className={`mt-2 text-[14px] leading-relaxed ${micTestPassed ? 'text-moss-300' : phraseTest.state === 'listening' ? 'text-lichen-300' : 'text-lantern-200'}`} aria-live="polite">
                  {phraseTest.state === 'listening' && (phraseTest.heard ? `Hearing: “${phraseTest.heard}”` : 'Go ahead, say it out loud…')}
                  {micTestPassed && `I'll catch “${phraseTest.heard}” on a walk.`}
                  {(phraseTest.state === 'failed' || phraseTest.state === 'error') &&
                    `${phraseTest.message}${phraseTest.heard ? ` (I heard “${phraseTest.heard}”)` : ''}`}
                </p>
              )}
            </div>

            <div className="pt-6 border-t border-parchment-100/10">
              <span className={label}>A 4-digit PIN</span>
              <p className={`${help} mb-3`}>
                Your PIN stops the countdown. If someone makes you cancel, type any other code: the screen says “All good” just the same, but I quietly get you help.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <input type="password" maxLength={4} inputMode="numeric" autoComplete="new-password" placeholder="PIN" aria-label="PIN"
                  value={cancelPin} onChange={e => setCancelPin(e.target.value.replace(/\D/g, ''))}
                  className={`${input} text-center tracking-[0.5em] placeholder:tracking-normal text-lg`} />
                <input type="password" maxLength={4} inputMode="numeric" autoComplete="new-password" placeholder="Again" aria-label="Confirm PIN"
                  value={confirmCancelPin} onChange={e => setConfirmCancelPin(e.target.value.replace(/\D/g, ''))}
                  className={`${input} text-center tracking-[0.5em] placeholder:tracking-normal text-lg`} />
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-7 animate-fade-in">
            <div>
              <span className={label}>What should we chat about?</span>
              <p className={`${help} mb-3`}>I'll bring up news on these when it goes quiet.</p>
              <div className="flex flex-wrap gap-2">
                {NEWS_TOPICS.map(([text, topic]) => {
                  const on = newsInterests.includes(topic);
                  return (
                    <button key={topic} type="button" aria-pressed={on} onClick={() => toggleNewsInterest(topic)}
                      className={`h-10 px-4 rounded-full text-[15px] transition-colors border ${
                        on ? 'bg-lantern-400/15 border-lantern-400/70 text-lantern-200' : 'border-parchment-100/15 text-lichen-300 hover:border-parchment-100/35'}`}>
                      {on && <Check className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />}{text}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className={label}>Where's home?</span>
              <p className={`${help} mb-3`}>Tap the map. When you're within about 100 feet of it, I'll know you made it.</p>
              <HomePicker value={home} onChange={setHome} />
            </div>
          </div>
        )}
      </main>

      <footer className="sticky bottom-0 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-night-950 via-night-950 to-transparent">
        <div className="max-w-md mx-auto">
          {step === 1 && (
            <button onClick={handleNextFromStep1} className="btn-lantern w-full h-14 rounded-2xl text-[17px] font-bold flex items-center justify-center gap-2">
              Next <ArrowRight className="w-5 h-5" />
            </button>
          )}
          {step === 2 && (
            <button onClick={handleNextFromStep2} className="btn-lantern w-full h-14 rounded-2xl text-[17px] font-bold flex items-center justify-center gap-2">
              Next <ArrowRight className="w-5 h-5" />
            </button>
          )}
          {step === 3 && (
            <button onClick={handleSaveProfile} disabled={isSubmitting} className="btn-lantern w-full h-14 rounded-2xl text-[17px] font-bold disabled:opacity-60">
              {isSubmitting ? 'Saving…' : "All set, let's go"}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
