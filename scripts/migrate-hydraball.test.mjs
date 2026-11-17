import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ClassicLevel } from "classic-level";
import { v5 as uuid } from "uuid";
import {
  prepareMigration,
  applyMigration,
  rollbackMigration,
} from "./migrate-hydraball.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydraball-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "highhydra");
  const highball = path.join(root, "Highball");
  const work = path.join(root, "migration");
  const suffix = createHash("sha256")
    .update("steam:10")
    .digest("hex")
    .slice(0, 24);
  const oldName = `HighHydra-${suffix}`;
  const newName = `Hydraball-${suffix}`;
  const prefix = path.join(highball, "bottles", oldName);
  const target = path.join(highball, "bottles", newName);
  const pinId = uuid("highhydra:steam:10", uuid.URL).toUpperCase();
  const exe = path.join(prefix, "drive_c/Games/Game.exe");
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, "game and saves stay here");
  await fs.symlink(exe, path.join(prefix, "game-link"));
  await fs.writeFile(
    path.join(prefix, "bottle.json"),
    JSON.stringify({
      name: oldName,
      renderer: "dxmt",
      pins: [
        {
          id: pinId,
          name: "Custom title",
          path: "Games/Game.exe",
          arguments: ["--custom"],
          environment: { TEST: "preserved" },
        },
      ],
      futureSetting: true,
    })
  );
  await fs.writeFile(path.join(prefix, "user.reg"), `saved-path=${exe}`);
  await fs.writeFile(
    path.join(highball, "library.json"),
    JSON.stringify({
      items: {
        [`pin:${oldName}:${pinId}`]: {
          bottle: oldName,
          lastPlayedAt: "2026-11-17",
        },
        unrelated: { bottle: "Steam" },
      },
    })
  );
  await fs.mkdir(profile);
  await fs.writeFile(
    path.join(profile, "Preferences"),
    JSON.stringify({ downloads: `${profile}/Assets` })
  );
  const db = new ClassicLevel(path.join(profile, "hydra-db"), {
    valueEncoding: "buffer",
  });
  await db.batch([
    {
      type: "put",
      key: "!games!steam:10",
      value: Buffer.from(
        JSON.stringify({
          shop: "steam",
          objectId: "10",
          executablePath: exe,
          winePrefixPath: prefix,
          trackingExecutablePaths: [exe],
          isDeleted: false,
        })
      ),
    },
    {
      type: "put",
      key: "!downloads!steam:10",
      value: Buffer.from(
        JSON.stringify({ downloadPath: `${prefix}/drive_c/Games/Downloads` })
      ),
    },
    {
      type: "put",
      key: "auth",
      value: Buffer.from('{"token":"must remain byte identical"}  '),
    },
    { type: "put", key: "language", value: Buffer.from("en-GB") },
  ]);
  await db.close();
  return {
    root,
    profile,
    highball,
    work,
    prefix,
    target,
    pinId,
    newName,
    newProfile: path.join(root, "hydraball"),
  };
}

