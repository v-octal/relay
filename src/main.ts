import Peer, { type DataConnection } from 'peerjs';
import {
  createIcons, ArrowDown, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp,
  Copy, Download, ExternalLink, File, FileArchive, FileImage, FileText, Files, FolderDown, FolderOpen, Inbox, Laptop, Link,
  LoaderCircle, Moon, Pencil, Plus, RefreshCw, Send, Settings2, ShieldCheck, Smartphone, Sun, SunDim, Tablet, TriangleAlert, X,
} from 'lucide';
import { availableSpaceBytes, createCode, createVisibleClock, devicePlatform, escapeHtml, fitsInAvailableSpace, formatBytes, isValidOffer, isValidRelativePath, joinRelativePath, MAX_BATCH_FILES, normalizeBinary, normalizeCode, uniquePath, withCopyNumber } from './utils';
import { crc32Update, createZip } from './zip';
import { createScreenKeeper, type WakeState } from './wake';
import { createVideoKeeper } from './wake-media';
import './style.css';

const iconSet = {
  ArrowDown, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Copy, Download,
  ExternalLink, File, FileArchive, FileImage, FileText, Files, FolderDown, FolderOpen, Inbox, Laptop, Link, LoaderCircle,
  Moon, Pencil, Plus, RefreshCw, Send, Settings2, ShieldCheck, Smartphone, Sun, SunDim, Tablet, TriangleAlert, X,
};
const icon = (name: string, className = '') => `<i data-lucide="${name}" class="${className}" aria-hidden="true"></i>`;
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root is missing.');
const platform = devicePlatform();
let deviceName = localStorage.getItem('relay-name') || platform.name;
let ownCode = createCode();
let peer: Peer;
let networkReady = false;
let networkError = '';
let theme = localStorage.getItem('relay-theme') || 'light';
let selectedFiles: SelectedFile[] = [];
let selectedPeer = '';
let isSending = false;
let historyFilter = 'all';
let pendingPair = '';
let scanActive = false;
const sessionId = crypto.randomUUID();
const devices = new Map<string, Device>();
const nearby = new Map<string, NearbyDevice>();
const transfers: Transfer[] = [];
const receivers = new Map<string, Receiver>();
const offers = new Map<string, Offer>();
const acceptance = new Map<string, { peerId: string; resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
let destinationFolder: FileSystemDirectoryHandle | undefined;
let availableBytes: number | undefined;
let zipBusy = false;
let channel: BroadcastChannel | undefined;
try { channel = new BroadcastChannel('relay-nearby-v1'); } catch { channel = undefined; }

const CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const STALL_LIMIT = 60000;
const ACK_LIMIT = 60000;
const RECEIVER_LIMIT = 240000;
const SEND_REASON = 'sending';
const RECEIVE_REASON = 'receiving';
let keepAwake = localStorage.getItem('relay-keep-awake') !== 'off';
let wakeWarned = false;
const acknowledgements = new Map<string, { peerId: string; settle: (status: 'complete' | 'failed') => void }>();
const screenKeeper = createScreenKeeper({
  wakeLock: navigator.wakeLock ? { request: (type) => navigator.wakeLock.request(type) } : undefined,
  media: createVideoKeeper(),
  visible: () => document.visibilityState === 'visible',
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  enabled: keepAwake,
  onChange: () => renderWake(),
});

interface Device {
  id: string;
  name: string;
  kind: string;
  os: string;
  browser: string;
  connection: DataConnection;
}
interface NearbyDevice {
  id: string;
  name: string;
  kind: string;
  os: string;
  browser: string;
  lastSeen: number;
}
interface FileInfo {
  id: string;
  name: string;
  size: number;
  mime: string;
  path?: string;
}
interface SelectedFile {
  file: File;
  path: string;
}
interface Transfer {
  id: string;
  name: string;
  size: number;
  device: string;
  peerId: string;
  direction: 'sent' | 'received';
  status: 'active' | 'complete' | 'failed';
  progress: number;
  time: number;
  blob?: Blob;
  handle?: FileSystemFileHandle;
  savedName?: string;
  inFolder?: boolean;
  crc?: number;
}
interface Receiver {
  info: FileInfo;
  chunks: ArrayBuffer[];
  bytes: number;
  peerId: string;
  batchId: string;
  lastSeen: number;
  batch: ReceiveBatch;
  started: boolean;
  writable?: FileSystemWritableFileStream;
  discard?: () => Promise<void>;
  crc: number;
  writeChain: Promise<void>;
  writeError?: Error;
}
interface ReceiveBatch {
  id: string;
  folder?: FileSystemDirectoryHandle;
  used: Set<string>;
  storeUsed: Set<string>;
  store?: Promise<FileSystemDirectoryHandle | undefined>;
}
interface Offer {
  batchId: string;
  device: Device;
  files: FileInfo[];
  receivedAt: number;
}
type Message =
  | { type: 'hello'; name: string; kind: string; os: string; browser: string }
  | { type: 'offer'; batchId: string; files: FileInfo[] }
  | { type: 'accepted' | 'declined' | 'cancel'; batchId: string }
  | { type: 'chunk'; id: string; data: ArrayBuffer | ArrayBufferView }
  | { type: 'end' | 'complete' | 'failed'; id: string };

async function refreshAvailableSpace() {
  try {
    availableBytes = availableSpaceBytes(await navigator.storage?.estimate?.());
  } catch { availableBytes = undefined; }
  return availableBytes;
}

type DisplayItem = { name: string; path: string; size: number };
function selectedItems(): DisplayItem[] {
  return selectedFiles.map(({ file, path }) => ({ name: file.name, path, size: file.size }));
}
function offerFiles(files: FileInfo[]): DisplayItem[] {
  return files.map((file) => ({ name: file.name, path: file.path || file.name, size: file.size }));
}
function selectedFolders(items: DisplayItem[]): string[] {
  const folders = new Set<string>();
  for (const item of items) {
    const slash = item.path.indexOf('/');
    if (slash > 0) folders.add(item.path.slice(0, slash));
  }
  return Array.from(folders);
}
function itemsHtml(items: DisplayItem[], removable: boolean) {
  const visible = items.slice(0, 100);
  const hiddenCount = items.length - visible.length;
  return `${visible.map((item, index) => `<div class="file-row"><span class="file-icon">${icon(fileIcon(item.name))}</span><div>${fileNameHtml(item.path)}<span>${formatBytes(item.size)}</span></div>${removable ? `<button class="icon-button" data-action="remove-file" data-index="${index}" aria-label="Remove ${escapeHtml(item.path)}" ${isSending ? 'disabled' : ''}>${icon('x')}</button>` : ''}</div>`).join('')}${hiddenCount > 0 ? `<div class="file-row"><span class="file-icon">${icon('file')}</span><div><strong class="file-name"><span class="file-name-base">and ${hiddenCount} more file${hiddenCount > 1 ? 's' : ''}</span></strong><span>All files are in the list and are sent in order.</span></div></div>` : ''}`;
}
type FolderSupport = 'yes' | 'frame' | 'insecure' | 'browser';
type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
type PermissionHandle = FileSystemHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
};
type IterableDirectory = FileSystemDirectoryHandle & { keys?: () => AsyncIterable<string> };
const directoryPicker = () => (window as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
function inCrossOriginFrame(): boolean {
  if (window.self === window.top) return false;
  try { return !window.top?.location.href; } catch { return true; }
}
function folderSupport(): FolderSupport {
  if (inCrossOriginFrame()) return 'frame';
  if (typeof directoryPicker() === 'function') return 'yes';
  if (!window.isSecureContext) return 'insecure';
  return 'browser';
}
function folderSupportReason(support: FolderSupport): string {
  if (support === 'frame') return 'Relay runs inside another page here, so the browser blocks folder access. Open Relay in its own tab to choose a folder.';
  if (support === 'insecure') return 'The browser allows folder access only on secure pages. Open Relay over HTTPS or on localhost to choose a folder.';
  return 'This browser does not let websites save into a folder. Chrome, Edge, and Opera on a computer can do this.';
}

async function chooseDestinationFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  const support = folderSupport();
  const picker = directoryPicker();
  if (support !== 'yes' || !picker) { toast(folderSupportReason(support), true); return undefined; }
  try {
    const handle = await picker({ id: 'relay-save', mode: 'readwrite' });
    void refreshAvailableSpace();
    return handle;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    toast(error instanceof DOMException && error.name === 'SecurityError' ? folderSupportReason('frame') : 'Relay could not open that folder. Try another folder.', true);
    return undefined;
  }
}

