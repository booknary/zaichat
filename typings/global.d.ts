declare const __env__: "development" | "production";
declare const _globalThis: any;
declare const addon: import("../src/addon").default;
declare const rootURI: string;

declare namespace _ZoteroTypes {
  interface Prefs {
    PluginPrefsMap: {
      sidebarWidth: number;
      sidebarOpen: boolean;
      displayMode: string;
      modelProfiles: string;
      defaultModelProfileID: string;
      systemPrompt: string;
      maxToolCalls: number;
      maxAttachments: number;
      developerDiagnostics: boolean;
      contextBudgetChars: number;
      evidenceBudgetChars: number;
      semanticEnabled: boolean;
      semanticArtifactRoot: string;
      semanticModelID: string;
      semanticEnrichAbstracts: boolean;
    };
  }
}
