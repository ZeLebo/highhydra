import type { Download } from "@types";
import {
  getHighballRunner,
  highballGameKey,
} from "@main/services/highball-runner";
import { updateGameRecord } from "@main/services/game-record-updater";

export const prepareHighballDownload = async (download: Download) => {
  if (
    process.platform !== "darwin" ||
    download.shop === "launchbox" ||
    download.useHighball === false
  )
    return;
  const key = highballGameKey(download);
  const { prefix, downloadPath } = await (
    await getHighballRunner()
  ).prepareDownload(key);
  download.downloadPath = downloadPath;
  download.useHighball = true;
  await updateGameRecord(key, () => ({ winePrefixPath: prefix }));
};
