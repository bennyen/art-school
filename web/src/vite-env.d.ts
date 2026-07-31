/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: { defaultLang: string };
  }
}