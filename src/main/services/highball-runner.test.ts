import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test, type TestContext } from "node:test";
import { build } from "esbuild";

let modulePath: string;
let runtime: typeof import("./highball-runner");
let buildDirectory: string;
before(async () => {
  await fs.mkdir(path.resolve("dist"), { recursive: true });
  buildDirectory = await fs.mkdtemp(path.resolve("dist/highball-test-"));
  modulePath = path.join(buildDirectory, "runner.mjs");
  await build({
    entryPoints: ["src/main/services/highball-runner.ts"],
    outfile: modulePath,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@main": path.resolve("src/main") },
  });
  runtime = await import(pathToFileURL(modulePath).href);
});
after(async () => {
  await fs.rm(buildDirectory, { recursive: true, force: true });
});

async function fixture(t: TestContext) {
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hydraball-runner-"))
  );
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cli = path.join(home, "highball");
  await fs.writeFile(
    cli,
    `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const [verb,action,name]=process.argv.slice(2);const home=process.env.HIGHBALL_HOME;const bottle=(verb==='run'||verb==='tricks')?action:name;const prefix=path.join(home,'bottles',bottle);
fs.appendFileSync(path.join(home,'commands.jsonl'),JSON.stringify(process.argv.slice(2))+'\\n');
if(verb==='bottle' && action==='create'){
 fs.mkdirSync(path.join(prefix,'drive_c'),{recursive:true});
 fs.writeFileSync(path.join(prefix,'bottle.json'),JSON.stringify({name,pins:[],engineID:'fixture',renderer:'dxmt',futureSetting:{preserve:true}}));
} else if(verb==='bottle' && action==='ps'){
 console.log(fs.existsSync(path.join(prefix,'running'))?'123\\tprogram\\t'+(fs.readFileSync(path.join(prefix,'running'),'utf8').trim()||'Game.exe')+'\\trenderer=dxmt':'124\\tplumbing\\twineserver\\trenderer=dxmt');
} else if(verb==='bottle' && action==='kill'){
 fs.rmSync(path.join(prefix,'running'),{force:true});
} else if(verb==='tricks'){
 const dll=path.join(prefix,'drive_c','windows','syswow64','mfc42u.dll');fs.mkdirSync(path.dirname(dll),{recursive:true});fs.writeFileSync(dll,'fixture');
} else if(verb==='run') { process.exit(0); } else process.exit(17);
`,
    { mode: 0o755 }
  );
  return { runner: new runtime.HighballRunner(cli, home), home };
}

