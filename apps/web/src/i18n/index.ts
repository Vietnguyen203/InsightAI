import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LANGUAGES = ['vi', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = 'insightai.language';

function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

export function persistLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for this session only.
  }
}

void i18n.use(initReactI18next).init({
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: readStoredLanguage(),
  fallbackLng: 'vi',
  interpolation: { escapeValue: false }, // React already escapes output
});

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language;
});

export default i18n;
