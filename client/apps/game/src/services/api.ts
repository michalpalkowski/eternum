import { SqlApi } from "@bibliothecadao/torii";
import { getActiveWorld } from "@/runtime/world";
import { env } from "../../env";

let currentBaseUrl = (() => {
  const active = getActiveWorld();
  return (active?.toriiBaseUrl ?? env.VITE_PUBLIC_TORII) + "/sql";
})();

const cacheBaseUrl = env.VITE_PUBLIC_ENABLE_SQL_CACHE ? env.VITE_PUBLIC_REALTIME_URL : undefined;

export let sqlApi = new SqlApi(currentBaseUrl, cacheBaseUrl);

export const setSqlApiBaseUrl = (baseUrl: string) => {
  currentBaseUrl = baseUrl.endsWith("/sql") ? baseUrl : `${baseUrl}/sql`;
  sqlApi = new SqlApi(currentBaseUrl, cacheBaseUrl);
};

export const getSqlApiBaseUrl = () => currentBaseUrl;

export const fetchWorldConfigMapCenterOffset = async (): Promise<number | null> => {
  const query = encodeURIComponent(
    "SELECT map_center_offset FROM `s1_eternum-WorldConfig` WHERE config_id = 4294967295 LIMIT 1",
  );
  const response = await fetch(`${getSqlApiBaseUrl()}?query=${query}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch world config map center offset: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as unknown;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown[] }).rows)
      ? (payload as { rows: unknown[] }).rows
      : [];
  if (rows.length === 0) {
    return null;
  }
  const firstRow = rows[0] as { map_center_offset?: unknown } | undefined;
  const offset = firstRow?.map_center_offset;
  if (typeof offset === "number") {
    return Number.isFinite(offset) ? offset : null;
  }
  if (typeof offset === "string") {
    const parsed = Number(offset);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
