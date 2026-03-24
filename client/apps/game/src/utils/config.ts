import { Chain, getConfigFromNetwork } from "@config";
import { env } from "./../../env";

export const ETERNUM_CONFIG = () => {
  const config = getConfigFromNetwork(env.VITE_PUBLIC_CHAIN! as Chain);
  return config;
};

export const TORII_SETTING = async (): Promise<string> => {
  return env.VITE_PUBLIC_TORII;
};
