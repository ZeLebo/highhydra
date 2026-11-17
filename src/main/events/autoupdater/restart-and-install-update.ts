import { registerEvent } from "../register-event";

export const restartAndInstallUpdate = () => {
  throw new Error("Hydraball updates are installed manually.");
};

registerEvent("restartAndInstallUpdate", restartAndInstallUpdate);