async function hasFolderAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissions = handle as PermissionHandle;
  try {
    if (!permissions.queryPermission) return true;
    if (await permissions.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return (await permissions.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch { return false; }
}

function openSettings(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('relay', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function saveSetting(key: string, value: unknown) {
  try {
    const db = await openSettings();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      if (value === undefined) transaction.objectStore('settings').delete(key);
      else transaction.objectStore('settings').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch { /* The folder choice lasts only for this visit. */ }
}
async function loadSetting<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openSettings();
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction('settings', 'readonly').objectStore('settings').get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch { return undefined; }
}
async function setDestinationFolder(handle: FileSystemDirectoryHandle | undefined) {
  destinationFolder = handle;
  await saveSetting('destination', handle);
  render();
}
async function restoreDestinationFolder() {
  if (folderSupport() !== 'yes') return;
  const handle = await loadSetting<FileSystemDirectoryHandle>('destination');
  if (handle && typeof handle.getFileHandle === 'function') { destinationFolder = handle; render(); }
}

const SESSION_LOCK = `relay-session-${sessionId}`;
async function downloadsRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('relay-downloads', { create: true });
  } catch { return undefined; }
}
async function sessionFolder(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  try { return await (await downloadsRoot())?.getDirectoryHandle(sessionId, { create }); } catch { return undefined; }
}
async function removeStaleDownloads() {
  try {
    if (!navigator.locks) return;
    const root = (await downloadsRoot()) as IterableDirectory | undefined;
    if (!root?.keys) return;
    const held = new Set(((await navigator.locks.query()).held || []).map((lock) => lock.name));
    const stale: string[] = [];
    for await (const name of root.keys()) if (name !== sessionId && !held.has(`relay-session-${name}`)) stale.push(name);
    for (const name of stale) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  } catch { /* Old files stay until the next visit. */ }
}
async function clearSessionDownloads() {
  try { await (await downloadsRoot())?.removeEntry(sessionId, { recursive: true }); } catch { /* Nothing to remove. */ }
}

async function entryExists(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await directory.getFileHandle(name); return true; } catch (error) {
    return !(error instanceof DOMException && error.name === 'NotFoundError');
  }
}
interface SaveTarget { directory: FileSystemDirectoryHandle; handle: FileSystemFileHandle; writable: FileSystemWritableFileStream; path: string; savedName: string }
async function openSaveTarget(root: FileSystemDirectoryHandle, relativePath: string, used: Set<string>, avoidExisting: boolean): Promise<SaveTarget> {
  const parts = relativePath.split('/');
  const folders = parts.slice(0, -1);
  let directory = root;
  for (const part of folders) directory = await directory.getDirectoryHandle(part, { create: true });
  const name = parts[parts.length - 1];
  const prefix = folders.length ? `${folders.join('/')}/` : '';
  let savedName = name;
  for (let copy = 2; used.has(`${prefix}${savedName}`.toLocaleLowerCase()) || (avoidExisting && await entryExists(directory, savedName)); copy++) savedName = withCopyNumber(name, copy);
  used.add(`${prefix}${savedName}`.toLocaleLowerCase());
  const handle = await directory.getFileHandle(savedName, { create: true });
  try {
    const writable = await handle.createWritable();
    return { directory, handle, writable, path: `${prefix}${savedName}`, savedName };
  } catch (error) {
    await directory.removeEntry(savedName).catch(() => undefined);
    throw error;
  }
}

function displayName(file: FileInfo): string {
  return file.path || file.name;
}

const logo = `<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="11" fill="currentColor"/><path d="M11 18h14M18 11v14M13 13l10 10M13 23l10-10" stroke="white" stroke-width="3.1" stroke-linecap="round"/></svg>`;

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#" aria-label="Relay home">${logo}<span>relay</span></a>
    <div class="topbar-actions">
      <span id="wake-status" class="wake-status" data-wake-state="off" role="status" aria-live="polite" hidden></span>
      <span id="network-status" class="network-status"><span class="status-dot pending"></span><span>Connecting</span></span>
      <button class="icon-button" data-action="theme" aria-label="Switch color theme">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
      <button class="icon-button" data-action="help" aria-label="How it works">${icon('circle-help')}</button>
      <button class="icon-button" data-action="settings" aria-label="Settings">${icon('settings-2')}</button>
    </div>
  </header>
  <main>
    <h1>Send files directly to your other devices.</h1>
    <div class="grid">
      <section class="card" aria-labelledby="send-title">
        <div class="card-heading"><h2 id="send-title">Send</h2></div>
        <div id="dropzone" class="dropzone"></div>
        <div id="send-footer"></div>
      </section>
      <section class="card" aria-labelledby="devices-title">
        <div class="card-heading"><h2 id="devices-title">Devices</h2><button class="text-button" data-action="refresh">${icon('refresh-cw')}<span>Refresh</span></button></div>
        <div id="device-list" class="device-list"></div>
        <div class="pair-block">
          <div class="own-code"><span>Your code</span><button class="code-copy" data-action="copy-code" aria-label="Copy connection code"><span id="own-code"></span>${icon('copy')}</button><button class="text-button" data-action="copy-link">${icon('link')}Copy invite link</button></div>
          <form id="pair-form">
            <label for="pair-code">Enter the other device’s code</label>
            <div class="pair-row"><input id="pair-code" name="code" placeholder="ABC 123" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" required /><button class="primary-button" type="submit">Connect</button></div>
            <p id="pair-status" class="form-status" aria-live="polite"></p>
          </form>
        </div>
      </section>
    </div>
    <section class="card receive-card" aria-labelledby="receive-title">
      <div class="card-heading"><h2 id="receive-title">Receive</h2><span id="receive-space" class="receive-space"></span></div>
      <div id="receive-body"></div>
    </section>
    <section class="card history-card" aria-labelledby="history-title">
      <div class="card-heading"><h2 id="history-title">Transfers <span id="history-count" class="count-badge" hidden></span></h2><div class="history-tools"><div class="filters" role="group" aria-label="Filter transfers"><button class="filter-button" data-action="filter" data-filter="all">All</button><button class="filter-button" data-action="filter" data-filter="sent">Sent</button><button class="filter-button" data-action="filter" data-filter="received">Received</button></div><button id="clear-history" class="text-button" data-action="clear-history">Clear</button></div></div>
      <div id="history"></div>
    </section>
    <footer class="site-footer"><p>${icon('shield-check')}Files go directly between devices and are never stored on a server.</p><p>Built with <a href="https://github.com/bottomless/agent-duel" target="_blank" rel="noopener noreferrer">Agent Duel</a></p></footer>
  </main>
  <dialog id="modal" aria-labelledby="dialog-title"><div id="modal-content"></div></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <div id="add-menu" class="add-menu" role="menu" aria-label="Add to the transfer" hidden>
    <button type="button" role="menuitem" data-action="pick-files">${icon('files')}<span><strong>Files</strong><small>Pick one or more files</small></span></button>
    <button type="button" role="menuitem" data-action="pick-folder">${icon('folder-open')}<span><strong>Folder</strong><small>Pick a folder and everything in it</small></span></button>
  </div>
  <input id="file-input" type="file" multiple hidden />
  <input id="folder-input" type="file" multiple webkitdirectory hidden />
`;
const query = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const modal = query<HTMLDialogElement>('#modal');
const modalContent = query<HTMLDivElement>('#modal-content');
const fileInput = query<HTMLInputElement>('#file-input');
const folderInput = query<HTMLInputElement>('#folder-input');
const dropzone = query<HTMLDivElement>('#dropzone');
const sendFooter = query<HTMLDivElement>('#send-footer');
const deviceList = query<HTMLDivElement>('#device-list');
const historyList = query<HTMLDivElement>('#history');
const receiveBody = query<HTMLDivElement>('#receive-body');
const addMenu = query<HTMLDivElement>('#add-menu');
const pairInput = query<HTMLInputElement>('#pair-code');

function refreshIcons() {
  createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.75 } });
}

function render() {
  syncWakeLock();
  query('#network-status').innerHTML = `<span class="status-dot ${networkReady ? '' : networkError ? 'error' : 'pending'}"></span><span>${networkReady ? 'Ready' : networkError ? 'Offline' : 'Connecting'}</span>`;
  query('#own-code').textContent = `${ownCode.slice(0, 3)} ${ownCode.slice(3)}`;
  renderSend();
  renderReceive();
  renderDevices();
  renderHistory();
  renderWake();
  refreshIcons();
}

function syncWakeLock() {
  const sending = isSending || transfers.some((transfer) => transfer.direction === 'sent' && transfer.status === 'active');
  const receiving = receivers.size > 0 || offers.size > 0 || transfers.some((transfer) => transfer.direction === 'received' && transfer.status === 'active');
  if (sending) screenKeeper.hold(SEND_REASON);
  else screenKeeper.release(SEND_REASON);
  if (receiving) screenKeeper.hold(RECEIVE_REASON);
  else screenKeeper.release(RECEIVE_REASON);
}

function renderWake() {
  const element = query<HTMLElement>('#wake-status');
  const state: WakeState = screenKeeper.getState();
  const active = screenKeeper.isHolding() && state !== 'off';
  element.hidden = !active;
  element.dataset.wakeState = active ? state : 'off';
  if (!active) { element.removeAttribute('title'); element.innerHTML = ''; return; }
  const blocked = state === 'unsupported';
  element.title = blocked
    ? 'This browser cannot keep your screen on. Keep Relay visible until the transfer ends.'
    : 'Your screen stays on while files move.';
  element.innerHTML = `${icon(blocked ? 'triangle-alert' : 'sun')}<span>${blocked ? 'Keep your screen on' : 'Screen stays on'}</span>`;
  refreshIcons();
  if (blocked && keepAwake && !wakeWarned) {
    wakeWarned = true;
    toast('This browser cannot keep your screen on. Keep Relay visible during the transfer.', true);
  }
}

function applyWakeSetting() {
  const button = document.querySelector<HTMLButtonElement>('.wake-toggle');
  if (!button) return;
  button.setAttribute('aria-checked', String(keepAwake));
  button.innerHTML = `${icon(keepAwake ? 'sun' : 'sun-dim')}${keepAwake ? 'On' : 'Off'}`;
  refreshIcons();
}

function renderSend() {
  const hasFiles = selectedFiles.length > 0;
  dropzone.classList.toggle('has-files', hasFiles);
  if (hasFiles) {
    for (const name of ['role', 'tabindex', 'aria-label', 'aria-haspopup', 'aria-expanded', 'data-action']) dropzone.removeAttribute(name);
  } else {
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('aria-label', 'Add files or folders, or drop them here');
    dropzone.setAttribute('aria-haspopup', 'menu');
    dropzone.setAttribute('aria-expanded', String(menuTrigger === dropzone));
    dropzone.dataset.action = 'add-menu';
  }
  const totalSize = selectedFiles.reduce((sum, selection) => sum + selection.file.size, 0);
  const folders = selectedFolders(selectedItems());
  const summary = `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}${folders.length ? ` · ${folders.length} folder${folders.length > 1 ? 's' : ''}` : ''} · ${formatBytes(totalSize)}`;
  dropzone.innerHTML = hasFiles
    ? `<div class="selected-header"><span>${summary}</span><button class="text-button" data-action="add-menu" aria-haspopup="menu" aria-expanded="false" ${isSending ? 'disabled' : ''}>${icon('plus')}Add more${icon('chevron-down', 'menu-caret')}</button></div><div class="selected-files">${itemsHtml(selectedItems(), true)}</div>`
    : `<div class="upload-symbol">${icon('arrow-up')}</div><p>Drop files or folders here or <span class="browse-link">browse</span></p><p class="dropzone-note">Files go one by one. Each file must fit in the free space on the receiving device.</p>`;
  const list = Array.from(devices.values());
  const destination = hasFiles && list.length > 1
    ? `<label class="destination" for="destination"><span>Send to</span><span class="select-wrap"><select id="destination">${list.map((device) => `<option value="${escapeHtml(device.id)}" ${selectedPeer === device.id ? 'selected' : ''}>${escapeHtml(device.name)}</option>`).join('')}</select>${icon('chevron-down')}</span></label>`
    : '';
  const action = hasFiles ? (list.length ? 'send' : 'pair') : 'add-menu';
  const label = isSending ? 'Sending' : hasFiles ? list.length ? `Send ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}${list.length === 1 ? ` to ${escapeHtml(list[0].name)}` : ''}` : 'Connect a device to send' : 'Add files or folders';
  const menuAttributes = action === 'add-menu' ? ' aria-haspopup="menu" aria-expanded="false"' : '';
  sendFooter.innerHTML = `${destination}<button class="primary-button send-button" data-action="${action}"${menuAttributes} ${isSending ? 'disabled' : ''}>${icon(isSending ? 'loader-circle' : action === 'send' ? 'send' : action === 'pair' ? 'link' : 'plus', isSending ? 'spin' : '')}${label}</button>`;
}

function zipCandidates(): Transfer[] {
  return transfers.filter((transfer) => transfer.direction === 'received' && transfer.status === 'complete' && !transfer.inFolder && (transfer.blob || transfer.handle) && transfer.crc !== undefined);
}

function renderReceive() {
  query('#receive-space').textContent = availableBytes === undefined ? '' : `${formatBytes(availableBytes)} free on this device`;
  const support = folderSupport();
  const folder = support === 'yes' ? destinationFolder : undefined;
  const ready = zipCandidates();
  const target = folder
    ? `<div class="receive-row"><span class="file-icon received">${icon('folder-down')}</span><div class="receive-text"><strong>Save into “${escapeHtml(folder.name)}”</strong><span>Relay writes each received file into this folder and keeps the folder structure. It never replaces a file that is already there.</span></div><div class="receive-actions"><button class="secondary-button small" data-action="choose-destination">${icon('folder-open')}Change folder</button><button class="icon-button" data-action="clear-destination" aria-label="Stop saving into ${escapeHtml(folder.name)}">${icon('x')}</button></div></div>`
    : `<div class="receive-row"><span class="file-icon received">${icon('inbox')}</span><div class="receive-text"><strong>Keep in Relay until you download</strong><span>${support === 'yes' ? 'Received files wait in the Transfers list. Choose a folder to save them straight to disk instead.' : `${folderSupportReason(support)} Received files wait in the Transfers list. Download them one by one, or all together as a ZIP file that keeps the folders.`}</span></div><div class="receive-actions">${support === 'yes' ? `<button class="secondary-button small" data-action="choose-destination">${icon('folder-open')}Choose save folder</button>` : support === 'frame' ? `<a class="secondary-button small" href="${escapeHtml(window.location.href)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}Open in a new tab</a>` : ''}</div></div>`;
  const zip = ready.length
    ? `<div class="receive-zip"><span>${ready.length} received file${ready.length > 1 ? 's' : ''} ready · ${formatBytes(ready.reduce((sum, transfer) => sum + transfer.size, 0))}</span><button class="secondary-button small" data-action="download-all" ${zipBusy ? 'disabled' : ''}>${icon(zipBusy ? 'loader-circle' : 'file-archive', zipBusy ? 'spin' : '')}Download all as ZIP</button></div>`
    : '';
  receiveBody.innerHTML = target + zip;
}

let menuTrigger: HTMLElement | undefined;
function menuItems() {
  return Array.from(addMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}
function openAddMenu(trigger: HTMLElement) {
  if (isSending) { toast('Please wait for the current transfer.', true); return; }
  menuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  addMenu.hidden = false;
  const anchor = trigger === dropzone ? dropzone.querySelector<HTMLElement>('.upload-symbol') || dropzone : trigger;
  const bounds = anchor.getBoundingClientRect();
  const width = addMenu.offsetWidth;
  const height = addMenu.offsetHeight;
  const left = Math.min(Math.max(8, bounds.left + bounds.width / 2 - width / 2), window.innerWidth - width - 8);
  const below = bounds.bottom + 6;
  addMenu.style.left = `${left}px`;
  addMenu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, bounds.top - height - 6) : below}px`;
  menuItems()[0]?.focus();
}
function closeAddMenu(restoreFocus = false) {
  if (addMenu.hidden) return;
  addMenu.hidden = true;
  const trigger = menuTrigger;
  menuTrigger = undefined;
  if (trigger?.isConnected) {
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
}

function renderDevices() {
  const unconnected = Array.from(nearby.values()).filter((device) => !devices.has(device.id));
  deviceList.innerHTML = `
    <div class="device-row"><span class="device-icon">${icon(platform.kind)}</span><div class="device-details"><h3>${escapeHtml(deviceName)}</h3><p>This device · ${platform.os} · ${platform.browser}</p></div><button class="icon-button" data-action="settings" aria-label="Rename this device">${icon('pencil')}</button></div>
    ${Array.from(devices.values()).map((device) => `<div class="device-row"><span class="device-icon connected">${icon(device.kind)}</span><div class="device-details"><h3>${escapeHtml(device.name)}</h3><p><span class="connected-label"><span class="status-dot"></span>Connected</span> · ${escapeHtml(device.os)} · ${escapeHtml(device.browser)}</p></div><button class="icon-button" data-action="disconnect" data-peer="${escapeHtml(device.id)}" aria-label="Disconnect ${escapeHtml(device.name)}">${icon('x')}</button></div>`).join('')}
    ${unconnected.map((device) => `<div class="device-row"><span class="device-icon">${icon(device.kind)}</span><div class="device-details"><h3>${escapeHtml(device.name)}</h3><p>Nearby · another tab in this browser</p></div><button class="secondary-button small" data-action="connect-nearby" data-peer="${escapeHtml(device.id)}" aria-label="Connect to ${escapeHtml(device.name)}">Connect</button></div>`).join('')}
    ${devices.size || unconnected.length ? '' : '<p class="device-empty">No other devices yet. Open Relay on another device and enter a code below.</p>'}
  `;
  const refresh = query('[data-action="refresh"]');
  refresh.innerHTML = `${icon('refresh-cw', scanActive ? 'spin' : '')}<span>${scanActive ? 'Refreshing' : 'Refresh'}</span>`;
}

function fileIcon(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|heic)$/i.test(name) ? 'file-image' : /\.(txt|pdf|docx?|md)$/i.test(name) ? 'file-text' : 'file';
}

