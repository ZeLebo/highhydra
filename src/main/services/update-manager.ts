export class UpdateManager {
  public static async checkForUpdates(): Promise<boolean> {
    // Local Hydraball builds have no release feed of their own yet.
    return false;
  }
}
