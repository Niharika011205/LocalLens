/**
 * First-pass risk screen for citizen submissions. Deterministic keyword matching in English and Telugu, so it works
 * when AI services are down. It only ever ADDS scrutiny: a "high" result means a senior editor must publish; a "normal"
 * result never skips the normal review. Missing something here is expected — editors can raise the risk manually.
 *
 * Telugu words take suffixes (అరెస్టు → అరెస్టయ్యాడు), so Telugu terms match as substrings; English terms match whole
 * words so that "fire" does not match "firewall".
 */

type RiskReason = 'allegation_or_crime' | 'communal_or_caste' | 'health_emergency' | 'disaster' | 'minors';

const TERMS: Record<RiskReason, { en: string[]; te: string[] }> = {
  allegation_or_crime: {
    en: ['accused', 'allegation', 'alleged', 'allegedly', 'arrest', 'arrested', 'bribe', 'bribery', 'corruption', 'scam', 'fraud', 'murder', 'murdered', 'killed', 'rape', 'assault', 'assaulted', 'attack', 'attacked', 'kidnap', 'kidnapped', 'fir', 'police case', 'molested', 'harassment'],
    te: ['అరెస్ట', 'ఆరోపణ', 'లంచం', 'అవినీతి', 'మోసం', 'హత్య', 'అత్యాచారం', 'దాడి', 'కిడ్నాప్', 'కేసు నమోదు', 'వేధింపు'],
  },
  communal_or_caste: {
    en: ['caste', 'communal', 'riot', 'riots', 'religious clash', 'mob'],
    te: ['కుల', 'మత ఘర్షణ', 'అల్లర్లు', 'అల్లర్ల'],
  },
  health_emergency: {
    en: ['outbreak', 'epidemic', 'cholera', 'dengue', 'food poisoning', 'deaths', 'death toll', 'contaminated'],
    te: ['వ్యాధి వ్యాప్తి', 'కలరా', 'డెంగ్యూ', 'ఫుడ్ పాయిజన్', 'మరణాలు', 'మృతి', 'కలుషిత'],
  },
  disaster: {
    en: ['flood', 'floods', 'cyclone', 'fire accident', 'collapse', 'collapsed', 'stampede', 'earthquake', 'landslide', 'explosion'],
    te: ['వరద', 'తుఫాను', 'అగ్ని ప్రమాదం', 'కూలి', 'తొక్కిసలాట', 'భూకంపం', 'పేలుడు'],
  },
  minors: {
    en: ['minor', 'minors', 'child abuse', 'schoolgirl', 'schoolboy', 'juvenile'],
    te: ['మైనర్', 'బాలిక', 'బాలుడు', 'చిన్నారి'],
  },
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.entries(TERMS).map(([reason, { en, te }]) => ({
  reason: reason as RiskReason,
  en: new RegExp(`\\b(${en.map(escape).join('|')})\\b`, 'i'),
  te: te.map((t) => t.normalize('NFC')),
}));

export function screenRisk(text: string, categorySlug: string | null): { level: 'normal' | 'high'; reasons: string[] } {
  const normalised = text.normalize('NFC');
  const reasons: string[] = PATTERNS.filter((p) => p.en.test(normalised) || p.te.some((t) => normalised.includes(t))).map((p) => p.reason);
  if (categorySlug === 'public_safety' && !reasons.includes('public_safety')) reasons.push('public_safety');
  return { level: reasons.length ? 'high' : 'normal', reasons };
}
