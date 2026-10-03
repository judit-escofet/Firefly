import React, { useRef, useState } from 'react';
import { hashPin, getOrCreateUserId } from '../crypto';
import { api, normalizePhone } from '../services/api';
import { startPhraseTest } from '../services/phraseTest';
import { MOCK_HOME } from '../services/mockData';
import HomePicker from '../components/HomePicker';
import { 
  ArrowLeft, ArrowRight, Check, Shield, Users, Mic, KeyRound, 
  MapPin, Sparkles, AlertCircle, Compass, Stars 
} from 'lucide-react';

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
  const [duressPin, setDuressPin] = useState('');
  const [confirmDuressPin, setConfirmDuressPin] = useState('');

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
      setError('Please share your name for the companion.');
      return;
    }
    const validContacts = contacts.filter(c => c.name.trim() && c.phone.trim());
    if (validContacts.length === 0) {
      setError('Please add at least 1 trusted contact with a name and phone number.');
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
      setError('Cancel PIN must be exactly 4 digits.');
      return;
    }
    if (cancelPin !== confirmCancelPin) {
      setError('Cancel PIN confirmation does not match.');
      return;
    }

    if (!/^\d{4}$/.test(duressPin)) {
      setError('Duress PIN must be exactly 4 digits.');
      return;
    }
    if (duressPin !== confirmDuressPin) {
      setError('Duress PIN confirmation does not match.');
      return;
    }

    if (cancelPin === duressPin) {
      setError('Cancel PIN and Duress PIN must be strictly different.');
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
      setError('Please select at least 1 conversational theme.');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      const userId = getOrCreateUserId();
      const cancelPinHash = await hashPin(cancelPin, userId);
      const duressPinHash = await hashPin(duressPin, userId);

      // Only hashes leave this screen: raw PINs are never stored or sent (A1).
      const profilePayload = {
        user_id: userId,
        name: name.trim(),
        contacts: contacts
          .filter(c => c.name.trim() && c.phone.trim())
          .map(c => ({ id: c.id, name: c.name.trim(), phone: normalizePhone(c.phone) })),
        code_phrase: codePhrase.trim().toLowerCase(),
        pin_hash: cancelPinHash,
        duress_pin_hash: duressPinHash,
        news_interests: newsInterests,
        home: { lat: home.lat, lng: home.lng, label: (home.label || 'Home').trim() },
      };

      const { profile: saved } = await api.saveProfile(profilePayload);
      setIsSubmitting(false);
      onComplete(saved);
    } catch (err) {
      setIsSubmitting(false);
      setError('Failed to save profile: ' + err.message);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between p-5 bg-gradient-to-b from-[#1b1e4b] via-[#241744] to-[#122822] text-slate-100 select-none">
      {/* Top Header & Progress */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={step > 1 ? () => setStep(step - 1) : onBack}
            className="p-2 -ml-2 rounded-xl text-pastel-lavender hover:text-white hover:bg-mystic-800/60"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="text-xs font-cinzel tracking-widest text-gold-300 uppercase font-bold">
            Companion Attunement • {step} of 3
          </span>
          <div className="w-9" />
        </div>

        {/* Shimmering Metallic Progress Bar */}
        <div className="w-full h-1.5 bg-twilight-900 rounded-full overflow-hidden mb-5 border border-white/10">
          <div
            className="h-full bg-gradient-to-r from-mystic-500 via-gold-400 to-amber-500 transition-all duration-300"
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 max-w-md mx-auto w-full flex flex-col justify-center py-2">
        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-crimson-900/60 border border-crimson-500/40 text-red-100 text-xs flex items-start gap-2.5 animate-shake">
            <AlertCircle className="w-4 h-4 text-crimson-400 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* STEP 1: Name and Trusted Contacts */}
        {step === 1 && (
          <div className="space-y-4 animate-fade-in">
            <div>
              <h2 className="text-2xl font-mythic font-bold text-gold-metallic mb-1">
                Traveler & Guardians
              </h2>
              <p className="text-xs text-pastel-lavender/80 leading-relaxed">
                Your traveler identity and the guardian fireflies who will hold vigil over your journey.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-pastel-lavender mb-1.5">
                Traveler Name
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Elena"
                className="w-full px-4 py-3 rounded-2xl bg-mystic-900/80 border border-gold-400/30 text-white placeholder-slate-400 focus:outline-none focus:border-gold-400 focus:ring-1 focus:ring-gold-400 text-sm shadow-sm"
              />
            </div>

            {/* Trusted Contacts as Fireflies waiting at home */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-pastel-lavender flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-gold-400" />
                  <span>Guardian Fireflies ({contacts.length}/3)</span>
                </label>
                {contacts.length < 3 && (
                  <button
                    onClick={addContact}
                    className="text-xs font-bold text-gold-300 hover:text-gold-200"
                  >
                    + Add Guardian
                  </button>
                )}
              </div>

              <div className="space-y-2.5">
                {contacts.map((contact, idx) => (
                  <div key={contact.id} className="p-3.5 rounded-2xl glass-mythic relative flex flex-col gap-2.5 border border-white/10">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full bg-gold-400 shadow-firefly animate-pulse" />
                        <span className="text-xs font-cinzel text-gold-200 font-semibold">
                          Guardian Vigil {idx + 1}
                        </span>
                      </div>
                      {contacts.length > 1 && (
                        <button
                          onClick={() => removeContact(contact.id)}
                          className="text-[11px] text-crimson-400 hover:text-crimson-300"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="Name (e.g. Maya)"
                        value={contact.name}
                        onChange={e => updateContact(contact.id, 'name', e.target.value)}
                        className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-gold-400"
                      />
                      <input
                        type="tel"
                        placeholder="Phone number"
                        value={contact.phone}
                        onChange={e => updateContact(contact.id, 'phone', e.target.value)}
                        className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-gold-400"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: Code Phrase & Two PINs */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <h2 className="text-2xl font-mythic font-bold text-gold-metallic mb-1">
                Whispers & Twin PINs
              </h2>
              <p className="text-xs text-pastel-lavender/80 leading-relaxed">
                Secret verbal triggers and dual PINs for undetectable safety.
              </p>
            </div>

            {/* Code Phrase */}
            <div className="p-4 rounded-2xl glass-mythic space-y-3 border border-white/15">
              <label className="block text-xs font-semibold uppercase tracking-wider text-pastel-lavender">
                Spoken Code Phrase
              </label>
              <p className="text-xs text-slate-200 leading-relaxed">
                A phrase you can speak naturally without arousing suspicion. When Firefly hears this, it immediately opens the quiet countdown.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={codePhrase}
                  onChange={e => setCodePhrase(e.target.value)}
                  placeholder="e.g. the moon is bright tonight"
                  className="flex-1 px-3 py-2.5 rounded-xl bg-twilight-950 border border-white/15 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-gold-400"
                />
                <button
                  type="button"
                  onClick={handleTestMic}
                  className={`px-3 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
                    micTestPassed
                      ? 'bg-emerald-600 text-white'
                      : isTestingMic
                      ? 'bg-gold-400 text-twilight-950 animate-pulse'
                      : 'bg-mystic-800 text-gold-300 border border-gold-400/30'
                  }`}
                >
                  <Mic className="w-3.5 h-3.5" />
                  <span>{isTestingMic ? 'Listening… (tap to stop)' : micTestPassed ? 'Heard it!' : 'Say it once'}</span>
                </button>
              </div>
              {phraseTest && (
                <p className={`text-[11px] leading-relaxed ${micTestPassed ? 'text-pastel-mint' : phraseTest.state === 'listening' ? 'text-slate-300' : 'text-gold-200'}`} aria-live="polite">
                  {phraseTest.state === 'listening' && (phraseTest.heard ? `Hearing: “${phraseTest.heard}”` : 'Say your phrase out loud now…')}
                  {micTestPassed && `Firefly will catch “${phraseTest.heard}” on a walk.`}
                  {(phraseTest.state === 'failed' || phraseTest.state === 'error') &&
                    `${phraseTest.message}${phraseTest.heard ? ` (heard “${phraseTest.heard}”)` : ''}`}
                </p>
              )}
            </div>

            {/* Dual PINs */}
            <div className="p-4 rounded-2xl glass-mythic space-y-4 border border-gold-400/20">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-gold-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                  Two Distinct PINs
                </h3>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Both display identically on screen when entered, so nobody watching can tell which was typed.
              </p>

              {/* Cancel PIN */}
              <div className="space-y-1.5 pt-1 border-t border-white/10">
                <span className="text-xs font-semibold text-pastel-mint">
                  1. Cancel PIN (safely ends countdown)
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="password"
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="4 digits"
                    value={cancelPin}
                    onChange={e => setCancelPin(e.target.value.replace(/\D/g, ''))}
                    className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-center text-white tracking-widest focus:outline-none focus:border-gold-400"
                  />
                  <input
                    type="password"
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="Confirm"
                    value={confirmCancelPin}
                    onChange={e => setConfirmCancelPin(e.target.value.replace(/\D/g, ''))}
                    className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-center text-white tracking-widest focus:outline-none focus:border-gold-400"
                  />
                </div>
              </div>

              {/* Duress PIN */}
              <div className="space-y-1.5 pt-2 border-t border-white/10">
                <span className="text-xs font-semibold text-gold-300">
                  2. Duress PIN (silently notifies guardians)
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="password"
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="4 digits"
                    value={duressPin}
                    onChange={e => setDuressPin(e.target.value.replace(/\D/g, ''))}
                    className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-center text-white tracking-widest focus:outline-none focus:border-gold-400"
                  />
                  <input
                    type="password"
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="Confirm"
                    value={confirmDuressPin}
                    onChange={e => setConfirmDuressPin(e.target.value.replace(/\D/g, ''))}
                    className="px-3 py-2 rounded-xl bg-twilight-950 border border-white/15 text-xs text-center text-white tracking-widest focus:outline-none focus:border-gold-400"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: News Interests and Home Address */}
        {step === 3 && (
          <div className="space-y-4 animate-fade-in">
            <div>
              <h2 className="text-2xl font-mythic font-bold text-gold-metallic mb-1">
                Traveler Interests
              </h2>
              <p className="text-xs text-pastel-lavender/80 leading-relaxed">
                Whimsical topics for the companion to speak of, and your hearth destination.
              </p>
            </div>

            {/* Conversation Topics */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-pastel-lavender mb-2">
                Companion Themes
              </label>
              <div className="flex flex-wrap gap-2">
                {NEWS_TOPICS.map(([label, topic]) => {
                  const isSelected = newsInterests.includes(topic);
                  return (
                    <button
                      key={topic}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleNewsInterest(topic)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                        isSelected
                          ? 'bg-gradient-to-r from-mystic-600 to-indigo-600 text-white border border-gold-400 shadow-sm scale-105'
                          : 'bg-mystic-900/60 text-slate-300 border border-white/10 hover:border-gold-400/40'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Home Address */}
            <div className="p-4 rounded-2xl glass-mythic space-y-2 border border-white/15">
              <label className="text-xs font-semibold uppercase tracking-wider text-pastel-lavender flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-gold-400" />
                <span>Home Hearth Destination</span>
              </label>
              <HomePicker value={home} onChange={setHome} />

            </div>
          </div>
        )}
      </div>

      {/* Bottom Action */}
      <div className="pt-3 max-w-md mx-auto w-full">
        {step === 1 && (
          <button
            onClick={handleNextFromStep1}
            className="w-full py-4 px-6 rounded-2xl btn-gold-metallic font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <span>Proceed to Secret Signs</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        )}

        {step === 2 && (
          <button
            onClick={handleNextFromStep2}
            className="w-full py-4 px-6 rounded-2xl btn-gold-metallic font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <span>Proceed to Interests</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        )}

        {step === 3 && (
          <button
            onClick={handleSaveProfile}
            disabled={isSubmitting}
            className="w-full py-4 px-6 rounded-2xl btn-gold-metallic font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            <Check className="w-5 h-5 stroke-[2.5]" />
            <span>{isSubmitting ? 'Attuning...' : 'Save & Ready to Walk'}</span>
          </button>
        )}
      </div>
    </div>
  );
}
