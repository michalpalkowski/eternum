import { getActiveWorld, normalizeRpcUrl } from "@/runtime/world";
import { ControllerConnector } from "@cartridge/connector";
import { PredeployedAccountsConnector } from "@dojoengine/predeployed-connector";
import { usePredeployedAccounts } from "@dojoengine/predeployed-connector/react";
import { Chain, getSlotChain, mainnet, sepolia } from "@starknet-react/chains";
import { Connector, StarknetConfig, jsonRpcProvider, paymasterRpcProvider, voyager } from "@starknet-react/core";
import { QueryClient } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Account, constants, ETransactionVersion, RpcProvider, shortString, WalletAccount } from "starknet";
import { dojoConfig } from "../../../dojo-config";
import { env } from "../../../env";
import { parseShardUrlParams } from "@/sharding/protocol";
import { bootstrapGame } from "../../init/bootstrap";
import { useAccountStore } from "../store/use-account-store";
import { useShardStore } from "../store/use-shard-store";
import { useControllerAccount } from "./use-controller-account";
import { useShardHealthGuard } from "./use-shard-health-guard";

const slot: string = env.VITE_PUBLIC_SLOT;
const namespace: string = "s1_eternum";

// ==============================================

const KATANA_CHAIN_ID = shortString.encodeShortString("KATANA");
const KATANA_CHAIN_NETWORK = "Katana Local";
const KATANA_CHAIN_NAME = "katana";
const KATANA_RPC_URL = "http://localhost:5050";
const isLocal = env.VITE_PUBLIC_CHAIN === "local";

// ==============================================

const SLOT_CHAIN_ID = "0x57505f455445524e554d5f424c49545a5f534c4f545f33";

const SLOT_CHAIN_ID_TEST = "0x57505f455445524e554d5f424c49545a5f534c4f545f54455354";

const isSlot = env.VITE_PUBLIC_CHAIN === "slot";
const isSlottest = env.VITE_PUBLIC_CHAIN === "slottest";

// ==============================================

type DerivedChain = {
  kind: "slot" | "mainnet" | "sepolia";
  chainId: string;
};

const deriveChainFromRpcUrl = (value: string): DerivedChain | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const path = url.pathname;
    const lowerPath = path.toLowerCase();

    if (lowerPath.includes("/starknet/mainnet")) {
      return { kind: "mainnet", chainId: constants.StarknetChainId.SN_MAIN };
    }

    if (lowerPath.includes("/starknet/sepolia")) {
      return { kind: "sepolia", chainId: constants.StarknetChainId.SN_SEPOLIA };
    }

    const match = path.match(/\/x\/([^/]+)\/katana/i);
    if (!match) return null;

    const slug = match[1];
    const label = `WP_${slug.replace(/-/g, "_").toUpperCase()}`;
    if (label.length > 31) return null;

    return { kind: "slot", chainId: shortString.encodeShortString(label) };
  } catch {
    return null;
  }
};

/**
 * Resolve the "main chain" RPC URL — the one used for wallet/controller setup.
 * In shard mode, the active RPC points to shard Katana which the ControllerConnector
 * doesn't recognize. The main chain RPC (VITE_PUBLIC_NODE_URL) is always valid.
 */
const resolveMainChainRpcUrl = (): string => {
  return normalizeRpcUrl(env.VITE_PUBLIC_NODE_URL);
};

/**
 * Module-level reference to the raw ControllerConnector instance.
 * starknet-react wraps connectors in its own Connector type, stripping the
 * `.controller` property. This lets use-controller-account.ts access the
 * real instance for switchRpc() without depending on starknet-react internals.
 */
let _controllerConnectorRef: InstanceType<typeof ControllerConnector> | null = null;

/** Get the raw ControllerConnector (not the starknet-react wrapper). */
export const getControllerConnector = (): InstanceType<typeof ControllerConnector> | null => _controllerConnectorRef;

const cartridgeApiBase = env.VITE_PUBLIC_CARTRIDGE_API_BASE || "https://api.cartridge.gg";
const createControllerConnector = (resolvedChainId: string) => {
  // Controller chain list: only stable, well-known main-chain RPC URLs.
  // Shard Katana URLs are NOT registered as chains — they use switchRpc()
  // which bypasses chain validation entirely (see shard-write-protocol.ts).
  const mainChainRpcUrl = resolveMainChainRpcUrl();
  const controllerSupportedRpcUrls = Array.from(
    new Set(
      [
        mainChainRpcUrl,
        `${cartridgeApiBase}/x/eternum-blitz-slot-4/katana/rpc/v0_9`,
        `${cartridgeApiBase}/x/starknet/sepolia/rpc/v0_9`,
        `${cartridgeApiBase}/x/starknet/mainnet/rpc/v0_9`,
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => normalizeRpcUrl(value)),
    ),
  );

  return new ControllerConnector({
    errorDisplayMode: "notification",
    propagateSessionErrors: true,
    chains: controllerSupportedRpcUrls.map((chainRpcUrl) => ({
      rpcUrl: chainRpcUrl,
    })),
    defaultChainId: resolvedChainId,
    // Policies are intentionally omitted here so that login/connect does NOT
    // create a session upfront. Session policies are set later by
    // refreshSessionPolicies() after the player selects a game and
    // bootstrapGame() patches the manifest with the correct contract addresses.
    // policies: buildPolicies(dojoConfig.manifest),
    slot,
    namespace,
  });
};

