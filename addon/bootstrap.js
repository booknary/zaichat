var chromeHandle;

function install() {}

async function startup({ rootURI }) {
  const startupService = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = startupService.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "zaichat", rootURI + "content/"]],
  );
  const mainWindow = Zotero.getMainWindow();
  const browserGlobal = mainWindow || Services.appShell.hiddenDOMWindow;
  // ReactDOM expects browser globals while the plugin script itself runs in
  // an isolated bootstrap sandbox.
  const ctx = {
    rootURI,
    window: mainWindow,
    document: mainWindow?.document,
    navigator: mainWindow?.navigator,
    AbortController: browserGlobal.AbortController,
    AbortSignal: browserGlobal.AbortSignal,
    fetch: browserGlobal.fetch.bind(browserGlobal),
    Headers: browserGlobal.Headers,
    Request: browserGlobal.Request,
    Response: browserGlobal.Response,
    ReadableStream: browserGlobal.ReadableStream,
    TextDecoder: browserGlobal.TextDecoder,
    TextEncoder: browserGlobal.TextEncoder,
  };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(`${rootURI}/content/scripts/zaichat.js`, ctx);
  await Zotero.ZaiChat.hooks.onStartup();
}

async function onMainWindowLoad({ window }) {
  await Zotero.ZaiChat?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await Zotero.ZaiChat?.hooks.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) return;
  await Zotero.ZaiChat?.hooks.onShutdown();
  chromeHandle?.destruct();
  chromeHandle = null;
}

function uninstall() {}