function fileNameHtml(name: string) {
  const dot = name.lastIndexOf('.');
  const extLength = name.length - dot;
  const split = dot > 0 && extLength > 1 && extLength <= 12;
  const base = split ? name.slice(0, dot) : name;
  const ext = split ? name.slice(dot) : '';
  return `<strong class="file-name" title="${escapeHtml(name)}"><span class="file-name-base">${escapeHtml(base)}</span>${ext ? `<span class="file-name-ext">${escapeHtml(ext)}</span>` : ''}</strong>`;
}

function renderHistory() {
  const filtered = transfers.filter((transfer) => historyFilter === 'all' || transfer.direction === historyFilter);
  for (const button of document.querySelectorAll<HTMLButtonElement>('.filter-button')) {
    const active = button.dataset.filter === historyFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const count = query('#history-count');
  count.hidden = !transfers.length;
  count.textContent = String(transfers.length);
  const clear = query<HTMLButtonElement>('#clear-history');
  clear.hidden = !transfers.length;
  clear.disabled = transfers.some((transfer) => transfer.status === 'active');
  historyList.innerHTML = filtered.length
    ? filtered.map((transfer) => `<div class="transfer-row"><span class="file-icon ${transfer.direction}">${icon(fileIcon(transfer.name))}</span><div class="transfer-file">${fileNameHtml(transfer.name)}<span>${formatBytes(transfer.size)} · ${transfer.direction === 'sent' ? 'Sent to' : 'Received from'} ${escapeHtml(transfer.device)} · ${new Date(transfer.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div class="transfer-status ${transfer.status}">${transfer.status === 'active' ? `<span>${Math.round(transfer.progress)}%</span><span class="progress-track"><span style="width:${transfer.progress}%"></span></span>` : `${icon(transfer.status === 'complete' ? 'check-check' : 'x')}<span>${transfer.status === 'complete' ? 'Complete' : 'Interrupted'}</span>`}</div>${transfer.status === 'complete' && (transfer.blob || transfer.handle) ? `<button class="icon-button" data-action="download" data-id="${transfer.id}" aria-label="Download ${escapeHtml(transfer.name)}">${icon('download')}</button>` : '<span class="row-spacer"></span>'}</div>`).join('')
    : `<p class="empty">${historyFilter === 'all' ? 'No transfers yet.' : `No ${historyFilter} files yet.`}</p>`;
}

let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, error = false) {
  const element = query('#toast');
  clearTimeout(toastTimer);
  element.innerHTML = `${icon(error ? 'circle-help' : 'check')}<span>${escapeHtml(message)}</span>`;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  refreshIcons();
  toastTimer = setTimeout(() => element.classList.remove('visible'), 4200);
}

