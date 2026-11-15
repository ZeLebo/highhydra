import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function load<T>(file: string, modules: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  vm.runInNewContext(source.outputText, {
    exports,
    require: (name: string) =>
      modules[name] ?? assert.fail(`Unexpected import ${name}`),
    process: { ...process, platform: "darwin" },
  });
  return exports as T;
}

test("macOS installer discovery never searches another Wine prefix", () => {
  const module = load<{
    getInstallerTargetDirectories: (
      download: string,
      prefix: string | null
    ) => string[];
  }>("src/main/helpers/installer-target-directories.ts", {
    "node:fs": fs,
    "node:path": path,
    "@main/services/system-path": {
      SystemPath: { getPath: () => assert.fail("No global prefix") },
    },
  });
  const directories = Array.from(
    module.getInstallerTargetDirectories("/download", "/bottles/own")
  ) as string[];
  assert.ok(directories.length > 0);
  assert.ok(
    directories.every((directory) =>
      directory.startsWith("/bottles/own/drive_c")
    )
  );
  assert.deepEqual(
    Array.from(module.getInstallerTargetDirectories("/download", null)),
    []
  );
});

for (const endpoint of ["start-game-download", "add-game-to-queue"]) {
  test(`${endpoint} persists bottle downloads and leaves download-only files in their chosen folder`, async () => {
    type Transfer = { shop: string; objectId: string; downloadPath: string };
    type Handler = (event: null, payload: object) => Promise<{ ok: boolean }>;
    const games = new Map<string, { winePrefixPath?: string }>();
    const downloads = new Map<string, Transfer>();
    const started: Transfer[] = [];
    const prepared: string[] = [];
    let handler: Handler | undefined;
    const modules: Record<string, unknown> = {
      electron: {
        dialog: { showErrorBox: () => assert.fail("Unexpected error") },
      },
      "@main/services/highball-runner": {
        HighballError: class extends Error {},
        highballGameKey: (game: { shop: string; objectId: string }) =>
          `${game.shop}:${game.objectId}`,
        getHighballRunner: async () => ({
          prepareDownload: async (key: string) => {
            prepared.push(key);
            return {
              prefix: `/bottles/${key}`,
              downloadPath: `/bottles/${key}/drive_c/Games/Downloads`,
            };
          },
        }),
      },
      "@main/services/game-record-updater": {
        updateGameRecord: async (key: string, patch: () => object) =>
          games.set(key, { ...games.get(key), ...patch() }),
      },
      "../register-event": {
        registerEvent: (_name: string, fn: Handler) => {
          handler = fn;
        },
      },
      "@main/services": {
        logger: {
          log: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        HydraApi: { post: async () => {} },
        DownloadManager: { cancelDownload: async () => {} },
        DownloadOrchestrator: {
          preparesRealDebridInBackground: () => false,
          validateDownloadOrMarkPending: async () => {},
          startPreparedDownload: async (download: Transfer) => {
            if (download.objectId !== "plain")
              assert.equal(
                games.get(`${download.shop}:${download.objectId}`)
                  ?.winePrefixPath,
                `/bottles/${download.shop}:${download.objectId}`
              );
            started.push(download);
          },
        },
      },
      "@main/services/library-sync": { createGame: async () => {} },
      "@main/level": {
        gamesSublevel: { get: async (key: string) => games.get(key) },
        downloadsSublevel: {
          put: async (key: string, value: Transfer) =>
            downloads.set(key, value),
        },
        levelKeys: { game: (shop: string, id: string) => `${shop}:${id}` },
      },
      "@shared": { parseBytes: () => null },
      "@main/helpers": {
        getGlobalTrackers: async () => [],
        getMultipartDownloadParts: async () => [],
        prepareGameEntry: async ({ gameKey }: { gameKey: string }) =>
          games.set(gameKey, {}),
        isKnownDownloadError: () => false,
        handleDownloadError: (error: Error) => {
          throw error;
        },
      },
    };
    const orchestrator = (
      modules["@main/services"] as {
        DownloadOrchestrator: {
          startPreparedDownload: (d: Transfer) => Promise<void>;
          enqueuePreparedDownload?: (d: Transfer) => Promise<void>;
        };
      }
    ).DownloadOrchestrator;
    orchestrator.enqueuePreparedDownload = orchestrator.startPreparedDownload;
    modules["@main/helpers/prepare-highball-download"] = load(
      "src/main/helpers/prepare-highball-download.ts",
      modules
    );
    load(`src/main/events/torrenting/${endpoint}.ts`, modules);
    for (const objectId of ["10", "11", "10"]) {
      assert.equal(
        (
          await handler!(null, {
            shop: "steam",
            objectId,
            title: "Fixture",
            downloadPath: "/external",
            downloader: 1,
            uri: "https://fixture.invalid/game.zip",
            automaticallyExtract: true,
          })
        ).ok,
        true
      );
    }
    assert.deepEqual(prepared, ["steam:10", "steam:11", "steam:10"]);
    assert.equal(
      started[0].downloadPath,
      "/bottles/steam:10/drive_c/Games/Downloads"
    );
    assert.equal(
      started[1].downloadPath,
      "/bottles/steam:11/drive_c/Games/Downloads"
    );
    assert.equal(started[2].downloadPath, started[0].downloadPath);
    assert.equal(downloads.size, 2);
    assert.equal(
      (
        await handler!(null, {
          shop: "steam",
          objectId: "plain",
          title: "Only a download",
          downloadPath: "/chosen",
          useHighball: false,
          downloader: 1,
          uri: "https://fixture.invalid/game.zip",
        })
      ).ok,
      true
    );
    assert.equal(started[3].downloadPath, "/chosen");
    assert.equal(games.get("steam:plain")?.winePrefixPath, undefined);
    assert.equal(
      prepared.length,
      3,
      "download-only must never ask Highball for a bottle"
    );
  });
}
