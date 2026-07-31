import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ptBR from "./locales/pt-BR.json";
import en from "./locales/en.json";

i18n.use(initReactI18next).init({
  resources: {
    "pt-BR": { translation: ptBR },
    en: { translation: en }
  },
  lng: (typeof window !== "undefined" && window.__RUNTIME_CONFIG__?.defaultLang) || "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false // React already safes from XSS
  }
});

export default i18n;
