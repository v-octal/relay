import assert from 'node:assert/strict';
import test from 'node:test';
import { createScreenKeeper } from './wake.ts';
import type { WakeSentinel, WakeState } from './wake.ts';

class FakeSentinel implements WakeSentinel {
  released = false;
  listeners: (() => void)[] = [];
  async release() { this.released = true; }
  addEventListener(_type: 'release', listener: () => void) { this.listeners.push(listener); }
  emitRelease() { this.released = true; for (const listener of this.listeners) listener(); }
}

interface HostOptions {
  wakeLock?: boolean;
  lockFails?: boolean;
  media?: boolean;
  mediaFails?: boolean;
  visible?: boolean;
}

function createHost(options: HostOptions = {}) {
  const sentinels: FakeSentinel[] = [];
  const scheduled: (() => void)[] = [];
  const listeners: (() => void)[] = [];
  const states: WakeState[] = [];
  const counters = { mediaStarts: 0, mediaStops: 0, requests: 0 };
  let visible = options.visible ?? true;
  const host = {
    wakeLock: options.wakeLock === false ? undefined : {
      request: async () => {
        counters.requests += 1;
        if (options.lockFails) throw new Error('not allowed');
        const sentinel = new FakeSentinel();
        sentinels.push(sentinel);
        return sentinel;
      },
    },
    media: options.media === false ? undefined : {
      start: async () => { counters.mediaStarts += 1; return !options.mediaFails; },
      stop: () => { counters.mediaStops += 1; },
    },
    visible: () => visible,
    onVisibilityChange: (listener: () => void) => { listeners.push(listener); return () => undefined; },
    schedule: (callback: () => void) => { scheduled.push(callback); },
    onChange: (state: WakeState) => { states.push(state); },
  };
  return {
    host,
    sentinels,
    states,
    counters,
    setVisible(value: boolean) { visible = value; for (const listener of listeners) listener(); },
    runScheduled() { for (const callback of scheduled.splice(0)) callback(); },
  };
}

async function flush(times = 12) {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

test('the screen lock follows the transfer reasons', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  assert.equal(keeper.getState(), 'off');
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'on');
  assert.equal(fixture.counters.requests, 1);
  keeper.hold('receiving');
  await flush();
  assert.equal(fixture.counters.requests, 1);
  keeper.release('sending');
  await flush();
  assert.equal(keeper.getState(), 'on');
  assert.deepEqual(keeper.reasons(), ['receiving']);
  keeper.release('receiving');
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(fixture.sentinels[0].released, true);
  assert.equal(keeper.isHolding(), false);
});

test('a repeated reason is held only once', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  keeper.hold('sending');
  await flush();
  assert.equal(fixture.counters.requests, 1);
  keeper.release('sending');
  await flush();
  assert.equal(keeper.getState(), 'off');
});

test('a browser without the wake lock keeps the screen on with media', async () => {
  const fixture = createHost({ wakeLock: false });
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('receiving');
  await flush();
  assert.equal(keeper.getState(), 'media');
  assert.equal(fixture.counters.mediaStarts, 1);
  keeper.release('receiving');
  await flush();
  assert.equal(fixture.counters.mediaStops, 1);
  assert.equal(keeper.getState(), 'off');
});

test('a refused wake lock falls back to media playback', async () => {
  const fixture = createHost({ lockFails: true });
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'media');
  assert.equal(fixture.counters.requests, 1);
});

test('a browser that cannot hold the screen is reported as unsupported', async () => {
  const fixture = createHost({ wakeLock: false, mediaFails: true });
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'unsupported');
  keeper.release('sending');
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.ok(fixture.states.includes('unsupported'));
});

test('a hidden page waits until it is visible again', async () => {
  const fixture = createHost({ visible: false });
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(fixture.counters.requests, 0);
  fixture.setVisible(true);
  await flush();
  assert.equal(keeper.getState(), 'on');
  assert.equal(fixture.counters.requests, 1);
  fixture.setVisible(false);
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(fixture.sentinels[0].released, true);
});

test('the lock is requested again after the browser releases it', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('receiving');
  await flush();
  assert.equal(keeper.getState(), 'on');
  fixture.sentinels[0].emitRelease();
  await flush();
  assert.equal(keeper.getState(), 'off');
  fixture.runScheduled();
  await flush();
  assert.equal(keeper.getState(), 'on');
  assert.equal(fixture.counters.requests, 2);
});

test('an unstable lock gives up and uses media instead', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  for (let index = 0; index < 3; index++) {
    const sentinel = fixture.sentinels[fixture.sentinels.length - 1];
    sentinel.emitRelease();
    fixture.runScheduled();
    await flush();
  }
  assert.equal(keeper.getState(), 'media');
  assert.equal(fixture.counters.requests, 3);
});

test('the setting turns the screen lock on and off', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'on');
  keeper.setEnabled(false);
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(keeper.isHolding(), true);
  keeper.setEnabled(true);
  await flush();
  assert.equal(keeper.getState(), 'on');
  assert.equal(fixture.counters.requests, 2);
});

test('a disabled keeper never requests a lock', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper({ ...fixture.host, enabled: false });
  keeper.hold('sending');
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(fixture.counters.requests, 0);
  assert.equal(keeper.isEnabled(), false);
});

test('dispose releases the lock and ignores later calls', async () => {
  const fixture = createHost();
  const keeper = createScreenKeeper(fixture.host);
  keeper.hold('sending');
  await flush();
  keeper.dispose();
  await flush();
  assert.equal(keeper.getState(), 'off');
  assert.equal(fixture.sentinels[0].released, true);
  keeper.hold('receiving');
  fixture.setVisible(false);
  fixture.setVisible(true);
  await flush();
  assert.equal(fixture.counters.requests, 1);
  keeper.releaseAll();
  await flush();
  assert.equal(keeper.getState(), 'off');
});