function openModal(content: string) {
  delete modalContent.dataset.offer;
  modalContent.innerHTML = `<button class="modal-close icon-button" data-action="close-modal" aria-label="Close dialog">${icon('x')}</button>${content.replace('<h2>', '<h2 id="dialog-title">')}`;
  if (!modal.open) modal.showModal();
  refreshIcons();
}

function helpModal() {
  openModal(`<h2>How it works</h2><ol class="help-steps"><li><h3>Connect</h3><p>Open this site on both devices. Enter one device’s code on the other device.</p></li><li><h3>Send</h3><p>Press “Add files or folders”, or drop them in. Pick the device and press Send.</p></li><li><h3>Accept and save</h3><p>Accept the transfer on the other device. In Receive, choose a save folder, or download the files from Transfers.</p></li></ol><p class="help-detail">You always confirm before you receive files. WebRTC encrypts transfers. A public PeerJS server only helps the devices find each other and never stores files. Keep both tabs open. Relay keeps your screen on while files move, so a phone does not lock in the middle of a transfer. Time in a background tab does not count against a transfer. There is no fixed total size limit. Files move one by one. Each file must fit in the free space on the receiving device. Relay shows that space and refuses a file that does not fit. Chrome, Edge, and Opera on a computer can save received files straight into a folder. Other browsers keep the files in Relay. Download them one by one, or all together as a ZIP file that keeps the folders. If a direct route is unavailable, the transfer can use a network relay.</p><button class="primary-button full-width" data-action="close-modal">Got it</button>`);
}

function settingsModal() {
  openModal(`<h2>Settings</h2><form id="settings-form"><label for="device-name">Device name</label><input id="device-name" name="name" value="${escapeHtml(deviceName)}" maxlength="40" required /><span class="field-hint">Other devices see this name.</span><div class="setting-row"><span>Appearance</span><button type="button" class="secondary-button small theme-selector" data-action="theme">${icon(theme === 'light' ? 'sun' : 'moon')}${theme === 'light' ? 'Light' : 'Dark'}</button></div><div class="setting-row"><span>Keep the screen on<span class="setting-note">Stops your screen turning off during a transfer.</span></span><button type="button" class="secondary-button small wake-toggle" role="switch" aria-checked="${String(keepAwake)}" aria-label="Keep the screen on" data-action="toggle-keep-awake">${icon(keepAwake ? 'sun' : 'sun-dim')}${keepAwake ? 'On' : 'Off'}</button></div><button class="primary-button full-width" type="submit">Save changes</button></form>`);
  document.querySelector<HTMLFormElement>('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.querySelector<HTMLInputElement>('#device-name')?.value.trim();
    if (!value) return;
    deviceName = value;
    localStorage.setItem('relay-name', value);
    for (const device of devices.values()) device.connection.send(helloMessage());
    broadcastPresence();
    modal.close();
    render();
    toast('Device name saved.');
  });
}

