import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LANGUAGES, type Language } from '@locallens/contracts';
import { en } from './en';
import { te } from './te';

const STORAGE_KEY = 'll_lang';

// Storage can be unavailable (private mode, blocked site data); the app must still work, defaulting to Telugu.
export function storedLanguage(): Language | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (LANGUAGES as readonly string[]).includes(v ?? '') ? (v as Language) : null;
  } catch {
    return null;
  }
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, te: { translation: te } },
  lng: storedLanguage() ?? 'te',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes output
});

export default i18n;
