export const normalizeHexAddress = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return `0x${BigInt(trimmed).toString(16)}`.toLowerCase();
  } catch {
    return null;
  }
};