async function copyText(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    openModal(`<h2>Copy</h2><p>Select and copy the text below.</p><input class="copy-fallback" value="${escapeHtml(value)}" readonly aria-label="Text to copy" /><button class="primary-button full-width" data-action="close-modal">Done</button>`);
    document.querySelector<HTMLInputElement>('.copy-fallback')?.select();
  }
}

function addFiles(incoming: SelectedFile[]) {
  if (isSending) { toast('Please wait for the current transfer.', true); return; }
  let files = incoming;
  if (selectedFiles.length + files.length > MAX_BATCH_FILES) {
    files = files.slice(0, Math.max(0, MAX_BATCH_FILES - selectedFiles.length));
    toast(`Relay can list up to ${MAX_BATCH_FILES} files at a time. The rest were not added.`, true);
  }
  selectedFiles.push(...files);
  void refreshAvailableSpace();
  render();
}

function filesFromList(files: FileList | File[]): SelectedFile[] {
  return Array.from(files).map((file) => {
    const withPath = file as File & { webkitRelativePath?: string };
    const candidate = (withPath.webkitRelativePath || file.name).replace(/\\/g, '/');
    const path = isValidRelativePath(candidate) ? candidate : file.name;
    return { file, path };
  });
}

async function filesFromDataTransfer(dataTransfer: DataTransfer | null): Promise<SelectedFile[]> {
  if (!dataTransfer) return [];
  const items = Array.from(dataTransfer.items || []);
  const getEntry = (item: DataTransferItem) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() || null;
  const selections: SelectedFile[] = [];
  const seen = new Set<string>();
  const keyOf = (path: string, file: File) => `${path}\0${file.size}\0${file.lastModified}`;
  const push = (selection: SelectedFile) => {
    const key = keyOf(selection.path, selection.file);
    if (seen.has(key)) return;
    seen.add(key);
    selections.push(selection);
  };
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      await new Promise<void>((resolve) => {
        fileEntry.file((file) => { push({ file, path: joinRelativePath(prefix, file.name) }); resolve(); }, () => resolve());
      });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const entries = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries((value) => resolve(value), () => resolve([])));
      if (!entries.length) break;
      for (const child of entries) await walk(child, joinRelativePath(prefix, entry.name));
    }
  };
  let walked = false;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = getEntry(item);
    if (!entry) continue;
    walked = true;
    await walk(entry, '');
  }
  if (!walked) for (const selection of filesFromList(dataTransfer.files)) push(selection);
  return selections;
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('.topbar [data-action="theme"]');
  if (button) button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  const selector = document.querySelector('.theme-selector');
  if (selector) selector.innerHTML = `${icon(theme === 'dark' ? 'moon' : 'sun')}${theme === 'dark' ? 'Dark' : 'Light'}`;
  refreshIcons();
}

function focusPairing() {
  pairInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  pairInput.focus();
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || target.hasAttribute('disabled')) return;
  const action = target.dataset.action;
  if (target.tagName === 'A' && (target.getAttribute('href') || '').startsWith('#')) event.preventDefault();
  if (action !== 'add-menu') closeAddMenu();
  if (action === 'add-menu') { if (menuTrigger === target) closeAddMenu(); else { closeAddMenu(); openAddMenu(target); } }
  else if (action === 'pick-files') fileInput.click();
  else if (action === 'pick-folder') folderInput.click();
  else if (action === 'choose-destination') void pickDestination();
  else if (action === 'clear-destination') { void setDestinationFolder(undefined); toast('Received files will wait in Relay until you download them.'); }
  else if (action === 'download-all') void downloadAll();
  else if (action === 'remove-file') { selectedFiles.splice(Number(target.dataset.index), 1); render(); }
  else if (action === 'pair') focusPairing();
  else if (action === 'help') helpModal();
  else if (action === 'settings') settingsModal();
  else if (action === 'close-modal') modal.close();
  else if (action === 'theme') { theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('relay-theme', theme); applyTheme(); }
  else if (action === 'toggle-keep-awake') {
    keepAwake = !keepAwake;
    localStorage.setItem('relay-keep-awake', keepAwake ? 'on' : 'off');
    if (!keepAwake) wakeWarned = false;
    screenKeeper.setEnabled(keepAwake);
    applyWakeSetting();
    renderWake();
    toast(keepAwake ? 'Relay will keep your screen on during transfers.' : 'Relay will not keep your screen on. Keep this tab visible.');
  }
  else if (action === 'copy-code') void copyText(ownCode, 'Code copied. Enter it on your other device.');
  else if (action === 'copy-link') {
    const url = new URL(window.location.href);
    url.searchParams.set('connect', ownCode);
    url.hash = '';
    void copyText(url.href, 'Invite link copied. Open it on your other device.');
  } else if (action === 'refresh') {
    scanActive = true;
    broadcastPresence();
    if (!networkReady && peer.destroyed) initializePeer();
    else if (!networkReady && peer.disconnected) peer.reconnect();
    render();
    setTimeout(() => { scanActive = false; render(); toast(devices.size ? 'Devices are up to date.' : 'No connected devices. Use a code to connect one.'); }, 1100);
  } else if (action === 'connect-nearby' && target.dataset.peer) connectTo(target.dataset.peer.replace('relay-', ''));
  else if (action === 'disconnect' && target.dataset.peer) devices.get(target.dataset.peer)?.connection.close();
  else if (action === 'send') void sendFiles();
  else if (action === 'filter') { historyFilter = target.dataset.filter || 'all'; render(); }
  else if (action === 'clear-history') {
    transfers.splice(0);
    if (!receivers.size) void clearSessionDownloads();
    render();
    toast('Transfer history cleared.');
  } else if (action === 'download') {
    const transfer = transfers.find((item) => item.id === target.dataset.id);
    if (transfer) void downloadTransfer(transfer);
  } else if (action === 'accept-offer' || action === 'decline-offer') void respondToOffer(target.dataset.batch || '', action === 'accept-offer');
});

app.addEventListener('keydown', (event) => {
  if (event.target === dropzone && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    if (menuTrigger === dropzone) closeAddMenu(); else { closeAddMenu(); openAddMenu(dropzone); }
  }
});
document.addEventListener('keydown', (event) => {
  if (addMenu.hidden) return;
  const items = menuItems();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Escape') { event.preventDefault(); closeAddMenu(true); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === 'Tab') closeAddMenu();
});
document.addEventListener('pointerdown', (event) => {
  if (addMenu.hidden) return;
  const target = event.target as Node;
  if (addMenu.contains(target) || menuTrigger?.contains(target)) return;
  closeAddMenu();
});
window.addEventListener('resize', () => closeAddMenu());
window.addEventListener('scroll', () => closeAddMenu(), true);

app.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'destination') selectedPeer = input.value;
});
fileInput.addEventListener('change', () => {
  addFiles(filesFromList(fileInput.files || []));
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  addFiles(filesFromList(folderInput.files || []));
  folderInput.value = '';
});
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  void filesFromDataTransfer(event.dataTransfer).then((selections) => { if (selections.length) addFiles(selections); });
});

