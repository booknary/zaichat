import hooks from "./hooks";
import { ChatManager } from "./core/chatManager";
import { SemanticDataManager } from "./semantic/semanticDataManager";

class Addon {
  public data: {
    alive: boolean;
    initialized: boolean;
    env: "development" | "production";
    manager?: ChatManager;
    semanticManager?: SemanticDataManager;
    runtimeResourceRoot?: string;
    semanticModelInstaller?: import("./semantic/semanticModelInstaller").SemanticModelInstaller;
    preferencePaneID?: string;
    startupStage?: string;
    startupError?: string;
    preferenceEvent?: string;
    preferenceError?: string;
    runtimeChecks?: {
      abortController: boolean;
      fetch: boolean;
      textDecoder: boolean;
    };
  } = {
    alive: true,
    initialized: false,
    env: __env__,
  };
  public hooks = hooks;
  public api = {};
}

export default Addon;
