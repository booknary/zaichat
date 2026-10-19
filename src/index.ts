import Addon from "./addon";

if (!(Zotero as any).ZaiChat) {
  _globalThis.addon = new Addon();
  (Zotero as any).ZaiChat = addon;
}