async function pickDestination() {
  const handle = await chooseDestinationFolder();
  if (!handle) return;
  await setDestinationFolder(handle);
  toast(`Received files will save into ${handle.name}.`);
  const shown = modalContent.dataset.offer;
  const offer = shown ? offers.get(shown) : undefined;
  if (offer) showOffer(offer);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function baseName(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

async function downloadTransfer(transfer: Transfer) {
  try {
    if (transfer.blob) saveBlob(transfer.blob, baseName(transfer.name));
    else if (transfer.handle) saveBlob(await transfer.handle.getFile(), transfer.savedName || baseName(transfer.name));
  } catch { toast(transfer.inFolder ? 'Relay cannot read that file now. It is still in the folder you chose.' : 'Relay cannot read that file now. Ask the sender to send it again.', true); }
}

async function downloadAll() {
  const ready = zipCandidates().reverse();
  if (!ready.length || zipBusy) return;
  zipBusy = true;
  render();
  try {
    const used = new Set<string>();
    const entries = [];
    for (const transfer of ready) {
      const data = transfer.blob || await transfer.handle?.getFile();
      if (data) entries.push({ name: uniquePath(transfer.name, used), data, crc: transfer.crc ?? 0 });
    }
    saveBlob(createZip(entries), `relay-${new Date().toISOString().slice(0, 10)}.zip`);
    toast(`The ZIP file has ${entries.length} file${entries.length > 1 ? 's' : ''}.`);
  } catch { toast('Relay could not make the ZIP file. Download the files one by one instead.', true); }
  finally { zipBusy = false; render(); }
}

query<HTMLFormElement>('#pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connectTo(normalizeCode(pairInput.value));
});
modal.addEventListener('click', (event) => {
  if (event.target === modal) {
    const bounds = modal.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) modal.close();
  }
});
modal.addEventListener('close', () => {
  const shown = modalContent.dataset.offer;
  if (shown && offers.has(shown)) void respondToOffer(shown, false);
  delete modalContent.dataset.offer;
  const pending = Array.from(offers.values())[0];
  if (pending) setTimeout(() => { if (offers.has(pending.batchId)) showOffer(pending); }, 100);
});

function helloMessage(): Message {
  return { type: 'hello', name: deviceName, kind: platform.kind, os: platform.os, browser: platform.browser };
}

function initializePeer() {
  if (peer && !peer.destroyed) peer.destroy();
  networkError = '';
  peer = new Peer(`relay-${ownCode}`, { debug: 0 });
  peer.on('open', () => {
    networkReady = true;
    networkError = '';
    render();
    broadcastPresence();
    const invite = new URLSearchParams(window.location.search).get('connect');
    if (invite) {
      const url = new URL(window.location.href);
      url.searchParams.delete('connect');
      window.history.replaceState({}, '', url);
      connectTo(normalizeCode(invite));
    }
  });
  peer.on('connection', registerConnection);
  peer.on('disconnected', () => { networkReady = false; render(); });
  peer.on('error', (error) => {
    if (error.type === 'unavailable-id') {
      ownCode = createCode();
      initializePeer();
      return;
    }
    if (error.type === 'peer-unavailable') {
      pairStatus('That device is not available. Check the code and keep Relay open on both devices.', true);
      pendingPair = '';
      toast('Device not found. Check the connection code.', true);
    } else {
      networkError = 'Connection unavailable';
      networkReady = Boolean(peer.id && !peer.disconnected && !peer.destroyed);
      pairStatus('Could not connect. Check your network and try again.', true);
      render();
    }
  });
}

function connectTo(code: string) {
  if (!/^[A-Z0-9]{6}$/.test(code)) { pairStatus('Enter the full six-character connection code.', true); return; }
  if (code === ownCode) { pairStatus('That is this device’s code. Use the code from your other device.', true); return; }
  if (!networkReady) { pairStatus('Your connection is not ready. Please wait or press Refresh.', true); return; }
  const id = `relay-${code}`;
  if (devices.has(id)) { pairStatus(''); pairInput.value = ''; toast('You are already connected to this device.'); return; }
  if (pendingPair === id) return;
  pendingPair = id;
  pairStatus('Connecting…');
  const connection = peer.connect(id, { reliable: true, serialization: 'binary' });
  registerConnection(connection);
  setTimeout(() => {
    if (pendingPair === id && !devices.has(id)) {
      pendingPair = '';
      connection.close();
      pairStatus('The connection took too long. Keep both tabs open and try again.', true);
      toast('Could not reach the other device. Try again.', true);
    }
  }, 15000);
}

