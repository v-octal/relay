export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** index).toFixed(index > 0 ? 1 : 0))} ${units[index]}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] ?? character);
}

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function createCode(): string {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(values, (value) => characters[value % characters.length]).join('');
}

export function normalizeBinary(value: unknown): ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  return undefined;
}

export interface SharedFileInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
  path?: string;
}

export const MAX_BATCH_FILES = 10000;
export const MAX_RELATIVE_PATH_LENGTH = 2048;

export function isValidRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_RELATIVE_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function joinRelativePath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

export function withCopyNumber(name: string, copy: number): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${base} (${copy})${ext}`;
}

export function uniquePath(path: string, used: Set<string>): string {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = path.slice(slash + 1);
  let candidate = path;
  for (let copy = 2; used.has(candidate.toLocaleLowerCase()); copy++) candidate = folder + withCopyNumber(name, copy);
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function availableSpaceBytes(estimate: { quota?: unknown; usage?: unknown } | undefined | null): number | undefined {
  if (!estimate || typeof estimate.quota !== 'number' || !Number.isFinite(estimate.quota) || estimate.quota < 0) return undefined;
  const usage = typeof estimate.usage === 'number' && Number.isFinite(estimate.usage) && estimate.usage > 0 ? estimate.usage : 0;
  return Math.max(0, Math.floor(estimate.quota - usage));
}

export function fitsInAvailableSpace(size: number, available: number | undefined): boolean {
  return available === undefined || size <= available;
}

export function isValidOffer(value: unknown): value is { batchId: string; files: SharedFileInfo[] } {
  if (!value || typeof value !== 'object') return false;
  const offer = value as { batchId?: unknown; files?: unknown };
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof offer.batchId !== 'string' || !idPattern.test(offer.batchId)) return false;
  if (!Array.isArray(offer.files) || !offer.files.length || offer.files.length > MAX_BATCH_FILES) return false;
  const ids = new Set<string>();
  for (const value of offer.files) {
    if (!value || typeof value !== 'object') return false;
    const file = value as SharedFileInfo;
    if (typeof file.id !== 'string' || !idPattern.test(file.id) || ids.has(file.id)) return false;
    if (typeof file.name !== 'string' || !file.name.length || file.name.length > 255 || file.name.includes('/') || file.name.includes('\\') || file.name.includes('\0')) return false;
    if (typeof file.mime !== 'string' || file.mime.length > 255) return false;
    if (!Number.isSafeInteger(file.size) || file.size < 0) return false;
    if (file.path !== undefined && !isValidRelativePath(file.path)) return false;
    ids.add(file.id);
  }
  return true;
}

export interface VisibleClock {
  tick(): number;
  reset(): void;
  elapsed(): number;
}

export function createVisibleClock(isVisible: () => boolean, now: () => number = () => Date.now()): VisibleClock {
  let total = 0;
  let last = now();
  return {
    tick() {
      const current = now();
      if (isVisible()) total += Math.max(0, current - last);
      last = current;
      return total;
    },
    reset() {
      total = 0;
      last = now();
    },
    elapsed: () => total,
  };
}

export function devicePlatform(): { name: string; os: string; browser: string; kind: string } {
  const agent = navigator.userAgent;
  const os = /iPad|iPhone/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : 'Linux';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox/.test(agent) ? 'Firefox' : /Chrome/.test(agent) ? 'Chrome' : 'Safari';
  const kind = /iPhone|Android.*Mobile/.test(agent) ? 'smartphone' : /iPad/.test(agent) ? 'tablet' : 'laptop';
  const name = os === 'macOS' ? 'This Mac' : os === 'Windows' ? 'This PC' : os === 'iOS' ? 'This iPhone' : os === 'Android' ? 'This Android' : 'This device';
  return { name, os, browser, kind };
}
