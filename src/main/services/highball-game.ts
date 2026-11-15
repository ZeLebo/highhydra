import type { Game } from "@types";
import { getGameAssets } from "@main/events/catalogue/get-game-assets";
import { logger } from "./logger";
import type { HighballGame } from "./highball-runner";

export const resolveHighballGame = async (
  game: Game
): Promise<HighballGame> => {
  const assets = await getGameAssets(game.objectId, game.shop).catch(
    (error) => {
      logger.warn("Could not read optional Highball artwork", error);
      return null;
    }
  );
  return {
    ...game,
    artworkTall:
      game.customCoverImageUrl ??
      assets?.libraryImageUrl ??
      assets?.coverImageUrl,
    artworkWide:
      game.customHeroImageUrl ??
      assets?.libraryHeroImageUrl ??
      game.libraryHeroImageUrl,
  };
};