function pairStatus(message: string, error = false) {
  const status = query('#pair-status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

function registerConnection(connection: DataConnection) {
  connection.on('open', () => { prepareFlowControl(connection); connection.send(helloMessage()); });
  connection.on('data', (data) => {
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    const message = data as Message;
    if (message.type === 'hello') {
      if (typeof message.name !== 'string') return;
      const existing = devices.get(connection.peer);
      if (existing && existing.connection !== connection) {
        if (existing.connection.connectionId < connection.connectionId) { connection.close(); return; }
        devices.delete(connection.peer);
        existing.connection.close();
      }
      const wasConnected = devices.has(connection.peer);
      const device: Device = {
        id: connection.peer,
        name: message.name.slice(0, 40),
        kind: ['laptop', 'smartphone', 'tablet'].includes(message.kind) ? message.kind : 'laptop',
        os: typeof message.os === 'string' ? message.os.slice(0, 20) : 'Device',
        browser: typeof message.browser === 'string' ? message.browser.slice(0, 20) : 'Browser',
        connection,
      };
      devices.set(connection.peer, device);
      if (!selectedPeer) selectedPeer = connection.peer;
      if (pendingPair === connection.peer) { pairInput.value = ''; pairStatus(''); }
      pendingPair = '';
      render();
      if (!wasConnected) toast(`${device.name} is connected.`);
    } else handleMessage(connection, message);
  });
  connection.on('close', () => {
    const device = devices.get(connection.peer);
    if (device?.connection !== connection) return;
    devices.delete(connection.peer);
    if (selectedPeer === connection.peer) selectedPeer = Array.from(devices.keys())[0] || '';
    for (const [id, receiver] of receivers) {
      if (receiver.peerId === connection.peer) {
        discardReceiver(receiver);
        receivers.delete(id);
        const transfer = transfers.find((item) => item.id === id);
        if (transfer) transfer.status = 'failed';
      }
    }
    for (const transfer of transfers) {
      if (transfer.status === 'active' && transfer.peerId === connection.peer) transfer.status = 'failed';
    }
    for (const [id, offer] of offers) if (offer.device.id === connection.peer) offers.delete(id);
    for (const [id, pending] of acceptance) {
      if (pending.peerId === connection.peer) { clearTimeout(pending.timer); pending.resolve(false); acceptance.delete(id); }
    }
    for (const [id, pending] of acknowledgements) {
      if (pending.peerId === connection.peer) { acknowledgements.delete(id); pending.settle('failed'); }
    }
    if (modalContent.dataset.offer && !offers.has(modalContent.dataset.offer)) modal.close();
    render();
    toast(`${device.name} disconnected.`, true);
  });
  connection.on('error', () => { pairStatus('The connection failed. Please try again.', true); toast('Connection interrupted. Please try again.', true); });
}

function handleMessage(connection: DataConnection, message: Message) {
  void handleMessageAsync(connection, message);
}

async function handleMessageAsync(connection: DataConnection, message: Message) {
  try {
    await handleMessageBody(connection, message);
  } catch (error) {
    console.error('Relay message handling failed:', error);
  }
}

async function handleMessageBody(connection: DataConnection, message: Message) {
  const device = devices.get(connection.peer);
  if (!device || device.connection !== connection) return;
  if (message.type === 'offer') {
    if (!isValidOffer(message) || offers.has(message.batchId)) return;
    if (receivers.size + message.files.length > MAX_BATCH_FILES || message.files.some((file) => receivers.has(file.id) || transfers.some((transfer) => transfer.id === file.id))) {
      connection.send({ type: 'declined', batchId: message.batchId });
      return;
    }
    const offer = { batchId: message.batchId, device, files: message.files.map((file) => ({ ...file })), receivedAt: Date.now() };
    offers.set(message.batchId, offer);
    if (!modal.open) showOffer(offer);
    else toast(`${device.name} wants to share ${message.files.length} file${message.files.length > 1 ? 's' : ''}. Close this dialog to review.`);
  } else if (message.type === 'accepted' || message.type === 'declined') {
    const pending = acceptance.get(message.batchId);
    if (pending?.peerId === connection.peer) { clearTimeout(pending.timer); pending.resolve(message.type === 'accepted'); acceptance.delete(message.batchId); }
  } else if (message.type === 'cancel') {
    const offer = offers.get(message.batchId);
    if (offer?.device.id === connection.peer) offers.delete(message.batchId);
    for (const [id, receiver] of receivers) {
      if (receiver.peerId === connection.peer && receiver.batchId === message.batchId) {
        discardReceiver(receiver);
        receivers.delete(id);
        const transfer = transfers.find((item) => item.id === id);
        if (transfer) transfer.status = 'failed';
      }
    }
    if (modalContent.dataset.offer === message.batchId) modal.close();
    render();
  } else if (message.type === 'chunk') {
    const receiver = receivers.get(message.id);
    if (!receiver || receiver.peerId !== connection.peer) return;
    const data = normalizeBinary(message.data);
    if (!data?.byteLength || data.byteLength !== Math.min(64 * 1024, receiver.info.size - receiver.bytes) || receiver.writeError) {
      connection.send({ type: 'failed', id: message.id });
      discardReceiver(receiver);
      receivers.delete(message.id);
      const transfer = transfers.find((item) => item.id === message.id);
      if (transfer) transfer.status = 'failed';
      render();
      return;
    }
    startReceiver(receiver);
    const chunk = data;
    receiver.crc = crc32Update(receiver.crc, new Uint8Array(chunk));
    receiver.writeChain = receiver.writeChain.then(async () => {
      if (receiver.writable) await receiver.writable.write(chunk);
      else receiver.chunks.push(chunk);
    }).catch((error: unknown) => { receiver.writeError = error instanceof Error ? error : new Error('Relay could not save the file.'); });
    receiver.bytes += data.byteLength;
    for (const item of receivers.values()) {
      if (item.peerId === connection.peer && item.batchId === receiver.batchId) item.lastSeen = Date.now();
    }
    updateProgress(message.id, receiver.info.size ? receiver.bytes / receiver.info.size * 100 : 100);
  } else if (message.type === 'end') {
    const receiver = receivers.get(message.id);
    if (!receiver || receiver.peerId !== connection.peer) return;
    const transfer = transfers.find((item) => item.id === message.id);
    if (transfer) {
      if (receiver.bytes === receiver.info.size) {
        try {
          startReceiver(receiver);
          await receiver.writeChain;
          if (receiver.writeError) throw receiver.writeError;
          if (receiver.writable) await receiver.writable.close();
          else transfer.blob = new Blob(receiver.chunks, { type: receiver.info.mime || 'application/octet-stream' });
          receiver.chunks = [];
          transfer.crc = receiver.crc;
          transfer.status = 'complete';
          transfer.progress = 100;
          connection.send({ type: 'complete', id: message.id });
          toast(transfer.inFolder ? `${baseName(transfer.name)} is saved in ${receiver.batch.folder?.name ?? 'your folder'}.` : `${baseName(transfer.name)} arrived.`);
        } catch {
          await receiver.discard?.().catch(() => undefined);
          transfer.status = 'failed';
          connection.send({ type: 'failed', id: message.id });
          toast(`Relay could not save ${receiver.info.name}. Check the free space and try again.`, true);
        }
      } else { transfer.status = 'failed'; connection.send({ type: 'failed', id: message.id }); }
    }
    receivers.delete(message.id);
    render();
  } else if (message.type === 'complete' || message.type === 'failed') {
    const transfer = transfers.find((item) => item.id === message.id && item.direction === 'sent' && item.peerId === connection.peer);
    if (transfer) { transfer.status = message.type === 'complete' ? 'complete' : 'failed'; if (message.type === 'complete') transfer.progress = 100; render(); }
    const pending = acknowledgements.get(message.id);
    if (pending?.peerId === connection.peer) { acknowledgements.delete(message.id); pending.settle(message.type); }
  }
}

function showOffer(offer: Offer) {
  const items = offerFiles(offer.files);
  const folders = selectedFolders(items);
  const total = offer.files.reduce((sum, file) => sum + file.size, 0);
  const over: string[] = [];
  if (availableBytes !== undefined) {
    for (const file of offer.files) if (!fitsInAvailableSpace(file.size, availableBytes)) over.push(displayName(file));
  }
  const spaceNote = availableBytes === undefined
    ? 'Relay cannot read the free space on this device, so the browser applies its own storage limit.'
    : over.length
      ? `This device has ${formatBytes(availableBytes)} free. ${over.length} file${over.length > 1 ? 's do' : ' does'} not fit and will fail. Accept only if that is fine.`
      : `This device has ${formatBytes(availableBytes)} free. Each file fits. Files move one by one.`;
  const support = folderSupport();
  const folder = support === 'yes' ? destinationFolder : undefined;
  const saveRow = `<div class="offer-save"><span class="file-icon received">${icon(folder ? 'folder-down' : 'inbox')}</span><div class="receive-text"><strong>${folder ? `Save into “${escapeHtml(folder.name)}”` : 'Keep in Relay until you download'}</strong><span>${folder ? 'Folders inside the transfer are kept.' : support === 'yes' ? 'You can choose a folder to save into.' : 'Download the files one by one, or all together as a ZIP file.'}</span></div>${support === 'yes' ? `<button class="secondary-button small" data-action="choose-destination">${icon('folder-open')}${folder ? 'Change' : 'Choose folder'}</button>` : ''}</div>`;
  openModal(`<h2>${escapeHtml(offer.device.name)} wants to send you ${offer.files.length} file${offer.files.length > 1 ? 's' : ''}</h2><p>${formatBytes(total)} in total${folders.length ? ` · ${folders.length} folder${folders.length > 1 ? 's' : ''}` : ''}. Only accept files from devices you trust.</p><div class="offer-files">${itemsHtml(items, false)}</div>${saveRow}<p class="help-detail">${spaceNote}</p><div class="offer-actions"><button class="secondary-button" data-action="decline-offer" data-batch="${escapeHtml(offer.batchId)}">No, thanks</button><button class="primary-button" data-action="accept-offer" data-batch="${escapeHtml(offer.batchId)}">${icon('arrow-down')}Accept files</button></div>`);
  modalContent.dataset.offer = offer.batchId;
}

function discardReceiver(receiver: Receiver) {
  const discard = receiver.discard;
  receiver.chunks = [];
  if (discard) void receiver.writeChain.then(discard).catch(() => undefined);
}

function startReceiver(receiver: Receiver) {
  if (receiver.started) return;
  receiver.started = true;
  receiver.writeChain = receiver.writeChain.then(() => openReceiverTarget(receiver));
}

async function openReceiverTarget(receiver: Receiver) {
  const transfer = transfers.find((item) => item.id === receiver.info.id);
  const path = displayName(receiver.info);
  const batch = receiver.batch;
  const attach = (target: SaveTarget, inFolder: boolean) => {
    receiver.writable = target.writable;
    receiver.discard = async () => {
      await target.writable.abort().catch(() => undefined);
      await target.directory.removeEntry(target.savedName).catch(() => undefined);
    };
    if (transfer) {
      transfer.handle = target.handle;
      transfer.savedName = target.savedName;
      transfer.name = target.path;
      transfer.inFolder = inFolder;
    }
  };
  if (batch.folder) {
    try { attach(await openSaveTarget(batch.folder, path, batch.used, true), true); return; } catch { /* Use browser storage instead. */ }
  }
  batch.store ??= sessionFolder(true).then((folder) => folder?.getDirectoryHandle(batch.id, { create: true })).catch(() => undefined);
  const store = await batch.store;
  if (store) {
    try { attach(await openSaveTarget(store, path, batch.storeUsed, false), false); return; } catch { /* Keep the file in memory instead. */ }
  }
  if (transfer) transfer.name = uniquePath(path, batch.used);
}

async function respondToOffer(batchId: string, accepted: boolean) {
  const offer = offers.get(batchId);
  if (!offer) return;
  offers.delete(batchId);
  if (accepted) {
    let folder = folderSupport() === 'yes' ? destinationFolder : undefined;
    if (folder && !await hasFolderAccess(folder)) {
      toast(`Relay cannot write into ${folder.name}. The files will wait in Relay instead.`, true);
      folder = undefined;
    }
    const batch: ReceiveBatch = { id: batchId, folder, used: new Set(), storeUsed: new Set() };
    for (const file of [...offer.files].reverse()) {
      receivers.set(file.id, { info: file, chunks: [], bytes: 0, peerId: offer.device.id, batchId, lastSeen: Date.now(), batch, started: false, crc: 0, writeChain: Promise.resolve() });
      transfers.unshift({ id: file.id, name: displayName(file), size: file.size, device: offer.device.name, peerId: offer.device.id, direction: 'received', status: 'active', progress: 0, time: Date.now() });
    }
    if (offer.device.connection.open) offer.device.connection.send({ type: 'accepted', batchId });
    void refreshAvailableSpace();
  } else if (offer.device.connection.open) offer.device.connection.send({ type: 'declined', batchId });
  if (modalContent.dataset.offer === batchId) modal.close();
  render();
}

function prepareFlowControl(connection: DataConnection) {
  const channel = connection.dataChannel;
  if (channel && 'bufferedAmountLowThreshold' in channel) channel.bufferedAmountLowThreshold = BUFFER_LOW;
}

function isBackpressured(connection: DataConnection): boolean {
  const channel = connection.dataChannel;
  if (channel && channel.bufferedAmount > BUFFER_HIGH) return true;
  return 'bufferSize' in connection && Number(connection.bufferSize) > 8;
}

function waitForDrain(connection: DataConnection): Promise<void> {
  const channel = connection.dataChannel;
  if (!channel) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', listener); resolve(); };
    const timer = setTimeout(listener, 1000);
    channel.addEventListener('bufferedamountlow', listener);
    if (!isBackpressured(connection)) listener();
  });
}

