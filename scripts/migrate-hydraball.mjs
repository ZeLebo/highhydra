import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { ClassicLevel } from "classic-level";
import { v5 as uuid } from "uuid";

const exists = async (file) =>
  fs.lstat(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  );
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const atomicWrite = async (file, data) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
};
const save = (file, value) =>
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Explicit local migration, run only with both launchers and their games closed.
export async function prepareMigration(
  oldProfile,
  highballHome,
  workDirectory
) {
  const journalFile = path.join(workDirectory, "journal.json");
  if (await exists(journalFile)) return readJson(journalFile);
  const newProfile = path.join(path.dirname(oldProfile), "hydraball");
  if (await exists(newProfile))
    throw new Error(`Target profile exists: ${newProfile}`);
  if (!(await exists(path.join(oldProfile, "hydra-db"))))
    throw new Error("Source profile database is missing");
  const bottleRoot = path.join(highballHome, "bottles");
  const bottles = [];
  for (const entry of await fs.readdir(bottleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^HighHydra-[a-f0-9]{24}$/.test(entry.name))
      continue;
    const from = path.join(bottleRoot, entry.name);
    const to = path.join(
      bottleRoot,
      entry.name.replace("HighHydra-", "Hydraball-")
    );
    if (await exists(to)) throw new Error(`Target bottle exists: ${to}`);
    const settings = await readJson(path.join(from, "bottle.json"));
    if (settings.name !== entry.name || !Array.isArray(settings.pins))
      throw new Error(`Invalid bottle: ${from}`);
    bottles.push({ from, to, settings });
  }
  const mappings = [
    [oldProfile, newProfile],
    ...bottles.map(({ from, to }) => [path.basename(from), path.basename(to)]),
  ];
  const rewriteString = (value) =>
    mappings.reduce(
      (text, [from, to]) =>
        text.replace(
          new RegExp(`${escape(from)}(?=$|[/\\\\:])`, "g"),
          () => to
        ),
      value
    );
  const rewrite = (value) => {
    if (typeof value === "string") return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          rewriteString(key),
          rewrite(item),
        ])
      );
    return value;
  };
  await fs.mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const stagedProfile = path.join(workDirectory, "profile-prepared");
  if (await exists(stagedProfile))
    throw new Error(
      "Unfinished preparation exists; inspect or move it before retrying"
    );
  await promisify(execFile)("cp", ["-cRp", oldProfile, stagedProfile]);
  const db = new ClassicLevel(path.join(stagedProfile, "hydra-db"), {
    valueEncoding: "buffer",
  });
  const changes = [];
  const retainedPins = [];
  await db.open();
  try {
    for await (const [key, raw] of db.iterator()) {
      let value;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        continue;
      }
      const before = JSON.stringify(value);
      if (key.startsWith("!games!")) {
        const gameKey = `${value.shop}:${value.objectId}`;
        const suffix = createHash("sha256")
          .update(gameKey)
          .digest("hex")
          .slice(0, 24);
        const bottle = bottles.find(
          ({ from }) => path.basename(from) === `HighHydra-${suffix}`
        );
        if (bottle) {
          const legacyId = uuid(`highhydra:${gameKey}`, uuid.URL);
          const pin = bottle.settings.pins.find(
            (item) => item.id.toLowerCase() === legacyId
          );
          if (pin) {
            value.highballPinId = pin.id;
            retainedPins.push({ gameKey, pinId: pin.id });
          } else if (value.executablePath) {
            throw new Error(
              `Existing executable has no matching managed pin: ${gameKey}`
            );
          }
        }
      }
      const changed = rewrite(value);
      const targetKey = rewriteString(key);
      if (targetKey !== key) {
        if (
          await db.get(targetKey).then(
            () => true,
            (error) => {
              if (error.code === "LEVEL_NOT_FOUND") return false;
              throw error;
            }
          )
        )
          throw new Error(`Database key collision: ${targetKey}`);
        changes.push({ type: "del", key });
      }
      if (targetKey !== key || JSON.stringify(changed) !== before)
        changes.push({
          type: "put",
          key: targetKey,
          value: Buffer.from(JSON.stringify(changed)),
        });
    }
    await db.batch(changes);
  } finally {
    await db.close();
  }
  const operations = [];
  const addRewrite = async (source, target = source) => {
    const before = await fs.readFile(source);
    let value;
    try {
      value = JSON.parse(before.toString());
    } catch {
      return;
    }
    const changed = rewrite(value);
    if (JSON.stringify(changed) === JSON.stringify(value)) return;
    operations.push({
      kind: "file",
      file: target,
      before: before.toString("base64"),
      after: Buffer.from(JSON.stringify(changed, null, 2) + "\n").toString(
        "base64"
      ),
    });
  };
  for (const { from, to } of bottles) {
    operations.push({ kind: "rename", from, to });
    await addRewrite(
      path.join(from, "bottle.json"),
      path.join(to, "bottle.json")
    );
    for (const entry of await fs.readdir(from)) {
      if (!entry.endsWith(".reg")) continue;
      const before = await fs.readFile(path.join(from, entry), "utf8");
      const after = rewriteString(before);
      if (before !== after)
        operations.push({
          kind: "file",
          file: path.join(to, entry),
          before: Buffer.from(before).toString("base64"),
          after: Buffer.from(after).toString("base64"),
        });
    }
    const scanLinks = async (directory) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scanLinks(file);
        else if (entry.isSymbolicLink()) {
          const before = await fs.readlink(file);
          const after = rewriteString(before);
          if (before !== after)
            operations.push({
              kind: "symlink",
              file: path.join(to, path.relative(from, file)),
              before,
              after,
            });
        }
      }
    };
    await scanLinks(from);
  }
  for (const name of ["library.json", "running.json", "config.json"]) {
    const file = path.join(highballHome, name);
    if (await exists(file)) await addRewrite(file);
  }
  for (const entry of await fs.readdir(stagedProfile, {
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(stagedProfile, entry.name);
    const before = await fs.readFile(file);
    let value;
    try {
      value = JSON.parse(before.toString());
    } catch {
      continue;
    }
    const after = rewrite(value);
    if (JSON.stringify(value) !== JSON.stringify(after))
      await fs.writeFile(file, JSON.stringify(after));
  }
  operations.push({
    kind: "rename",
    from: oldProfile,
    to: path.join(workDirectory, "profile-retired"),
  });
  operations.push({ kind: "rename", from: stagedProfile, to: newProfile });
  const journal = {
    state: "prepared",
    oldProfile,
    newProfile,
    highballHome,
    changedRecords: changes.filter((item) => item.type === "put").length,
    retainedPins,
    operations,
  };
  await save(journalFile, journal);
  return journal;
}

async function perform(operation, reverse) {
  if (operation.kind === "rename") {
    const from = reverse ? operation.to : operation.from;
    const to = reverse ? operation.from : operation.to;
    const sourceExists = await exists(from);
    const targetExists = await exists(to);
    if (sourceExists && targetExists)
      throw new Error(`Rename target exists: ${to}`);
    if (!sourceExists && targetExists) return;
    if (!sourceExists)
      throw new Error(`Both rename paths are missing: ${from}`);
    await fs.rename(from, to);
    return;
  }
  const before = reverse ? operation.after : operation.before;
  const after = reverse ? operation.before : operation.after;
  const current =
    operation.kind === "symlink"
      ? await fs.readlink(operation.file)
      : (await fs.readFile(operation.file)).toString("base64");
  if (current === after) return;
  if (current !== before)
    throw new Error(`File changed outside migration: ${operation.file}`);
  if (operation.kind === "symlink") {
    const temporary = `${operation.file}.${randomUUID()}.tmp`;
    await fs.symlink(after, temporary);
    await fs.rename(temporary, operation.file);
  } else await atomicWrite(operation.file, Buffer.from(after, "base64"));
}

export async function applyMigration(workDirectory) {
  const file = path.join(workDirectory, "journal.json");
  const journal = await readJson(file);
  if (journal.state === "complete") return journal;
  if (journal.state === "rolled-back")
    throw new Error("Migration was rolled back; prepare a new work directory");
  for (const operation of journal.operations) {
    if (operation.done) continue;
    await perform(operation, false);
    operation.done = true;
    await save(file, journal);
  }
  journal.state = "complete";
  await save(file, journal);
  return journal;
}

export async function rollbackMigration(workDirectory) {
  const file = path.join(workDirectory, "journal.json");
  const journal = await readJson(file);
  if (journal.state === "rolled-back") return journal;
  // Include the first unrecorded operation: a crash may follow its filesystem change.
  const pending = journal.operations.findIndex((operation) => !operation.done);
  const affected =
    pending === -1
      ? journal.operations
      : journal.operations.slice(0, pending + 1);
  for (const operation of affected.toReversed()) {
    if (operation.rolledBack) continue;
    await perform(operation, true);
    operation.rolledBack = true;
    await save(file, journal);
  }
  journal.state = "rolled-back";
  await save(file, journal);
  return journal;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [mode, ...args] = process.argv.slice(2);
  let result;
  if (mode === "prepare" && args.length === 3)
    result = await prepareMigration(...args.map((arg) => path.resolve(arg)));
  else if (mode === "apply" && args.length === 1)
    result = await applyMigration(path.resolve(args[0]));
  else if (mode === "rollback" && args.length === 1)
    result = await rollbackMigration(path.resolve(args[0]));
  else
    throw new Error(
      "Usage: migrate-hydraball.mjs prepare <old-profile> <highball-home> <work-dir> | apply <work-dir> | rollback <work-dir>"
    );
  console.log(
    JSON.stringify({
      state: result.state,
      changedRecords: result.changedRecords,
      retainedPins: result.retainedPins.length,
      operations: result.operations.length,
    })
  );
}
