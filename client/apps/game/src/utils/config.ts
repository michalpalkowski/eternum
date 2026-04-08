import { Chain, GameType, getConfigFromNetwork } from "@config";
import { env } from "./../../env";

type ConfigResolutionOptions = {
  chain?: Chain;
  gameType?: GameType;
  components?: unknown;
};

export const ETERNUM_CONFIG = (options: ConfigResolutionOptions = {}) => {
  const chain = options.chain ?? (env.VITE_PUBLIC_CHAIN as Chain);
  const gameType = options.gameType ?? ((env.VITE_PUBLIC_GAME_TYPE as GameType) || "eternum");
  return getConfigFromNetwork(chain, gameType);
};

export const TORII_SETTING = async (): Promise<string> => {
  return env.VITE_PUBLIC_TORII;
};