async function waitForRoom(connection: DataConnection) {
  const clock = createVisibleClock(() => document.visibilityState === 'visible');
  let lastBuffered = -1;
  while (isBackpressured(connection)) {
    if (!connection.open) throw new Error('The device disconnected.');
    const buffered = connection.dataChannel?.bufferedAmount ?? -1;
    if (buffered !== lastBuffered) { lastBuffered = buffered; clock.reset(); }
    if (clock.tick() > STALL_LIMIT) throw new Error('The connection stalled.');
    await waitForDrain(connection);
  }
}

function waitForAcknowledgement(id: string, connection: DataConnection): Promise<'complete' | 'failed'> {
  return new Promise((resolve, reject) => {
    const clock = createVisibleClock(() => document.visibilityState === 'visible');
    const watch = { timer: undefined as ReturnType<typeof setInterval> | undefined, settled: false };
    const stop = () => { watch.settled = true; acknowledgements.delete(id); clearInterval(watch.timer); };
    const finish = (status: 'complete' | 'failed') => {
      if (watch.settled) return;
      stop();
      resolve(status);
    };
    const abort = (message: string) => {
      if (watch.settled) return;
      stop();
      reject(new Error(message));
    };
    acknowledgements.set(id, { peerId: connection.peer, settle: finish });
    watch.timer = setInterval(() => {
      if (!connection.open) { abort('The device disconnected.'); return; }
      if (clock.tick() > ACK_LIMIT) abort('The transfer did not complete.');
    }, 250);
  });
}

let lastProgressRender = 0;
function updateProgress(id: string, progress: number) {
  const transfer = transfers.find((item) => item.id === id);
  if (transfer) transfer.progress = Math.min(99, progress);
  if (document.hidden) return;
  if (Date.now() - lastProgressRender > 150) { render(); lastProgressRender = Date.now(); }
}

async function sendFiles() {
  const device = devices.get(selectedPeer || Array.from(devices.keys())[0]);
  if (!device || !device.connection.open || !selectedFiles.length || isSending) return;
  if (selectedFiles.length > MAX_BATCH_FILES) { toast(`Please share up to ${MAX_BATCH_FILES} files at a time.`, true); return; }
  isSending = true;
  const files = [...selectedFiles];
  const batchId = crypto.randomUUID();
  const fileInfos: FileInfo[] = files.map((selection) => {
    const slash = selection.path.lastIndexOf('/');
    const baseName = slash >= 0 ? selection.path.slice(slash + 1) : selection.file.name;
    const info: FileInfo = { id: crypto.randomUUID(), name: baseName, size: selection.file.size, mime: selection.file.type };
    if (selection.path !== baseName) info.path = selection.path;
    return info;
  });
  prepareFlowControl(device.connection);
  render();
  toast(`Waiting for ${device.name} to accept.`);
  try {
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { acceptance.delete(batchId); resolve(false); }, 120000);
      acceptance.set(batchId, { peerId: device.id, resolve, timer });
      device.connection.send({ type: 'offer', batchId, files: fileInfos });
    });
    if (!accepted) {
      if (device.connection.open) device.connection.send({ type: 'cancel', batchId });
      toast('The transfer was not accepted. Your files are still selected.', true);
      return;
    }
    for (let index = 0; index < files.length; index++) {
      const selection = files[index];
      const file = selection.file;
      const info = fileInfos[index];
      transfers.unshift({ id: info.id, name: selection.path, size: info.size, device: device.name, peerId: device.id, direction: 'sent', status: 'active', progress: 0, time: Date.now() });
      render();
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (!device.connection.open) throw new Error('The device disconnected.');
        await waitForRoom(device.connection);
        const data = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        if (!device.connection.open) throw new Error('The device disconnected.');
        device.connection.send({ type: 'chunk', id: info.id, data });
        updateProgress(info.id, Math.min(file.size, offset + CHUNK_SIZE) / file.size * 100);
      }
      const acknowledged = waitForAcknowledgement(info.id, device.connection);
      device.connection.send({ type: 'end', id: info.id });
      if (await acknowledged !== 'complete') throw new Error(`The transfer of ${selection.path} did not complete.`);
    }
    selectedFiles = [];
    toast('All files arrived.');
  } catch (error) {
    if (device.connection.open) device.connection.send({ type: 'cancel', batchId });
    for (const info of fileInfos) {
      const transfer = transfers.find((item) => item.id === info.id);
      if (transfer?.status === 'active') transfer.status = 'failed';
    }
    toast(error instanceof Error && error.message.startsWith('The transfer of ') ? `${error.message} Your files are still selected, so press Send to try again.` : 'The transfer stopped. Your files are still selected, so press Send to try again.', true);
  } finally {
    isSending = false;
    for (const info of fileInfos) acknowledgements.delete(info.id);
    render();
  }
}

function broadcastPresence() {
  channel?.postMessage({ type: 'presence', sessionId, id: `relay-${ownCode}`, ...platform, deviceName, ready: networkReady });
}
if (channel) {
  channel.onmessage = (event) => {
    const data = event.data;
    if (!data || data.sessionId === sessionId) return;
    if (data.type === 'presence' && data.ready) {
      const first = !nearby.has(data.id);
      nearby.set(data.id, { id: data.id, name: data.deviceName, kind: data.kind, os: data.os, browser: data.browser, lastSeen: Date.now() });
      if (first) { broadcastPresence(); render(); }
    } else if (data.type === 'goodbye') { nearby.delete(data.id); render(); }
  };
  setInterval(() => {
    broadcastPresence();
    for (const [id, device] of nearby) if (Date.now() - device.lastSeen > 25000) { nearby.delete(id); render(); }
  }, 10000);
}
function sweepTimeouts() {
  let changed = false;
  for (const [id, offer] of offers) {
    if (Date.now() - offer.receivedAt > 120000) {
      offers.delete(id);
      if (offer.device.connection.open) offer.device.connection.send({ type: 'declined', batchId: id });
      if (modalContent.dataset.offer === id) modal.close();
    }
  }
  for (const [id, receiver] of receivers) {
    if (Date.now() - receiver.lastSeen > RECEIVER_LIMIT) {
      const transfer = transfers.find((item) => item.id === id);
      if (transfer) transfer.status = 'failed';
      discardReceiver(receiver);
      receivers.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}

setInterval(() => { if (document.visibilityState === 'visible') sweepTimeouts(); }, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const resumed = Date.now();
  for (const receiver of receivers.values()) receiver.lastSeen = resumed;
  lastProgressRender = 0;
  sweepTimeouts();
  render();
});
window.addEventListener('beforeunload', () => channel?.postMessage({ type: 'goodbye', id: `relay-${ownCode}`, sessionId }));
applyTheme();
render();
initializePeer();
void refreshAvailableSpace().then(() => render());
void restoreDestinationFolder();
if (navigator.locks) {
  void navigator.locks.request(SESSION_LOCK, () => new Promise<void>(() => undefined));
  void navigator.locks.query().then(() => removeStaleDownloads());
}