const katanaLocalChain = {
  id: BigInt(KATANA_CHAIN_ID),
  network: KATANA_CHAIN_NETWORK,
  name: KATANA_CHAIN_NAME,
  nativeCurrency: {
    address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [KATANA_RPC_URL],
    },
    public: {
      http: [KATANA_RPC_URL],
    },
  },
  paymasterRpcUrls: {
    default: {
      http: [],
    },
    public: {
      http: [],
    },
  },
} as const satisfies Chain;

// Custom QueryClient with game-appropriate defaults
// - Disable refetchOnWindowFocus to prevent surprise refetch storms when alt-tabbing
// - Disable refetchOnReconnect for similar reasons in a real-time game
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      staleTime: 5000, // 5 seconds default stale time
    },
  },
});

const isLocalWorld = import.meta.env.VITE_PUBLIC_LOCAL_WORLD === "true";

/**
 * Create a predeployed-style connector from env MASTER_ADDRESS / MASTER_PRIVATE_KEY.
 * Mirrors the internal pattern of @dojoengine/predeployed-connector but with a
 * hardcoded account instead of querying dev_predeployedAccounts RPC.
 */
const createDeployerConnector = (rpcUrl: string): Connector | null => {
  const address = env.VITE_PUBLIC_MASTER_ADDRESS;
  const privateKey = env.VITE_PUBLIC_MASTER_PRIVATE_KEY;
  if (!address || !privateKey) return null;

  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const account = new Account({
    provider,
    address,
    signer: privateKey,
    cairoVersion: "1",
    transactionVersion: ETransactionVersion.V3,
  });

  // Build a fake wallet provider that delegates to our Account instance.
  // This is what PredeployedAccountsConnector expects internally.
  const fakeWallet: any = {
    request: async (call: any) => {
      switch (call.type) {
        case "wallet_requestAccounts":
          return [address];
        case "wallet_getPermissions":
          return ["accounts"];
        case "wallet_requestChainId":
          return await provider.getChainId();
        case "wallet_addInvokeTransaction":
          return await account.execute(
            call.params.calls.map((c: any) => ({
              contractAddress: c.contract_address,
              entrypoint: c.entry_point,
              calldata: c.calldata,
            })),
          );
        case "wallet_signTypedData":
          return await account.signMessage(call.params);
        case "wallet_supportedSpecs":
          return [];
        case "wallet_supportedWalletApi":
          return [];
        case "wallet_switchStarknetChain":
          return true;
        default:
          throw new Error(`Unsupported wallet call: ${call.type}`);
      }
    },
    on: () => {},
    off: () => {},
    version: "v0.0.1",
    icon: { dark: "", light: "" },
  };

  // Register on window so InjectedConnector can find it.
  if (typeof window !== "undefined") {
    (window as any)["starknet_deployer-0"] = fakeWallet;
  }

  const walletAccount = new WalletAccount({ provider, walletProvider: fakeWallet, address, cairoVersion: "1" });

  return new PredeployedAccountsConnector({
    rpc: rpcUrl,
    id: "deployer-0",
    name: "Deployer",
    account: walletAccount,
  } as any) as unknown as Connector;
};

