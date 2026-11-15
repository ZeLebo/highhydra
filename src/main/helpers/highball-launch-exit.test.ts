import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

for (const detected of [false, true]) {
  test(`a nonzero Highball exit ${detected ? "after a detected game is logged without a launch error" : "before game detection remains a launch error"}`, async () => {
    const source = ts.createSourceFile(
      "launch-game.ts",
      fs.readFileSync("src/main/helpers/launch-game.ts", "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    let initializer: ts.Expression | undefined;
    source.forEachChild((node) => {
      if (ts.isVariableStatement(node)) {
        const variable = node.declarationList.declarations.find(
          (declaration) =>
            declaration.name.getText(source) === "launchResolvedGame"
        );
        if (variable) initializer = variable.initializer;
      }
    });
    assert.ok(initializer);
    const code = ts.transpileModule(
      `exports.launch = ${initializer.getText(source)}`,
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }
    ).outputText;
    type Launch = (
      key: string,
      shop: string,
      id: string,
      path: string,
      compatibility: null,
      options: null,
      hud: boolean,
      gamemode: boolean
    ) => Promise<number>;
    const context = {} as { launch: Launch };
    const dialogs: string[] = [];
    const warnings: string[] = [];
    const failures: string[] = [];
    vm.runInNewContext(code, {
      exports: context,
      process: { platform: "darwin" },
      isWindowsExecutable: () => true,
      gamesSublevel: {
        get: async () => ({
          shop: "steam",
          objectId: "322170",
          title: "Geometry Dash",
        }),
      },
      getHighballRunner: async () => ({
        ensureBottle: async () => "/own-bottle",
        launch: async (_game: unknown, onError: (error: Error) => void) => {
          onError(new Error("exit=1 after 71s"));
          return 42;
        },
      }),
      resolveHighballGame: async (game: unknown) => game,
      updateGameRecord: async () => undefined,
      wasGameLauncherGameDetected: () => detected,
      logger: {
        warn: (_message: string, error: Error) => warnings.push(error.message),
        error: (_message: string, error: Error) => failures.push(error.message),
      },
      WindowManager: { closeGameLauncherWindow: () => undefined },
      dialog: {
        showErrorBox: (_title: string, message: string) =>
          dialogs.push(message),
      },
    });
    assert.equal(
      await context.launch(
        "steam:322170",
        "steam",
        "322170",
        "/game.exe",
        null,
        null,
        false,
        false
      ),
      42
    );
    assert.equal(dialogs.length, detected ? 0 : 1);
    assert.equal(warnings.length, detected ? 1 : 0);
    assert.equal(failures.length, detected ? 0 : 1);
    assert.ok([...warnings, ...failures].includes("exit=1 after 71s"));
  });
}
