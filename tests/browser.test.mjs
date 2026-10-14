import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const port = process.env.PASEO_PORT || process.env.PORT || '5173';
const baseUrl = process.env.TEST_URL || `http://127.0.0.1:${port}`;
const artifactPath = process.env.TEST_ARTIFACT_PATH;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
const temporaryFolders = [];
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));

try {
  const sender = await context.newPage();
  await sender.goto(baseUrl);
  await sender.getByRole('heading', { name: 'Send files directly to your other devices.' }).waitFor();
  await sender.locator('.upload-symbol svg').waitFor();
  await sender.waitForTimeout(1000);
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-desktop.png`, fullPage: true });
  assert.equal(await sender.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true);

  await sender.getByRole('button', { name: 'How it works' }).click();
  await sender.getByRole('heading', { name: 'How it works' }).waitFor();
  await sender.getByText('Put both devices on the same network', { exact: false }).waitFor();
  await sender.getByRole('button', { name: 'Got it' }).click();
  await sender.getByRole('button', { name: 'Settings', exact: true }).click();
  await sender.getByLabel('Device name', { exact: true }).fill('Studio laptop');
  await sender.getByRole('button', { name: 'Save changes' }).click();
  await sender.getByRole('heading', { name: 'Studio laptop', exact: true }).waitFor();
  await sender.getByRole('button', { name: 'Switch color theme' }).click();
  assert.equal(await sender.locator('html').getAttribute('data-theme'), 'dark');
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-dark.png`, fullPage: true });
  await sender.getByRole('button', { name: 'Switch color theme' }).click();

  await sender.getByRole('button', { name: 'Received', exact: true }).click();
  await sender.getByText('No received files yet.', { exact: true }).waitFor();
  await sender.getByRole('button', { name: 'All', exact: true }).click();

  await sender.setViewportSize({ width: 390, height: 844 });
  await sender.waitForTimeout(200);
  assert.equal(await sender.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true);
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-mobile.png`, fullPage: true });
  await sender.setViewportSize({ width: 1440, height: 1000 });

  await sender.getByText('Ready', { exact: true }).waitFor({ timeout: 45000 });
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
  });
  await receiver.goto(baseUrl);
  await receiver.getByText('Ready', { exact: true }).waitFor({ timeout: 45000 });
  await receiver.getByRole('button', { name: 'Settings', exact: true }).click();
  await receiver.getByLabel('Device name', { exact: true }).fill('Living room tablet');
  await receiver.getByRole('button', { name: 'Save changes' }).click();
  const code = (await receiver.locator('#own-code').innerText()).replace(/\s/g, '');
  assert.match(code, /^[A-Z0-9]{6}$/);
  await sender.getByLabel('Enter the other device’s code').fill(code);
  await sender.getByRole('button', { name: 'Connect', exact: true }).click();
  await sender.locator('.connected-label').waitFor({ timeout: 30000 });
  await receiver.locator('.connected-label').waitFor({ timeout: 30000 });

  const text = 'Hello from Relay. Direct, private, and close together.\n';
  const binary = Buffer.alloc(1024 * 1024 + 17);
  for (let index = 0; index < binary.length; index++) binary[index] = index % 251;
  await sender.locator('#file-input').setInputFiles([
    { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    { name: 'sample.bin', mimeType: 'application/octet-stream', buffer: binary },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ]);
  await sender.getByRole('button', { name: 'Send 3 files to Living room tablet' }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 3, undefined, { timeout: 45000 });
  await sender.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 3, undefined, { timeout: 45000 });
  const received = await receiver.evaluate(async () => {
    const links = document.querySelectorAll('[data-action="download"]');
    const files = [];
    for (const button of links) {
      const name = button.closest('.transfer-row').querySelector('strong').textContent;
      files.push(name);
    }
    return files;
  });
  assert.deepEqual(received.sort(), ['empty.txt', 'hello.txt', 'sample.bin']);
  const downloadPromise = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Download hello.txt', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'hello.txt');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), text);

  const binaryDownloadPromise = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Download sample.bin', exact: true }).click();
  const binaryDownload = await binaryDownloadPromise;
  const binaryStream = await binaryDownload.createReadStream();
  const binaryChunks = [];
  for await (const chunk of binaryStream) binaryChunks.push(chunk);
  assert.equal(Buffer.compare(Buffer.concat(binaryChunks), binary), 0);

  const savedFiles = (page, rootName) => page.evaluate(async (name) => {
    const walk = async (directory, prefix, out) => {
      for await (const [entryName, handle] of directory.entries()) {
        const path = prefix ? `${prefix}/${entryName}` : entryName;
        if (handle.kind === 'directory') await walk(handle, path, out);
        else out[path] = await (await handle.getFile()).text();
      }
      return out;
    };
    const root = await navigator.storage.getDirectory();
    return walk(await root.getDirectoryHandle(name), '', {});
  }, rootName);

  const manyFiles = Array.from({ length: 130 }, (_, index) => ({ name: `many/${String(index).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`many-file-${index}\n`) }));
  await sender.locator('#file-input').setInputFiles(manyFiles);
  await sender.getByText(/130 files · 1 folder/).waitFor();
  await sender.getByRole('button', { name: /Send 130 files/ }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor({ timeout: 45000 });
  await receiver.getByText('many/000.txt', { exact: true }).waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 133, undefined, { timeout: 60000 });
  await sender.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 133, undefined, { timeout: 60000 });
  const stored = Object.entries(await savedFiles(receiver, 'relay-downloads')).filter(([path]) => /\/many\/\d{3}\.txt$/.test(path));
  assert.equal(stored.length, 130);
  assert.equal(stored.find(([path]) => path.endsWith('/many/129.txt'))?.[1], 'many-file-129\n');

  const zipPromise = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Download all as ZIP' }).click();
  const zipDownload = await zipPromise;
  assert.match(zipDownload.suggestedFilename(), /^relay-.*\.zip$/);
  const zipChunks = [];
  for await (const chunk of await zipDownload.createReadStream()) zipChunks.push(chunk);
  const zip = Buffer.concat(zipChunks);
  const endAt = zip.length - 22;
  assert.equal(zip.readUInt32LE(endAt), 0x06054b50);
  const zipNames = [];
  for (let at = zip.readUInt32LE(endAt + 16), index = 0; index < zip.readUInt16LE(endAt + 10); index++) {
    const nameLength = zip.readUInt16LE(at + 28);
    zipNames.push(zip.subarray(at + 46, at + 46 + nameLength).toString());
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  assert.equal(zipNames.length, 133);
  assert.ok(zipNames.includes('hello.txt') && zipNames.includes('many/000.txt') && zipNames.includes('many/129.txt'));

  await sender.getByRole('button', { name: 'Add files or folders', exact: true }).click();
  await sender.getByRole('menuitem', { name: /Files/ }).waitFor();
  await sender.getByRole('menuitem', { name: /Folder/ }).waitFor();
  await sender.keyboard.press('Escape');
  assert.equal(await sender.locator('#add-menu').isHidden(), true);

  await receiver.getByRole('button', { name: 'Choose save folder' }).click();
  await receiver.getByText('Save into “picked”').waitFor();
  await receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const trip = await (await root.getDirectoryHandle('picked')).getDirectoryHandle('trip', { create: true });
    const existing = await (await trip.getFileHandle('readme.txt', { create: true })).createWritable();
    await existing.write('already here\n');
    await existing.close();
  });

  const folderPath = await mkdtemp(join(tmpdir(), 'relay-folder-'));
  temporaryFolders.push(folderPath);
  const tripPath = join(folderPath, 'trip');
  await mkdir(join(tripPath, 'day1'), { recursive: true });
  await mkdir(join(tripPath, 'day2'), { recursive: true });
  await writeFile(join(tripPath, 'day1', 'photo-notes.txt'), 'folder note one\n');
  await writeFile(join(tripPath, 'day2', 'itinerary.txt'), 'folder note two\n');
  await writeFile(join(tripPath, 'readme.txt'), 'folder root\n');
  const chooserPromise = sender.waitForEvent('filechooser');
  await sender.getByRole('button', { name: 'Add files or folders', exact: true }).click();
  await sender.getByRole('menuitem', { name: /Folder/ }).click();
  await (await chooserPromise).setFiles(tripPath);
  await sender.getByText(/3 files · 1 folder/).waitFor();
  await sender.getByRole('button', { name: /Send 3 files/ }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor();
  await receiver.getByText('trip/day1/photo-notes.txt', { exact: true }).waitFor();
  await receiver.locator('.offer-save').getByText('Save into “picked”').waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 136, undefined, { timeout: 60000 });
  await sender.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 136, undefined, { timeout: 60000 });
  assert.deepEqual(await savedFiles(receiver, 'picked'), {
    'trip/readme.txt': 'already here\n',
    'trip/readme (2).txt': 'folder root\n',
    'trip/day1/photo-notes.txt': 'folder note one\n',
    'trip/day2/itinerary.txt': 'folder note two\n',
  });
  await receiver.getByRole('button', { name: 'Stop saving into picked' }).click();
  await receiver.getByRole('button', { name: 'Choose save folder' }).waitFor();

  const plain = await context.newPage();
  await plain.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); Object.defineProperty(Window.prototype, 'showDirectoryPicker', { value: undefined, configurable: true }); });
  await plain.goto(baseUrl);
  await plain.getByText('This browser does not let websites save into a folder.', { exact: false }).waitFor();
  assert.equal(await plain.getByRole('button', { name: 'Choose save folder' }).count(), 0);
  await plain.close();

  const filler = (size) => Buffer.alloc(size, 7);
  const wakeChip = (page) => page.evaluate(() => {
    const chip = document.querySelector('#wake-status');
    const video = document.querySelector('video.wake-video');
    return { state: chip.dataset.wakeState, hidden: chip.hidden, mediaPlaying: Boolean(video?.muted && !video.paused) };
  });
  const showChip = (page) => page.waitForFunction(() => {
    const chip = document.querySelector('#wake-status');
    return Boolean(chip && !chip.hidden);
  }, undefined, { timeout: 20000 });

  await sender.locator('#file-input').setInputFiles({ name: 'awake.bin', mimeType: 'application/octet-stream', buffer: filler(8 * 1024 * 1024) });
  await sender.getByRole('button', { name: 'Send 1 file to Living room tablet', exact: true }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await showChip(receiver);
  await showChip(sender);
  const holding = await wakeChip(receiver);
  assert.equal(holding.hidden, false);
  assert.equal(holding.state === 'on' || (holding.state === 'media' && holding.mediaPlaying), true);
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 137, undefined, { timeout: 60000 });
  await sender.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 137, undefined, { timeout: 60000 });
  for (const page of [sender, receiver]) {
    const idle = await wakeChip(page);
    assert.equal(idle.hidden, true);
    assert.equal(idle.mediaPlaying, false);
  }

  await sender.evaluate(() => {
    window.__relayTimers = {
      timeout: window.setTimeout.bind(window),
      interval: window.setInterval.bind(window),
      visibilityState: Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'),
      hidden: Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'),
    };
    window.setTimeout = (handler, delay, ...args) => window.__relayTimers.timeout(handler, Math.max(Number(delay) || 0, 60000), ...args);
    window.setInterval = (handler, delay, ...args) => window.__relayTimers.interval(handler, Math.max(Number(delay) || 0, 60000), ...args);
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await sender.evaluate(() => document.hidden), true);
  await sender.locator('#file-input').setInputFiles({ name: 'background.bin', mimeType: 'application/octet-stream', buffer: filler(12 * 1024 * 1024) });
  await sender.getByRole('button', { name: 'Send 1 file to Living room tablet', exact: true }).click();
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 138, undefined, { timeout: 60000 });
  await sender.evaluate(() => {
    const saved = window.__relayTimers;
    window.setTimeout = saved.timeout;
    window.setInterval = saved.interval;
    Object.defineProperty(Document.prototype, 'visibilityState', saved.visibilityState);
    Object.defineProperty(Document.prototype, 'hidden', saved.hidden);
    window.__relayTimers = undefined;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sender.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 138, undefined, { timeout: 30000 });
  assert.equal(await sender.locator('.transfer-status.failed').count(), 0);

  await sender.getByRole('button', { name: 'Settings', exact: true }).click();
  const wakeSetting = sender.getByRole('switch', { name: 'Keep the screen on' });
  assert.equal(await wakeSetting.getAttribute('aria-checked'), 'true');
  await wakeSetting.click();
  assert.equal(await wakeSetting.getAttribute('aria-checked'), 'false');
  await sender.getByRole('button', { name: 'Save changes' }).click();
  assert.equal(await sender.evaluate(() => localStorage.getItem('relay-keep-awake')), 'off');

  await sender.locator('#file-input').setInputFiles({ name: 'no-wake.txt', mimeType: 'text/plain', buffer: Buffer.from('Screen setting is off.\n') });
  await sender.getByRole('button', { name: 'Send 1 file to Living room tablet', exact: true }).click();
  await sender.waitForTimeout(400);
  assert.equal((await wakeChip(sender)).hidden, true);
  await receiver.getByRole('button', { name: 'Accept files' }).waitFor();
  await receiver.getByRole('button', { name: 'Accept files' }).click();
  await receiver.waitForFunction(() => document.querySelectorAll('.transfer-status.complete').length === 139, undefined, { timeout: 60000 });
  assert.equal((await wakeChip(sender)).hidden, true);

  await sender.getByRole('button', { name: 'Settings', exact: true }).click();
  await sender.getByRole('switch', { name: 'Keep the screen on' }).click();
  assert.equal(await sender.evaluate(() => localStorage.getItem('relay-keep-awake')), 'on');
  await sender.getByRole('button', { name: 'Save changes' }).click();

  await sender.locator('#file-input').setInputFiles({ name: 'declined.txt', mimeType: 'text/plain', buffer: Buffer.from('Not accepted.') });
  await sender.getByRole('button', { name: 'Send 1 file to Living room tablet', exact: true }).click();
  await receiver.getByRole('button', { name: 'No, thanks' }).click();
  await sender.getByRole('button', { name: 'Send 1 file to Living room tablet', exact: true }).waitFor();
  assert.equal(await receiver.locator('.transfer-row').count(), 139);
  await receiver.getByRole('button', { name: 'Disconnect Studio laptop', exact: true }).click();
  await sender.waitForFunction(() => !document.querySelector('.connected-label'));
  assert.deepEqual(errors, []);
  console.log('Passed: desktop, mobile, theme, settings, history, pairing, text/binary/empty file transfers, download integrity, 130-file batch, ZIP download, add menu, folder upload, save folder without overwrite, unsupported-browser notice, screen wake lock, hidden-tab transfers, keep-awake setting, decline, and disconnect.');
} catch (error) {
  console.error('Browser errors:', errors);
  for (const [index, page] of context.pages().entries()) {
    console.error(`Page ${index}:`, await page.locator('body').innerText());
    if (artifactPath) await page.screenshot({ path: `${artifactPath}/relay-failure-${index}.png`, fullPage: true });
  }
  throw error;
} finally {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
  await browser.close();
}
