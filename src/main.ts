import Peer, { type DataConnection } from 'peerjs';
import {
  createIcons, ArrowDown, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp,
  Copy, Download, File, FileImage, FileText, Laptop, Link, LoaderCircle, Moon, Pencil, Plus,
  RefreshCw, Send, Settings2, ShieldCheck, Smartphone, Sun, Tablet, X,
} from 'lucide';
import { createCode, devicePlatform, escapeHtml, formatBytes, isValidOffer, normalizeBinary, normalizeCode } from './utils';
import './style.css';

const iconSet = {
  ArrowDown, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, CircleHelp, Copy, Download,
  File, FileImage, FileText, Laptop, Link, LoaderCircle, Moon, Pencil, Plus, RefreshCw, Send,
  Settings2, ShieldCheck, Smartphone, Sun, Tablet, X,
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
let selectedFiles: File[] = [];
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
let channel: BroadcastChannel | undefined;
try { channel = new BroadcastChannel('relay-nearby-v1'); } catch { channel = undefined; }

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
  url?: string;
}
interface Receiver {
  info: FileInfo;
  chunks: ArrayBuffer[];
  bytes: number;
  peerId: string;
  batchId: string;
  lastSeen: number;
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

const logo = `<svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="11" fill="currentColor"/><path d="M11 18h14M18 11v14M13 13l10 10M13 23l10-10" stroke="white" stroke-width="3.1" stroke-linecap="round"/></svg>`;

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#" aria-label="Relay home">${logo}<span>relay</span></a>
    <div class="topbar-actions">
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
    <section class="card history-card" aria-labelledby="history-title">
      <div class="card-heading"><h2 id="history-title">Transfers <span id="history-count" class="count-badge" hidden></span></h2><div class="history-tools"><div class="filters" role="group" aria-label="Filter transfers"><button class="filter-button" data-action="filter" data-filter="all">All</button><button class="filter-button" data-action="filter" data-filter="sent">Sent</button><button class="filter-button" data-action="filter" data-filter="received">Received</button></div><button id="clear-history" class="text-button" data-action="clear-history">Clear</button></div></div>
      <div id="history"></div>
    </section>
    <p class="footnote">${icon('shield-check')}Files go directly between devices and are never stored on a server.</p>
  </main>
  <dialog id="modal" aria-labelledby="dialog-title"><div id="modal-content"></div></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <input id="file-input" type="file" multiple hidden />
`;
const query = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const modal = query<HTMLDialogElement>('#modal');
const modalContent = query<HTMLDivElement>('#modal-content');
const fileInput = query<HTMLInputElement>('#file-input');
const dropzone = query<HTMLDivElement>('#dropzone');
const sendFooter = query<HTMLDivElement>('#send-footer');
const deviceList = query<HTMLDivElement>('#device-list');
const historyList = query<HTMLDivElement>('#history');
const pairInput = query<HTMLInputElement>('#pair-code');

function refreshIcons() {
  createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.75 } });
}

function render() {
  query('#network-status').innerHTML = `<span class="status-dot ${networkReady ? '' : networkError ? 'error' : 'pending'}"></span><span>${networkReady ? 'Ready' : networkError ? 'Offline' : 'Connecting'}</span>`;
  query('#own-code').textContent = `${ownCode.slice(0, 3)} ${ownCode.slice(3)}`;
  renderSend();
  renderDevices();
  renderHistory();
  refreshIcons();
}

function renderSend() {
  const hasFiles = selectedFiles.length > 0;
  dropzone.classList.toggle('has-files', hasFiles);
  if (hasFiles) {
    dropzone.removeAttribute('role');
    dropzone.removeAttribute('tabindex');
    dropzone.removeAttribute('aria-label');
    dropzone.removeAttribute('data-action');
  } else {
    dropzone.setAttribute('role', 'button');
    dropzone.setAttribute('tabindex', '0');
    dropzone.setAttribute('aria-label', 'Choose files or drop files here');
    dropzone.dataset.action = 'choose';
  }
  const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  dropzone.innerHTML = hasFiles
    ? `<div class="selected-header"><span>${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} · ${formatBytes(totalSize)}</span><button class="text-button" data-action="choose" ${isSending ? 'disabled' : ''}>${icon('plus')}Add more</button></div><div class="selected-files">${selectedFiles.map((file, index) => `<div class="file-row"><span class="file-icon">${icon(fileIcon(file.name))}</span><div><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><button class="icon-button" data-action="remove-file" data-index="${index}" aria-label="Remove ${escapeHtml(file.name)}" ${isSending ? 'disabled' : ''}>${icon('x')}</button></div>`).join('')}</div>`
    : `<div class="upload-symbol">${icon('arrow-up')}</div><p>Drop files here or <span class="browse-link">browse</span></p>`;
  const list = Array.from(devices.values());
  const destination = hasFiles && list.length > 1
    ? `<label class="destination" for="destination"><span>Send to</span><span class="select-wrap"><select id="destination">${list.map((device) => `<option value="${escapeHtml(device.id)}" ${selectedPeer === device.id ? 'selected' : ''}>${escapeHtml(device.name)}</option>`).join('')}</select>${icon('chevron-down')}</span></label>`
    : '';
  const action = hasFiles ? (list.length ? 'send' : 'pair') : 'choose';
  const label = isSending ? 'Sending' : hasFiles ? list.length ? `Send ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}${list.length === 1 ? ` to ${escapeHtml(list[0].name)}` : ''}` : 'Connect a device to send' : 'Choose files';
  sendFooter.innerHTML = `${destination}<button class="primary-button send-button" data-action="${action}" ${isSending ? 'disabled' : ''}>${icon(isSending ? 'loader-circle' : action === 'send' ? 'send' : action === 'pair' ? 'link' : 'plus', isSending ? 'spin' : '')}${label}</button>`;
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
    ? filtered.map((transfer) => `<div class="transfer-row"><span class="file-icon ${transfer.direction}">${icon(fileIcon(transfer.name))}</span><div class="transfer-file"><strong>${escapeHtml(transfer.name)}</strong><span>${formatBytes(transfer.size)} · ${transfer.direction === 'sent' ? 'Sent to' : 'Received from'} ${escapeHtml(transfer.device)} · ${new Date(transfer.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div class="transfer-status ${transfer.status}">${transfer.status === 'active' ? `<span>${Math.round(transfer.progress)}%</span><span class="progress-track"><span style="width:${transfer.progress}%"></span></span>` : `${icon(transfer.status === 'complete' ? 'check-check' : 'x')}<span>${transfer.status === 'complete' ? 'Complete' : 'Interrupted'}</span>`}</div>${transfer.url ? `<button class="icon-button" data-action="download" data-id="${transfer.id}" aria-label="Download ${escapeHtml(transfer.name)}">${icon('download')}</button>` : '<span class="row-spacer"></span>'}</div>`).join('')
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
  openModal(`<h2>How it works</h2><ol class="help-steps"><li><h3>Connect</h3><p>Open this site on both devices. Enter one device’s code on the other device.</p></li><li><h3>Send</h3><p>Drop your files in, pick the device, and press Send.</p></li><li><h3>Accept and download</h3><p>Accept the transfer on the other device, then download each file.</p></li></ol><p class="help-detail">You always confirm before you receive files. WebRTC encrypts transfers. A public PeerJS server only helps the devices find each other and never stores files. Keep both tabs open. Each transfer supports up to 2 GB, within available browser memory. If a direct route is unavailable, the transfer can use a network relay.</p><button class="primary-button full-width" data-action="close-modal">Got it</button>`);
}

function settingsModal() {
  openModal(`<h2>Settings</h2><form id="settings-form"><label for="device-name">Device name</label><input id="device-name" name="name" value="${escapeHtml(deviceName)}" maxlength="40" required /><span class="field-hint">Other devices see this name.</span><div class="setting-row"><span>Appearance</span><button type="button" class="secondary-button small theme-selector" data-action="theme">${icon(theme === 'light' ? 'sun' : 'moon')}${theme === 'light' ? 'Light' : 'Dark'}</button></div><button class="primary-button full-width" type="submit">Save changes</button></form>`);
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

function addFiles(files: File[]) {
  if (isSending) { toast('Please wait for the current transfer.', true); return; }
  selectedFiles.push(...files);
  render();
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
  if (target.tagName === 'A') event.preventDefault();
  if (action === 'choose') fileInput.click();
  else if (action === 'remove-file') { selectedFiles.splice(Number(target.dataset.index), 1); render(); }
  else if (action === 'pair') focusPairing();
  else if (action === 'help') helpModal();
  else if (action === 'settings') settingsModal();
  else if (action === 'close-modal') modal.close();
  else if (action === 'theme') { theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('relay-theme', theme); applyTheme(); }
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
    for (const transfer of transfers) if (transfer.url) URL.revokeObjectURL(transfer.url);
    transfers.splice(0);
    render();
    toast('Transfer history cleared.');
  } else if (action === 'download') {
    const transfer = transfers.find((item) => item.id === target.dataset.id);
    if (transfer?.url) {
      const link = document.createElement('a');
      link.href = transfer.url;
      link.download = transfer.name;
      link.click();
    }
  } else if (action === 'accept-offer' || action === 'decline-offer') respondToOffer(target.dataset.batch || '', action === 'accept-offer');
});

app.addEventListener('keydown', (event) => {
  if (event.target === dropzone && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    fileInput.click();
  }
});

app.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'destination') selectedPeer = input.value;
});
fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files || []));
  fileInput.value = '';
});
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  addFiles(Array.from(event.dataTransfer?.files || []));
});
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
  if (shown && offers.has(shown)) respondToOffer(shown, false);
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
  connection.on('open', () => connection.send(helloMessage()));
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
    if (modalContent.dataset.offer && !offers.has(modalContent.dataset.offer)) modal.close();
    render();
    toast(`${device.name} disconnected.`, true);
  });
  connection.on('error', () => { pairStatus('The connection failed. Please try again.', true); toast('Connection interrupted. Please try again.', true); });
}

function handleMessage(connection: DataConnection, message: Message) {
  const device = devices.get(connection.peer);
  if (!device || device.connection !== connection) return;
  if (message.type === 'offer') {
    if (!isValidOffer(message) || offers.has(message.batchId)) return;
    if (offers.size >= 5 || receivers.size + message.files.length > 100 || message.files.some((file) => receivers.has(file.id) || transfers.some((transfer) => transfer.id === file.id))) {
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
    if (!data?.byteLength || data.byteLength !== Math.min(64 * 1024, receiver.info.size - receiver.bytes)) {
      connection.send({ type: 'failed', id: message.id });
      receivers.delete(message.id);
      const transfer = transfers.find((item) => item.id === message.id);
      if (transfer) transfer.status = 'failed';
      render();
      return;
    }
    receiver.chunks.push(data);
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
        const blob = new Blob(receiver.chunks, { type: receiver.info.mime || 'application/octet-stream' });
        transfer.url = URL.createObjectURL(blob);
        transfer.status = 'complete';
        transfer.progress = 100;
        connection.send({ type: 'complete', id: message.id });
        toast(`${receiver.info.name} arrived. It is ready to download.`);
      } else { transfer.status = 'failed'; connection.send({ type: 'failed', id: message.id }); }
    }
    receivers.delete(message.id);
    render();
  } else if (message.type === 'complete' || message.type === 'failed') {
    const transfer = transfers.find((item) => item.id === message.id && item.direction === 'sent' && item.peerId === connection.peer);
    if (transfer) { transfer.status = message.type === 'complete' ? 'complete' : 'failed'; if (message.type === 'complete') transfer.progress = 100; render(); }
  }
}

function showOffer(offer: Offer) {
  openModal(`<h2>${escapeHtml(offer.device.name)} wants to send you ${offer.files.length} file${offer.files.length > 1 ? 's' : ''}</h2><p>${formatBytes(offer.files.reduce((sum, file) => sum + file.size, 0))} in total. Only accept files from devices you trust.</p><div class="offer-files">${offer.files.map((file) => `<div class="file-row"><span class="file-icon">${icon(fileIcon(file.name))}</span><div><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div></div>`).join('')}</div><div class="offer-actions"><button class="secondary-button" data-action="decline-offer" data-batch="${escapeHtml(offer.batchId)}">No, thanks</button><button class="primary-button" data-action="accept-offer" data-batch="${escapeHtml(offer.batchId)}">${icon('arrow-down')}Accept files</button></div>`);
  modalContent.dataset.offer = offer.batchId;
}

function respondToOffer(batchId: string, accepted: boolean) {
  const offer = offers.get(batchId);
  if (!offer) return;
  offers.delete(batchId);
  if (accepted) {
    for (const file of offer.files) {
      receivers.set(file.id, { info: file, chunks: [], bytes: 0, peerId: offer.device.id, batchId, lastSeen: Date.now() });
      transfers.unshift({ id: file.id, name: file.name, size: file.size, device: offer.device.name, peerId: offer.device.id, direction: 'received', status: 'active', progress: 0, time: Date.now() });
    }
    offer.device.connection.send({ type: 'accepted', batchId });
  } else offer.device.connection.send({ type: 'declined', batchId });
  modal.close();
  render();
}

let lastProgressRender = 0;
function updateProgress(id: string, progress: number) {
  const transfer = transfers.find((item) => item.id === id);
  if (transfer) transfer.progress = Math.min(99, progress);
  if (Date.now() - lastProgressRender > 150) { render(); lastProgressRender = Date.now(); }
}

async function sendFiles() {
  const device = devices.get(selectedPeer || Array.from(devices.keys())[0]);
  if (!device || !device.connection.open || !selectedFiles.length || isSending) return;
  if (selectedFiles.length > 100) { toast('Please share up to 100 files at a time.', true); return; }
  if (selectedFiles.reduce((sum, file) => sum + file.size, 0) > 2 ** 31) { toast('Please keep each transfer under 2 GB to protect browser memory.', true); return; }
  isSending = true;
  const files = [...selectedFiles];
  const batchId = crypto.randomUUID();
  const fileInfos = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, size: file.size, mime: file.type }));
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
      const file = files[index];
      const info = fileInfos[index];
      transfers.unshift({ id: info.id, name: info.name, size: info.size, device: device.name, peerId: device.id, direction: 'sent', status: 'active', progress: 0, time: Date.now() });
      render();
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        if (!device.connection.open) throw new Error('The device disconnected.');
        const drainStart = Date.now();
        while (device.connection.dataChannel.bufferedAmount > 1024 * 1024 || ('bufferSize' in device.connection && Number(device.connection.bufferSize) > 8)) {
          if (!device.connection.open || Date.now() - drainStart > 30000) throw new Error('The connection timed out.');
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        const data = await file.slice(offset, offset + chunkSize).arrayBuffer();
        device.connection.send({ type: 'chunk', id: info.id, data });
        updateProgress(info.id, Math.min(file.size, offset + chunkSize) / file.size * 100);
      }
      device.connection.send({ type: 'end', id: info.id });
      const completionStart = Date.now();
      while (transfers.find((item) => item.id === info.id)?.status !== 'complete') {
        if (!device.connection.open || transfers.find((item) => item.id === info.id)?.status === 'failed' || Date.now() - completionStart > 30000) throw new Error('The transfer did not complete.');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    selectedFiles = [];
    toast('All files arrived.');
  } catch {
    if (device.connection.open) device.connection.send({ type: 'cancel', batchId });
    for (const info of fileInfos) {
      const transfer = transfers.find((item) => item.id === info.id);
      if (transfer?.status === 'active') transfer.status = 'failed';
    }
    toast('The transfer stopped. Check your connection and try again.', true);
  } finally {
    isSending = false;
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
setInterval(() => {
  let changed = false;
  for (const [id, offer] of offers) {
    if (Date.now() - offer.receivedAt > 120000) {
      offers.delete(id);
      if (offer.device.connection.open) offer.device.connection.send({ type: 'declined', batchId: id });
      if (modalContent.dataset.offer === id) modal.close();
    }
  }
  for (const [id, receiver] of receivers) {
    if (Date.now() - receiver.lastSeen > 240000) {
      const transfer = transfers.find((item) => item.id === id);
      if (transfer) transfer.status = 'failed';
      receivers.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}, 10000);
window.addEventListener('beforeunload', () => channel?.postMessage({ type: 'goodbye', id: `relay-${ownCode}`, sessionId }));
applyTheme();
render();
initializePeer();
