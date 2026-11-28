/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Link do card do financial-analysis-framework (padrão: /faf/Monitor_de_Mercado) */
  readonly VITE_FAF_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