// Both ready-folder and setup downloads share their own persisted prefix.
test("one bottle per game survives repeated and concurrent preparation", async (t) => {
  const { runner, home } = await fixture(t);
  const [first, again, other] = await Promise.all([
    runner.prepareDownload("steam:10"),
    runner.prepareDownload("steam:10"),
    runner.prepareDownload("steam:11"),
  ]);
  assert.equal(first.prefix, again.prefix);
  assert.notEqual(first.prefix, other.prefix);
  assert.ok(first.downloadPath.startsWith(first.prefix + path.sep));
  const restarted = new runtime.HighballRunner(runner.cliPath, home);
  assert.deepEqual(await restarted.prepareDownload("steam:10"), first);
  const commands = (
    await fs.readFile(path.join(home, "commands.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(commands.filter((args) => args[1] === "create").length, 2);
});

test("a stable Highball pin follows EXE changes and preserves other settings", async (t) => {
  const { runner } = await fixture(t);
  const game = {
    shop: "custom",
    objectId: "test-id",
    title: "A game with spaces",
  };
  const { prefix, downloadPath } = await runner.prepareDownload(
    runtime.highballGameKey(game)
  );
  const first = path.join(downloadPath, "Game.exe");
  const second = path.join(downloadPath, "Game 2.exe");
  await fs.writeFile(first, "fixture");
  await fs.writeFile(second, "fixture");
  const registration = await runner.registerGame({
    ...game,
    executablePath: first,
    launchOptions: 'MY_SETTING=value %command% --label "hello world"',
    artworkTall: "https://images.example/portrait.png",
  });
  const file = path.join(prefix, "bottle.json");
  let settings = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(settings.pins[0].arguments, ["--label", "hello world"]);
  assert.deepEqual(settings.pins[0].environment, { MY_SETTING: "value" });
  assert.equal(
    settings.pins[0].artworkTall,
    "https://images.example/portrait.png"
  );
  settings.pins[0].renderer = "dxvk";
  settings.pins[0].name = "My custom Highball title";
  settings.pins.push({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Another program",
    path: "other.exe",
    arguments: [],
    environment: {},
  });
  await fs.writeFile(file, JSON.stringify(settings));
  const changed = await runner.registerGame({
    ...game,
    executablePath: second,
  });
  settings = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(registration.pinId, changed.pinId);
  assert.equal(settings.pins.length, 2);
  const pin = settings.pins.find(
    (p: { id: string }) => p.id === registration.pinId
  );
  assert.equal(pin.path, "Games/Downloads/Game 2.exe");
  assert.equal(pin.renderer, "dxvk");
  assert.equal(pin.name, "My custom Highball title");
  assert.deepEqual(settings.futureSetting, { preserve: true });
});

test("a migrated uppercase pin UUID survives EXE changes and launcher restarts", async (t) => {
  const { runner, home } = await fixture(t);
  const game = {
    shop: "steam",
    objectId: "10",
    title: "Migrated game",
    highballPinId: "F97F779B-97A2-578E-8A5B-545D3F6E5104",
  };
  const { prefix, downloadPath } = await runner.prepareDownload(
    runtime.highballGameKey(game)
  );
  const first = path.join(downloadPath, "Old.exe");
  const second = path.join(downloadPath, "New.exe");
  await fs.writeFile(first, "fixture");
  await fs.writeFile(second, "fixture");
  await runner.registerGame({ ...game, executablePath: first });
  const restarted = new runtime.HighballRunner(runner.cliPath, home);
  const result = await restarted.registerGame({
    ...game,
    executablePath: second,
  });
  const settings = JSON.parse(
    await fs.readFile(path.join(prefix, "bottle.json"), "utf8")
  );
  assert.equal(result.pinId, game.highballPinId);
  assert.equal(settings.pins.length, 1);
  assert.equal(settings.pins[0].id, game.highballPinId);
  assert.equal(settings.pins[0].path, "Games/Downloads/New.exe");
});

test("cross-bottle EXEs, symlink escapes and prefix overrides are rejected", async (t) => {
  const { runner, home } = await fixture(t);
  const game = { shop: "custom", objectId: "safe", title: "Safe" };
  const key = runtime.highballGameKey(game);
  const { downloadPath } = await runner.prepareDownload(key);
  const outside = path.join(home, "outside.exe");
  await fs.writeFile(outside, "fixture");
  const link = path.join(downloadPath, "escape.exe");
  await fs.symlink(outside, link);
  await assert.rejects(
    runner.registerGame({ ...game, executablePath: link }),
    /inside its own/
  );
  const own = path.join(downloadPath, "Game.exe");
  await fs.writeFile(own, "fixture");
  await assert.rejects(
    runner.registerGame({
      ...game,
      executablePath: own,
      launchOptions: "WINEPREFIX=/another %command%",
    }),
    /without replacing/
  );
  const other = await runner.prepareDownload("steam:another");
  const foreign = path.join(other.downloadPath, "Game.exe");
  await fs.writeFile(foreign, "fixture");
  await assert.rejects(
    runner.registerGame({ ...game, executablePath: foreign }),
    /inside its own/
  );
});

test("running proof excludes Wine plumbing and Stop addresses only the chosen bottle", async (t) => {
  const { runner, home } = await fixture(t);
  const first = await runner.prepareDownload("custom:first");
  const other = await runner.prepareDownload("custom:other");
  const processes = [
    { winePrefixPath: first.prefix },
    { winePrefixPath: other.prefix },
  ];
  assert.equal(
    await runner.isRunning("custom:first", processes, ["Game.exe"]),
    false
  );
  await fs.writeFile(path.join(first.prefix, "running"), "");
  await fs.writeFile(path.join(other.prefix, "running"), "");
  assert.equal(
    await runner.isRunning("custom:first", processes, ["Game.exe"]),
    true
  );
  await runner.stop("custom:first");
  assert.equal(
    await runner.isRunning("custom:first", processes, ["Game.exe"]),
    false
  );
  assert.equal(
    await runner.isRunning("custom:other", processes, ["Game.exe"]),
    true
  );
  const commands = (
    await fs.readFile(path.join(home, "commands.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.filter((args) => args[1] === "kill"),
    [["bottle", "kill", runtime.highballBottleName("custom:first")]]
  );
});

test("installers prepare their own MFC runtime once and reuse it", async (t) => {
  const { runner, home } = await fixture(t);
  const key = "steam:installer";
  const { downloadPath } = await runner.prepareDownload(key);
  const installer = path.join(downloadPath, "setup.exe");
  await fs.writeFile(installer, "fixture");
  for (let i = 0; i < 2; i++) {
    assert.equal(
      await new Promise<number | null>((resolve, reject) => {
        void runner.runInstaller(key, installer, resolve).catch(reject);
      }),
      0
    );
  }
  const commands = (
    await fs.readFile(path.join(home, "commands.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.filter((args) => args[0] === "tricks"),
    [["tricks", runtime.highballBottleName(key), "mfc42"]]
  );
});

test("only the game's tracked executable counts after a restart during installation", async (t) => {
  const { runner } = await fixture(t);
  const key = "steam:12210";
  const { prefix } = await runner.prepareDownload(key);
  const processes = [{ winePrefixPath: prefix }];
  const tracked = [
    path.join(prefix, "drive_c/Games/GTAIV.exe"),
    path.join(prefix, "drive_c/Games/LaunchGTAIV.exe"),
  ];
  for (const program of ["setup.exe", "setup.tmp", "cls-lolz_x64.exe"]) {
    await fs.writeFile(path.join(prefix, "running"), program);
    assert.equal(
      await runner.isRunning(key, processes, tracked),
      false,
      program
    );
  }
  for (const program of ["gtaiv.exe", "LaunchGTAIV.exe"]) {
    await fs.writeFile(path.join(prefix, "running"), program);
    assert.equal(
      await runner.isRunning(key, processes, tracked),
      true,
      program
    );
  }
});
