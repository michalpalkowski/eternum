import { useEffect } from "react";

import { useAccountStore } from "@/hooks/store/use-account-store";
import { useShardStore } from "@/hooks/store/use-shard-store";
import { useAccount } from "@starknet-react/core";
import { Account, AccountInterface, RpcProvider } from "starknet";
import { isSessionPolicyRefreshInProgress } from "./session-policy-refresh";
import { getControllerConnector } from "./starknet-provider";
import { env } from "../../../env";

export const useControllerAccount = () => {
  const { account, connector, isConnected } = useAccount();
  const storedAccount = useAccountStore((state) => state.account);
  const setAccount = useAccountStore((state) => state.setAccount);
  const setConnector = useAccountStore((state) => state.setConnector);
  const isShardMode = useShardStore((state) => state.isShardMode);
  const shardRpcUrl = useShardStore((state) => state.shardRpcUrl);

  // Effect 1: In shard mode, create a direct Account pointing to shard Katana.
  // Uses MASTER_ADDRESS / MASTER_PRIVATE_KEY from env — the same credentials
  // used by the deployer connector. This bypasses the Controller's keychain
  // entirely: no iframes, no Penpal, no CORS, no timing issues.
  // Same approach as local-dev (pre-deployed accounts with known keys).
  useEffect(() => {
    if (!isShardMode || !shardRpcUrl) {
      return;
    }

    const address = env.VITE_PUBLIC_MASTER_ADDRESS;
    const privateKey = env.VITE_PUBLIC_MASTER_PRIVATE_KEY;

    const shardProvider = new RpcProvider({ nodeUrl: shardRpcUrl });
    const shardAccount = new Account({ provider: shardProvider, address, signer: privateKey });

    setAccount(shardAccount);
    console.log("[shard-direct] Account bound to shard", { shardRpcUrl, address });
  }, [isShardMode, setAccount, shardRpcUrl]);

  // Effect 2: Normal mode — keep account store in sync with connector/account.
  // Also captures the player's original address so it survives shard mode override.
  const setPlayerAddress = useAccountStore((state) => state.setPlayerAddress);
  useEffect(() => {
    if (isShardMode) return;

    if (account) {
      setAccount(account as AccountInterface);
      if ("address" in account && typeof account.address === "string") {
        setPlayerAddress(account.address);
      }
      return;
    }

    const controller = getControllerConnector()?.controller;
    if (controller?.account) {
      setAccount(controller.account as AccountInterface);
      if ("address" in controller.account && typeof controller.account.address === "string") {
        setPlayerAddress(controller.account.address);
      }
    } else if (!isConnected) {
      if (isSessionPolicyRefreshInProgress()) return;
      setAccount(null);
    }
  }, [account, connector, isConnected, isShardMode, setAccount, setPlayerAddress]);

  useEffect(() => {
    setConnector(getControllerConnector());
  }, [connector, isConnected, setConnector]);

  return storedAccount ?? account ?? getControllerConnector()?.controller?.account ?? null;
};
