import { createMenuTranslator, menuLanguage } from "../ui/menuLocale";

export function zoteroMenuLanguage() {
  return menuLanguage(
    String(
      (Zotero as any).locale ||
        (typeof Services !== "undefined"
          ? (Services as any).locale?.appLocaleAsBCP47
          : "") ||
        "en-US",
    ),
  );
}
export function hostMenuText() {
  return createMenuTranslator(zoteroMenuLanguage());
}