test("migration preserves UUIDs, saves, opaque profile records and unrelated Highball settings", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareMigration(f.profile, f.highball, f.work);
  assert.equal(prepared.retainedPins[0].pinId, f.pinId);
  assert.equal(
    await fs.readFile(path.join(f.prefix, "drive_c/Games/Game.exe"), "utf8"),
    "game and saves stay here"
  );
  await applyMigration(f.work);
  const db = new ClassicLevel(path.join(f.newProfile, "hydra-db"), {
    valueEncoding: "buffer",
  });
  try {
    const game = JSON.parse(await db.get("!games!steam:10"));
    assert.equal(game.highballPinId, f.pinId);
    assert.equal(game.winePrefixPath, f.target);
    assert.equal(
      game.executablePath,
      path.join(f.target, "drive_c/Games/Game.exe")
    );
    assert.deepEqual(game.trackingExecutablePaths, [game.executablePath]);
    assert.equal(
      (await db.get("auth")).toString(),
      '{"token":"must remain byte identical"}  '
    );
    assert.equal((await db.get("language")).toString(), "en-GB");
    assert.equal(
      JSON.parse(await db.get("!downloads!steam:10")).downloadPath,
      `${f.target}/drive_c/Games/Downloads`
    );
  } finally {
    await db.close();
  }
  const settings = JSON.parse(
    await fs.readFile(path.join(f.target, "bottle.json"))
  );
  assert.equal(settings.name, f.newName);
  assert.equal(settings.pins[0].id, f.pinId);
  assert.deepEqual(settings.pins[0].arguments, ["--custom"]);
  assert.equal(settings.futureSetting, true);
  assert.equal(
    await fs.readFile(path.join(f.target, "drive_c/Games/Game.exe"), "utf8"),
    "game and saves stay here"
  );
  assert.equal(
    await fs.readlink(path.join(f.target, "game-link")),
    path.join(f.target, "drive_c/Games/Game.exe")
  );
  const library = JSON.parse(
    await fs.readFile(path.join(f.highball, "library.json"))
  );
  assert.equal(library.items[`pin:${f.newName}:${f.pinId}`].bottle, f.newName);
  assert.equal(library.items.unrelated.bottle, "Steam");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.newProfile, "Preferences")))
      .downloads,
    `${f.newProfile}/Assets`
  );
  assert.equal((await applyMigration(f.work)).state, "complete");
  assert.equal(
    (await prepareMigration(f.profile, f.highball, f.work)).state,
    "complete"
  );
  assert.equal((await fs.readdir(path.join(f.highball, "bottles"))).length, 1);
});

test("existing target bottle and profile are rejected before modifying source data", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.target);
  await assert.rejects(
    prepareMigration(f.profile, f.highball, f.work),
    /Target bottle exists/
  );
  await fs.rmdir(f.target);
  await fs.mkdir(f.newProfile);
  await assert.rejects(
    prepareMigration(f.profile, f.highball, f.work),
    /Target profile exists/
  );
  assert.equal((await fs.stat(f.profile)).isDirectory(), true);
  assert.equal((await fs.stat(f.prefix)).isDirectory(), true);
});

test("resume handles a crash after rename but before the journal was updated", async (t) => {
  const f = await fixture(t);
  await prepareMigration(f.profile, f.highball, f.work);
  await fs.rename(f.prefix, f.target);
  assert.equal((await applyMigration(f.work)).state, "complete");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.target, "bottle.json"))).name,
    f.newName
  );
});

test("rollback handles partial and completed migrations without losing the original profile", async (t) => {
  for (const complete of [false, true]) {
    const f = await fixture(t);
    await prepareMigration(f.profile, f.highball, f.work);
    if (complete) await applyMigration(f.work);
    else await fs.rename(f.prefix, f.target);
    assert.equal((await rollbackMigration(f.work)).state, "rolled-back");
    assert.equal((await fs.stat(f.profile)).isDirectory(), true);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.prefix, "bottle.json"))).name,
      path.basename(f.prefix)
    );
    assert.equal(
      await fs.readlink(path.join(f.prefix, "game-link")),
      path.join(f.prefix, "drive_c/Games/Game.exe")
    );
    const library = JSON.parse(
      await fs.readFile(path.join(f.highball, "library.json"))
    );
    assert.ok(library.items[`pin:${path.basename(f.prefix)}:${f.pinId}`]);
    assert.equal((await rollbackMigration(f.work)).state, "rolled-back");
  }
});

test("a concurrent metadata edit is preserved and stops migration", async (t) => {
  const f = await fixture(t);
  await prepareMigration(f.profile, f.highball, f.work);
  const file = path.join(f.prefix, "bottle.json");
  const before = await fs.readFile(file);
  const changed = JSON.parse(before);
  changed.renderer = "user-choice";
  await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(
    applyMigration(f.work),
    /File changed outside migration/
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.target, "bottle.json"))).renderer,
    "user-choice"
  );
  await fs.writeFile(path.join(f.target, "bottle.json"), before);
  await rollbackMigration(f.work);
  assert.equal((await fs.stat(f.profile)).isDirectory(), true);
});
