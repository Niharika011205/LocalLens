import type { LocalizedName, LocationSummary } from '@locallens/contracts';

/** Telugu name when the UI is in Telugu and one exists; English otherwise. */
export function localName(name: LocalizedName, lang: string): string {
  return lang === 'te' && name.te ? name.te : name.en;
}

export function locationLabel(loc: LocationSummary, lang: string): string {
  return lang === 'te' && loc.labelTe ? loc.labelTe : loc.label;
}

/** Dates are shown in India Standard Time regardless of the device's timezone. */
export function formatDateTime(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'te' ? 'te-IN' : 'en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}

export function formatDate(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'te' ? 'te-IN' : 'en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(
    new Date(iso),
  );
}

/** Formats a YYYY-MM-DD India date (deadlines). */
export function formatDay(day: string, lang: string): string {
  return formatDate(`${day}T00:00:00+05:30`, lang);
}

/** Whole days from today (India date) until a YYYY-MM-DD date; 0 = today. */
export function daysUntil(day: string, now = Date.now()): number {
  const today = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "Today, 5:47 pm" / "Yesterday, 9:10 am" / full date — the time readers care about in a news feed. */
export function formatWhen(iso: string, lang: string, labels: { today: string; yesterday: string }, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const time = d.toLocaleTimeString(lang === 'te' ? 'te-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  if (day(d) === day(now)) return `${labels.today}, ${time}`;
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return `${labels.yesterday}, ${time}`;
  return formatDateTime(iso, lang);
}
