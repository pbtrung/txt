export function registerJsVfs(
  Module: any,
  opts?: { name?: string; makeDefault?: boolean },
): { name: string; files: Map<string, { bytes: Uint8Array }> };
