export type WakeState = 'off' | 'on' | 'media' | 'unsupported';

export interface WakeSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeSentinel>;
}

export interface MediaKeeper {
  start(): Promise<boolean>;
  stop(): void;
}

export interface ScreenKeeperHost {
  wakeLock?: WakeLockApi;
  media?: MediaKeeper;
  visible?: () => boolean;
  onVisibilityChange?: (listener: () => void) => () => void;
  schedule?: (callback: () => void, delay: number) => void;
  enabled?: boolean;
  retryDelay?: number;
  onChange?: (state: WakeState) => void;
}

export interface ScreenKeeper {
  hold(reason: string): void;
  release(reason: string): void;
  releaseAll(): void;
  isHolding(): boolean;
  reasons(): string[];
  getState(): WakeState;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createScreenKeeper(host: ScreenKeeperHost = {}): ScreenKeeper {
  const visible = host.visible ?? (() => true);
  const schedule = host.schedule ?? ((callback: () => void, delay: number) => { setTimeout(callback, delay); });
  const retryDelay = host.retryDelay ?? 500;
  const held = new Set<string>();
  let enabled = host.enabled ?? true;
  let state: WakeState = 'off';
  let sentinel: WakeSentinel | undefined;
  let mediaActive = false;
  let acquiring = false;
  let disposed = false;
  let grantedAt = 0;
  let unstable = 0;
  let useWakeLock = true;
  const unsubscribe = host.onVisibilityChange?.(() => sync());

  function publish() {
    if (!disposed) host.onChange?.(state);
  }

  function setState(next: WakeState) {
    if (state === next) return;
    state = next;
    publish();
  }

  function wanted() {
    return !disposed && enabled && held.size > 0 && visible();
  }

  function drop() {
    mediaActive = false;
    host.media?.stop();
    const current = sentinel;
    sentinel = undefined;
    setState('off');
    if (current && !current.released) void current.release().catch(() => undefined);
  }

  function sync() {
    if (disposed) return;
    if (!wanted()) { drop(); return; }
    if (sentinel || mediaActive || acquiring) return;
    acquiring = true;
    void acquire();
  }

  function onRelease() {
    if (visible() && Date.now() - grantedAt < 3000) {
      unstable += 1;
      if (unstable > 2) useWakeLock = false;
    }
    sentinel = undefined;
    setState('off');
    if (wanted()) schedule(() => sync(), retryDelay);
  }

  async function acquire() {
    try {
      if (host.wakeLock && useWakeLock) {
        try {
          const next = await host.wakeLock.request('screen');
          if (!wanted()) { void next.release().catch(() => undefined); setState('off'); return; }
          sentinel = next;
          grantedAt = Date.now();
          next.addEventListener('release', onRelease);
          setState('on');
          return;
        } catch { useWakeLock = false; }
      }
      if (host.media) {
        try {
          if (await host.media.start()) {
            if (!wanted()) { host.media.stop(); setState('off'); return; }
            mediaActive = true;
            setState('media');
            return;
          }
        } catch { mediaActive = false; }
      }
      setState('unsupported');
    } finally {
      acquiring = false;
    }
  }

  return {
    hold(reason: string) { held.add(reason); sync(); },
    release(reason: string) { held.delete(reason); sync(); },
    releaseAll() { held.clear(); sync(); },
    isHolding: () => held.size > 0,
    reasons: () => Array.from(held),
    getState: () => state,
    isEnabled: () => enabled,
    setEnabled(next: boolean) { enabled = next; sync(); },
    dispose() { disposed = true; held.clear(); unsubscribe?.(); drop(); },
  };
}
