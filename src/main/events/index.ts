import { appVersion, defaultDownloadsPath, isStaging } from "@main/constants";
import { getHighballRunner } from "@main/services/highball-runner";
import type { GameShop } from "@types";
import { ipcMain } from "electron";
import { ScreenshotService } from "@main/services/screenshot";
import {
  cleanupAchievementSouvenirSync,
  getAchievementSouvenirSyncDetails,
  getAchievementSouvenirSyncStatus,
  retryAchievementSouvenirSync,
} from "@main/services/achievements/grouped-souvenir-worker";

import "./auth";
import "./autoupdater";
import "./big-picture";
import "./catalogue";
import "./chat";
import "./cloud-save";
import "./connectivity";
import "./download-sources";
import "./friends";
import "./hardware";
import "./library";
import "./leveldb";
import "./main-window-controls";
import "./misc";
import "./recompilation";
import "./notifications";
import "./profile";
import "./screenshots";
import "./themes";
import "./torrenting";
import "./user";
import "./user-preferences";
import "./library/transfer-game-files";
import "./emulators";
import "./retroarch";
import "./epic";
import "./screenshot-input";

ipcMain.handle("ping", () => "pong");
ipcMain.handle("getVersion", () => appVersion);
ipcMain.handle("isStaging", () => isStaging);
ipcMain.handle("getDefaultDownloadsPath", async (_event, shop?: GameShop) =>
  process.platform === "darwin" && shop && shop !== "launchbox"
    ? (await getHighballRunner()).home
    : defaultDownloadsPath
);
ipcMain.handle("getScreenshotsPath", () =>
  ScreenshotService.getScreenshotsPath()
);
ipcMain.handle("getAchievementSouvenirSyncStatus", () =>
  getAchievementSouvenirSyncStatus()
);
ipcMain.handle("getAchievementSouvenirSyncDetails", () =>
  getAchievementSouvenirSyncDetails()
);
ipcMain.handle("retryAchievementSouvenirSync", () =>
  retryAchievementSouvenirSync()
);
ipcMain.handle("cleanupAchievementSouvenirSync", () =>
  cleanupAchievementSouvenirSync()
);
ipcMain.handle("getCloudIframeUrl", () =>
  new URL("/cloud", import.meta.env.MAIN_VITE_CHECKOUT_URL).toString()
);
