import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const port = process.env.PASEO_PORT || process.env.PORT || '5173';
const baseUrl = process.env.TEST_URL || `http://127.0.0.1:${port}`;
const artifactPath = process.env.TEST_ARTIFACT_PATH;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));

try {
  const sender = await context.newPage();
  await sender.goto(baseUrl);
  await sender.getByRole('heading', { name: 'A little less cloud.' }).waitFor();
  await sender.locator('.upload-symbol svg').waitFor();
  await sender.waitForTimeout(1000);
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-desktop.png`, fullPage: true });
  assert.equal(await sender.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true);

  await sender.getByRole('button', { name: 'How it works' }).click();
  await sender.getByRole('heading', { name: 'From here to there, in three.' }).waitFor();
  await sender.getByRole('button', { name: 'Sounds good' }).click();
  await sender.getByRole('button', { name: 'Settings', exact: true }).click();
  await sender.getByLabel('Device name', { exact: true }).fill('Studio laptop');
  await sender.getByRole('button', { name: 'Save changes' }).click();
  await sender.getByRole('heading', { name: 'Studio laptop', exact: true }).waitFor();
  await sender.getByRole('button', { name: 'Switch color theme' }).click();
  assert.equal(await sender.locator('html').getAttribute('data-theme'), 'dark');
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-dark.png`, fullPage: true });
  await sender.getByRole('button', { name: 'Switch color theme' }).click();

  await sender.getByRole('button', { name: 'Transfer history', exact: true }).click();
  await sender.getByRole('button', { name: 'Received', exact: true }).click();
  await sender.getByRole('heading', { name: 'No received files. Yet.' }).waitFor();
  await sender.getByRole('button', { name: 'Overview', exact: true }).click();

  await sender.setViewportSize({ width: 390, height: 844 });
  await sender.waitForTimeout(200);
  assert.equal(await sender.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth), true);
  if (artifactPath) await sender.screenshot({ path: `${artifactPath}/relay-mobile.png`, fullPage: true });
  await sender.setViewportSize({ width: 1440, height: 1000 });

  await sender.getByText('Ready when you are', { exact: true }).waitFor({ timeout: 45000 });
  const receiver = await context.newPage();
  await receiver.goto(baseUrl);
  await receiver.getByText('Ready when you are', { exact: true }).waitFor({ timeout: 45000 });
  await receiver.getByRole('button', { name: 'Settings', exact: true }).click();
  await receiver.getByLabel('Device name', { exact: true }).fill('Living room tablet');
  await receiver.getByRole('button', { name: 'Save changes' }).click();
  const code = (await receiver.locator('.code-copy').innerText()).replace(/\s/g, '');
  assert.match(code, /^[A-Z0-9]{6}$/);
  await sender.getByRole('button', { name: 'Connect another device' }).click();
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
  await sender.getByRole('button', { name: 'Send 3 files' }).click();
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

  await sender.locator('#file-input').setInputFiles({ name: 'declined.txt', mimeType: 'text/plain', buffer: Buffer.from('Not accepted.') });
  await sender.getByRole('button', { name: 'Send 1 file', exact: true }).click();
  await receiver.getByRole('button', { name: 'No, thanks' }).click();
  await sender.getByRole('button', { name: 'Send 1 file', exact: true }).waitFor();
  assert.equal(await receiver.locator('.transfer-row').count(), 3);
  await receiver.getByRole('button', { name: 'Disconnect Studio laptop', exact: true }).click();
  await sender.waitForFunction(() => !document.querySelector('.connected-label'));
  assert.deepEqual(errors, []);
  console.log('Passed: desktop, mobile, theme, settings, history, pairing, text/binary/empty file transfers, download integrity, decline, and disconnect.');
} catch (error) {
  console.error('Browser errors:', errors);
  for (const [index, page] of context.pages().entries()) {
    console.error(`Page ${index}:`, await page.locator('body').innerText());
    if (artifactPath) await page.screenshot({ path: `${artifactPath}/relay-failure-${index}.png`, fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
}