export function StarknetProvider({ children }: { children: React.ReactNode }) {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const storeShardRpcUrl = useShardStore((state) => state.shardRpcUrl);

  const urlShardRpcUrl = (() => {
    if (typeof window === "undefined") return null;
    try {
      // URL remains the source of truth for shard runtime context.
      const shardSession = parseShardUrlParams(window.location.search);
      return shardSession?.rpcUrl ?? null;
    } catch (error) {
      console.warn("[starknet-provider] Invalid shard session context", error);
      return null;
    }
  })();

  const activeShardRpcUrl = isShardMode ? (storeShardRpcUrl ?? urlShardRpcUrl) : urlShardRpcUrl;

  // RPC URL for data fetching (Torii sync, state reads, etc.).
  // In shard mode this points to shard Katana; otherwise main chain.
  const baseRpcUrl = activeShardRpcUrl ?? (isLocal ? KATANA_RPC_URL : dojoConfig.rpcUrl || env.VITE_PUBLIC_NODE_URL);
  const rpcUrl = normalizeRpcUrl(baseRpcUrl);

  // Chain derivation always uses the main chain RPC, not the shard RPC.
  // Shard Katana URLs (hypervisor proxy) can't be parsed as chain identifiers.
  const mainChainRpc = isLocal ? KATANA_RPC_URL : resolveMainChainRpcUrl();
  const derivedChain = isLocal ? null : deriveChainFromRpcUrl(mainChainRpc);
  const fallbackChain: DerivedChain = isSlot
    ? { kind: "slot", chainId: SLOT_CHAIN_ID }
    : isSlottest
      ? { kind: "slot", chainId: SLOT_CHAIN_ID_TEST }
      : env.VITE_PUBLIC_CHAIN === "mainnet"
        ? { kind: "mainnet", chainId: constants.StarknetChainId.SN_MAIN }
        : { kind: "sepolia", chainId: constants.StarknetChainId.SN_SEPOLIA };
  const resolvedChain = derivedChain ?? fallbackChain;
  const resolvedChainId = isLocal ? KATANA_CHAIN_ID : resolvedChain.chainId;

  const rpc = useCallback(() => {
    return { nodeUrl: rpcUrl };
  }, [rpcUrl]);

  const { connectors: predeployedConnectors } = usePredeployedAccounts({
    rpc: rpcUrl,
    id: "katana",
    name: "Katana",
  });

  const paymasterRpc = useCallback(() => {
    return { nodeUrl: rpcUrl };
  }, [rpcUrl]);

  // Controller connector is stable — always configured with main chain RPC.
  // It never sees shard Katana URLs, preventing "chain not supported" errors.
  const controllerConnector = useMemo(() => {
    if (isLocal) {
      _controllerConnectorRef = null;
      return null;
    }
    const cc = createControllerConnector(resolvedChainId);
    _controllerConnectorRef = cc;
    return cc as unknown as Connector;
  }, [resolvedChainId]);

  // For dev-stack testnet: create a connector from deployer credentials (env vars).
  const deployerConnector = useMemo(() => {
    if (!isLocalWorld || isLocal) return null;
    return createDeployerConnector(rpcUrl);
  }, [rpcUrl]);

  useEffect(() => {
    if (!isLocal || typeof window === "undefined") {
      return;
    }

    const lastUsedConnector = window.localStorage.getItem("lastUsedConnector");
    if (lastUsedConnector?.toLowerCase().includes("controller")) {
      window.localStorage.removeItem("lastUsedConnector");
    }
  }, []);

  return (
    <StarknetConfig
      chains={
        isLocal
          ? [katanaLocalChain]
          : resolvedChain.kind === "slot"
            ? [getSlotChain(resolvedChain.chainId)]
            : resolvedChain.kind === "mainnet"
              ? [mainnet]
              : [sepolia]
      }
      provider={jsonRpcProvider({ rpc })}
      paymasterProvider={isLocal ? paymasterRpcProvider({ rpc: paymasterRpc }) : undefined}
      connectors={
        isLocal
          ? predeployedConnectors
          : isLocalWorld && deployerConnector
            ? [deployerConnector]
            : controllerConnector
              ? [controllerConnector]
              : []
      }
      explorer={voyager}
      autoConnect
      queryClient={queryClient}
    >
      <StarknetAccountSync>{children}</StarknetAccountSync>
    </StarknetConfig>
  );
}

const StarknetAccountSync = ({ children }: { children: React.ReactNode }) => {
  useControllerAccount();
  useBootstrapPrefetch();
  useShardHealthGuard();

  return <>{children}</>;
};

const useBootstrapPrefetch = () => {
  const account = useAccountStore((state) => state.account);
  const hasPrefetchedRef = useRef(false);

  useEffect(() => {
    // Skip bootstrap entirely on factory route so it can operate without sync
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/factory")) {
      return;
    }

    if (!account || hasPrefetchedRef.current) {
      return;
    }

    const pathWorld = (() => {
      if (typeof window === "undefined") return null;
      const match = window.location.pathname.match(/^\/play\/([^/]+)(?:\/|$)/);
      if (!match || !match[1]) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return null;
      }
    })();

    const activeWorld = getActiveWorld();
    if (!activeWorld && !pathWorld) {
      return;
    }

    hasPrefetchedRef.current = true;

    void bootstrapGame().catch((error) => {
      console.error("[BOOTSTRAP PREFETCH FAILED]", error);
      hasPrefetchedRef.current = false;
    });
  }, [account]);
};
