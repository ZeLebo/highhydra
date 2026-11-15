import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { v5 as uuid } from "uuid";
import { resolveLaunchCommand } from "../helpers/resolve-launch-command";

const execFileAsync = promisify(execFile);

export interface HighballGame {
  shop: string;
  objectId: string;
  title: string;
  executablePath?: string | null;
  launchOptions?: string | null;
  artworkTall?: string | null;
  artworkWide?: string | null;
}

interface Pin {
  id: string;
  name: string;
  path: string;
  arguments: string[];
  environment: Record<string, string>;
  [key: string]: unknown;
}

export class HighballError extends Error {}

export const highballGameKey = (
  game: Pick<HighballGame, "shop" | "objectId">
) => `${game.shop}:${game.objectId}`;

export const highballBottleName = (gameKey: string) =>
  `HighHydra-${createHash("sha256").update(gameKey).digest("hex").slice(0, 24)}`;

export class HighballRunner {
  private readonly preparing = new Map<string, Promise<string>>();
  private readonly sessions = new Map<string, ChildProcess>();
  private readonly installers = new Set<string>();
  private readonly stopping = new Set<string>();

  constructor(
    public readonly cliPath: string,
    public readonly home: string
  ) {}

  private async command(args: string[], timeout = 180_000) {
    try {
      return await execFileAsync(this.cliPath, args, {
        env: { ...process.env, HIGHBALL_HOME: this.home },
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { stderr?: string; stdout?: string };
      throw new HighballError(
        failure.stderr?.trim() || failure.stdout?.trim() || failure.message
      );
    }
  }

  bottlePath(gameKey: string) {
    return path.join(this.home, "bottles", highballBottleName(gameKey));
  }

  async ensureBottle(gameKey: string): Promise<string> {
    const pending = this.preparing.get(gameKey);
    if (pending) return pending;
    const preparation = (async () => {
      const prefix = this.bottlePath(gameKey);
      const exists = await fs.lstat(prefix).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      if (!exists)
        await this.command(["bottle", "create", highballBottleName(gameKey)]);
      const settings = JSON.parse(
        await fs.readFile(path.join(prefix, "bottle.json"), "utf8")
      );
      if (
        settings.name !== highballBottleName(gameKey) ||
        !Array.isArray(settings.pins)
      ) {
        throw new HighballError(
          "The game's Highball bottle is invalid. Repair it in Highball."
        );
      }
      await fs.access(
        path.join(prefix, "drive_c"),
        constants.R_OK | constants.W_OK
      );
      return fs.realpath(prefix);
    })();
    this.preparing.set(gameKey, preparation);
    try {
      return await preparation;
    } finally {
      this.preparing.delete(gameKey);
    }
  }

  async prepareDownload(gameKey: string) {
    const prefix = await this.ensureBottle(gameKey);
    const downloadPath = path.join(prefix, "drive_c", "Games", "Downloads");
    await fs.mkdir(downloadPath, { recursive: true });
    return { prefix, downloadPath };
  }

  async registerGame(game: HighballGame) {
    if (!game.executablePath)
      throw new HighballError("Select the game's Windows executable first.");
    const gameKey = highballGameKey(game);
    const prefix = await this.ensureBottle(gameKey);
    const driveC = await fs.realpath(path.join(prefix, "drive_c"));
    const executable = await fs.realpath(game.executablePath);
    const relative = path.relative(driveC, executable);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new HighballError(
        "The game executable must be inside its own Highball bottle."
      );
    }
    const file = path.join(prefix, "bottle.json");
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    const id = uuid(`highhydra:${gameKey}`, uuid.URL);
    const existing = settings.pins.find(
      (pin: Pin) => pin.id.toLowerCase() === id
    );
    const pin: Pin = {
      ...existing,
      id,
      name: existing?.name ?? game.title,
      path: relative.split(path.sep).join("/"),
      arguments: existing?.arguments ?? [],
      environment: existing?.environment ?? {},
    };
    if (game.artworkTall) pin.artworkTall = game.artworkTall;
    if (game.artworkWide) pin.artworkWide = game.artworkWide;
    if (game.launchOptions !== null && game.launchOptions !== undefined) {
      const command = resolveLaunchCommand({
        baseCommand: executable,
        launchOptions: game.launchOptions,
      });
      if (
        command.command !== executable ||
        "WINEPREFIX" in command.env ||
        "HIGHBALL_HOME" in command.env
      ) {
        throw new HighballError(
          "Use game arguments and environment variables without replacing the game command or bottle."
        );
      }
      pin.arguments = command.args;
      pin.environment = { ...pin.environment, ...command.env };
    }
    if (
      settings.pins.some(
        (entry: Pin) =>
          entry.id.toLowerCase() !== id &&
          entry.name.toLowerCase() === pin.name.toLowerCase()
      )
    ) {
      throw new HighballError(
        "Another Highball shortcut already has this name. Rename it in Highball first."
      );
    }
    // bottle.json is Highball's shared Pin contract; preserve every other setting.
    if (JSON.stringify(existing) !== JSON.stringify(pin)) {
      settings.pins = settings.pins.filter(
        (entry: Pin) => entry.id.toLowerCase() !== id
      );
      settings.pins.push(pin);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(
          temporary,
          JSON.stringify(settings, null, 2) + "\n",
          { mode: 0o600, flag: "wx" }
        );
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    return { prefix, pinId: id, pinName: pin.name };
  }

  private async start(
    gameKey: string,
    program: string,
    onExit: (code: number | null, output: string) => void
  ) {
    const child = spawn(
      this.cliPath,
      ["run", highballBottleName(gameKey), program],
      {
        env: { ...process.env, HIGHBALL_HOME: this.home },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("close", (code) => onExit(code, output));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }

  async launch(game: HighballGame, onError: (error: Error) => void) {
    const key = highballGameKey(game);
    if (this.sessions.has(key)) return this.sessions.get(key)!.pid ?? null;
    const { pinName } = await this.registerGame(game);
    const child = await this.start(key, pinName, (code, output) => {
      this.sessions.delete(key);
      if (code !== 0 && !this.stopping.has(key))
        onError(
          new HighballError(output || `Highball exited with code ${code}`)
        );
      this.stopping.delete(key);
    });
    this.sessions.set(key, child);
    return child.pid ?? null;
  }

  async runInstaller(
    gameKey: string,
    installer: string,
    onExit: (code: number | null) => void
  ) {
    const prefix = await this.ensureBottle(gameKey);
    const target = await fs.realpath(installer);
    if (!target.startsWith(path.join(prefix, "drive_c") + path.sep)) {
      throw new HighballError("The installer must be in this game's bottle.");
    }
    this.installers.add(gameKey);
    try {
      const runtime = path.join(
        prefix,
        "drive_c",
        "windows",
        "syswow64",
        "mfc42u.dll"
      );
      const installed = await fs.access(runtime).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      if (!installed) {
        await this.command(
          ["tricks", highballBottleName(gameKey), "mfc42"],
          600_000
        );
        await fs.access(runtime);
      }
      await this.start(gameKey, target, (code) => {
        this.installers.delete(gameKey);
        onExit(code);
      });
    } catch (error) {
      this.installers.delete(gameKey);
      throw error;
    }
  }

  async isRunning(
    gameKey: string,
    processes: ReadonlyArray<{ winePrefixPath?: string | null }>,
    executablePaths: readonly string[]
  ) {
    if (this.installers.has(gameKey)) return false;
    const prefix = this.bottlePath(gameKey);
    const possible =
      this.sessions.has(gameKey) ||
      processes.some(
        (entry) =>
          entry.winePrefixPath && path.resolve(entry.winePrefixPath) === prefix
      );
    if (!possible) return false;
    const { stdout } = await this.command(
      ["bottle", "ps", highballBottleName(gameKey)],
      15_000
    );
    const trackedNames = new Set(
      executablePaths.map((file) => path.win32.basename(file).toLowerCase())
    );
    return stdout.split("\n").some((line) => {
      const [pid, kind, executable] = line.split("\t");
      return (
        /^\d+$/.test(pid) &&
        kind === "program" &&
        trackedNames.has(path.win32.basename(executable ?? "").toLowerCase())
      );
    });
  }

  async stop(gameKey: string) {
    this.stopping.add(gameKey);
    try {
      await this.command(
        ["bottle", "kill", highballBottleName(gameKey)],
        30_000
      );
    } finally {
      if (!this.sessions.has(gameKey)) this.stopping.delete(gameKey);
    }
  }
}

let runner: HighballRunner | undefined;
export async function getHighballRunner() {
  if (runner) return runner;
  const applications = [
    path.join(os.homedir(), "Applications", "Games", "Highball.app"),
    path.join(os.homedir(), "Applications", "Highball.app"),
    "/Applications/Highball.app",
    "/Applications/GAMES/Highball.app",
  ];
  let cli: string | undefined;
  for (const application of applications) {
    const candidate = path.join(application, "Contents", "Helpers", "highball");
    try {
      await fs.access(candidate, constants.X_OK);
      cli = candidate;
      break;
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      )
        throw error;
    }
  }
  if (!cli)
    throw new HighballError(
      "Install Highball with its command-line helper before downloading or launching Windows games."
    );
  const defaultHome = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Highball"
  );
  let home = process.env.HIGHBALL_HOME;
  if (!home) {
    try {
      const config = JSON.parse(
        await fs.readFile(path.join(defaultHome, "config.json"), "utf8")
      );
      if (typeof config.home !== "string" || !config.home)
        throw new HighballError("Highball's data location is invalid.");
      home = config.home;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  home = await fs.realpath(home ?? defaultHome);
  runner = new HighballRunner(cli, home);
  return runner;
}
