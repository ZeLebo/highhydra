import { registerEvent } from "../register-event";

export const restartAndInstallUpdate = () => {
  throw new Error("HighHydra updates are installed manually.");
};

registerEvent("restartAndInstallUpdate", restartAndInstallUpdate);
