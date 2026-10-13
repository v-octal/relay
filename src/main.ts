import Peer, { type DataConnection } from 'peerjs';
import {
  createIcons, ArrowDown, ArrowDownToLine, ArrowLeftRight, ArrowRight, ArrowUp,
  ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Copy, Download, File, FileImage, FileText, FolderOpen, Github, Globe, HardDrive,
  Infinity as InfinityIcon, Laptop, Link, LoaderCircle, LockKeyhole, Mail, Monitor,
  MonitorSmartphone, Moon, MoreHorizontal, Plus, RefreshCw, Send, Settings2,
  ShieldCheck, Smartphone, Sparkles, Sun, Tablet, Upload, Wifi, X,
} from 'lucide';
import { createCode, devicePlatform, escapeHtml, formatBytes, isValidOffer, normalizeBinary, normalizeCode } from './utils';
import './style.css';

const iconSet = {
  ArrowDown, ArrowDownToLine, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpRight,
  Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Copy, Download,
  File, FileImage, FileText, FolderOpen, Github, Globe, HardDrive, Infinity: InfinityIcon,
  Laptop, Link, LoaderCircle, LockKeyhole, Mail, Monitor, MonitorSmartphone, Moon,
  MoreHorizontal, Plus, RefreshCw, Send, Settings2, ShieldCheck, Smartphone,
  Sparkles, Sun, Tablet, Upload, Wifi, X,
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
let activeView = 'overview';
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
  <aside class="sidebar">
    <a class="brand" href="#" data-action="overview" aria-label="Relay home">${logo}<span>relay<span class="brand-dot">.</span></span></a>
    <div class="workspace-label">YOUR WORKSPACE</div>
    <nav class="main-nav" aria-label="Main navigation">
      <button class="nav-item active" data-action="overview">${icon('arrow-left-right')}<span>Overview</span><span class="nav-active-dot"></span></button>
      <button class="nav-item" data-action="devices">${icon('monitor-smartphone')}<span>My devices</span><span id="nav-device-count" class="nav-count">1</span></button>
      <button class="nav-item" data-action="history">${icon('clock-3')}<span>Transfer history</span></button>
    </nav>
    <div class="sidebar-bottom">
      <div class="privacy-note"><div class="privacy-art">${icon('shield-check')}<span class="small-spark">✦</span><span class="tiny-spark">✧</span></div><h3>Your files.<br>Your business.</h3><p>Direct transfers. Private by default.<br>Always between your devices.</p><a href="#" data-action="privacy">A better way to share ${icon('arrow-up-right')}</a></div>
      <nav class="secondary-nav" aria-label="Support"><button class="nav-item" data-action="settings">${icon('settings-2')}<span>Settings</span></button><button class="nav-item" data-action="help">${icon('circle-help')}<span>Help & getting started</span></button></nav>
      <div class="sidebar-footer"><span class="mini-logo">${logo}</span><span>A little closer together.</span><span class="version">v1.0</span></div>
    </div>
  </aside>
  <div class="workspace">
    <header class="topbar"><div class="breadcrumb">${icon('grid-placeholder')}<span>Your workspace</span><span class="breadcrumb-divider">/</span><span id="breadcrumb-view">Overview</span></div><div class="topbar-actions"><span class="network-pill"><span class="status-dot"></span>Peer-to-peer</span><button class="icon-button theme-button" data-action="theme" aria-label="Switch color theme">${icon(theme === 'dark' ? 'sun' : 'moon')}</button><button class="avatar" data-action="settings" aria-label="Device settings">Y<span></span></button></div></header>
    <main id="main"></main>
  </div>
  <dialog id="modal" aria-labelledby="dialog-title"><div id="modal-content"></div></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <input id="file-input" type="file" multiple hidden />
`;
const breadcrumbIcon = app.querySelector('[data-lucide="grid-placeholder"]');
if (breadcrumbIcon) breadcrumbIcon.outerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="3" width="5" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/><rect x="12" y="3" width="5" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="12" width="5" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/><rect x="12" y="12" width="5" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/></svg>';
const main = document.querySelector<HTMLElement>('#main');
const modal = document.querySelector<HTMLDialogElement>('#modal');
const modalContent = document.querySelector<HTMLDivElement>('#modal-content');
const fileInput = document.querySelector<HTMLInputElement>('#file-input');
if (!main || !modal || !modalContent || !fileInput) throw new Error('Application elements are missing.');

function refreshIcons() {
  createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.75 } });
}

function render() {
  if (!main) return;
  const connectedCount = devices.size + 1;
  for (const item of document.querySelectorAll<HTMLElement>('.main-nav .nav-item')) {
    item.classList.toggle('active', item.dataset.action === activeView);
    if (item.dataset.action === activeView) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const count = document.querySelector('#nav-device-count');
  if (count) count.textContent = String(connectedCount);
  const crumb = document.querySelector('#breadcrumb-view');
  if (crumb) crumb.textContent = activeView === 'overview' ? 'Overview' : activeView === 'devices' ? 'My devices' : 'Transfer history';
  const title = activeView === 'overview' ? 'A little less cloud.' : activeView === 'devices' ? 'Together is better.' : 'Every file has a journey.';
  const subtitle = activeView === 'overview' ? 'A lot more connection. Send files straight to your devices.' : activeView === 'devices' ? 'Your devices, one connection away. No cables required.' : 'A little history of the things you share.';
  main.innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">${activeView === 'overview' ? 'SHARE SOMETHING GOOD' : activeView === 'devices' ? 'YOUR CONNECTED WORLD' : 'THE SHORTER ROUTE'}</div><h1>${title}</h1><p>${subtitle}</p></div><button class="text-button how-button" data-action="help">${icon('circle-help')}How it works ${icon('arrow-up-right')}</button></div>
    ${activeView !== 'history' ? heroMarkup() : ''}
    ${activeView === 'overview' ? `<div class="sharing-grid">${uploadMarkup()}${devicesMarkup()}</div>${historyMarkup(false)}` : activeView === 'devices' ? `<div class="devices-page">${devicesMarkup()}<section class="card device-info-card"><div class="section-label">${icon('link')} A SIMPLE CONNECTION</div><h2>Same network.<br>New possibilities.</h2><p>Open Relay on your other device. Enter its connection code here, and share away.</p><button class="primary-button" data-action="pair">${icon('plus')} Connect a device</button><div class="info-note">${icon('lock-keyhole')}Your files go directly between devices.</div></section></div>` : historyMarkup(true)}
    <div class="trust-strip"><div>${icon('shield-check')}<span>Private by design</span></div><span class="trust-divider"></span><div>${icon('infinity')}<span>No account. No fuss.</span></div><span class="trust-divider"></span><div>${icon('zap-placeholder')}<span>Just the shortest way from A to B.</span></div></div>
    <footer class="workspace-footer"><span><span class="status-dot ${networkReady ? '' : 'pending'}"></span>${networkReady ? 'Ready when you are' : networkError ? 'Connection service unavailable' : 'Getting your connection ready'}</span><span>Made for the space between your devices. ${icon('sparkles')}</span></footer>
  `;
  const zap = main.querySelector('[data-lucide="zap-placeholder"]');
  if (zap) zap.outerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m13 3-8 10h6l-1 8 9-11h-7l1-7Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  refreshIcons();
  const dropzone = document.querySelector('#dropzone');
  dropzone?.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    addFiles(Array.from((event as DragEvent).dataTransfer?.files || []));
  });
}

function heroMarkup() {
  return `<section class="hero-banner"><div class="hero-copy"><span class="hero-tag"><span></span>LESS UPLOADING. MORE SHARING.</span><h2>Big files. Short journeys.</h2><p>From your screen to theirs.<br>As simple as it should be.</p><div class="hero-features"><span>${icon('lock-keyhole')}No cloud storage</span><span class="hero-feature-dot">·</span><span>${icon('wifi')}Device to device</span></div></div><div class="hero-art" aria-hidden="true"><svg viewBox="0 0 470 214" fill="none"><defs><linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#E0D6F8"/><stop offset="1" stop-color="#F4EEFF"/></linearGradient><linearGradient id="phone" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#F6D8C4"/><stop offset="1" stop-color="#F9EADF"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#B6A294" flood-opacity=".13"/></filter></defs><circle cx="287" cy="111" r="87" stroke="#EADDD0" stroke-dasharray="3 6"/><circle cx="287" cy="111" r="65" stroke="#EADDD0"/><circle cx="287" cy="111" r="42" fill="#F2E8DF"/><path d="M171 131c48 0 47-54 96-54s42 61 96 61" stroke="#B5A0D6" stroke-width="2" stroke-dasharray="5 6"/><g transform="rotate(-9 133 108)" filter="url(#shadow)"><rect x="75" y="49" width="124" height="88" rx="8" fill="#FEFCFA" stroke="#A99DB6" stroke-width="2"/><rect x="82" y="56" width="110" height="73" rx="4" fill="url(#screen)"/><path d="M65 139h144l-11 11H76l-11-11Z" fill="#FEFCFA" stroke="#A99DB6" stroke-width="2" stroke-linejoin="round"/><path d="M121 139h31" stroke="#A99DB6" stroke-width="2" stroke-linecap="round"/><circle cx="137" cy="92" r="18" fill="#FFF" fill-opacity=".7"/><path d="M137 100V84m-6 6 6-6 6 6" stroke="#8972BB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g><g transform="rotate(12 360 118)" filter="url(#shadow)"><rect x="327" y="62" width="66" height="118" rx="12" fill="#FFFCF7" stroke="#AA9B92" stroke-width="2"/><rect x="333" y="69" width="54" height="104" rx="7" fill="url(#phone)"/><path d="M349 69h22" stroke="#AA9B92" stroke-width="3.5" stroke-linecap="round"/><circle cx="360" cy="121" r="16" fill="#FFF" fill-opacity=".7"/><path d="M360 113v16m-6-6 6 6 6-6" stroke="#B38B75" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g><g transform="rotate(10 250 52)" filter="url(#shadow)"><rect x="229" y="27" width="39" height="47" rx="7" fill="#FFFDF9"/><path d="M253 27v12h15" fill="#E5D9C8"/><path d="m253 27 15 12" stroke="#F1E9DF"/><rect x="237" y="47" width="23" height="17" rx="3" fill="#E2D4EB"/><circle cx="244" cy="52" r="2" fill="#AD91C6"/><path d="m238 62 7-7 5 4 4-4 5 7" fill="#AD91C6"/></g><g transform="rotate(-12 271 171)" filter="url(#shadow)"><rect x="248" y="150" width="47" height="39" rx="7" fill="#FFFDF9"/><path d="M258 160h26m-26 7h26m-26 7h16" stroke="#8DA795" stroke-width="2.5" stroke-linecap="round"/></g><circle cx="285" cy="105" r="20" fill="#8671B9"/><path d="M274 101h20m-5-5 5 5-5 5m-15 4h20m-15-5-5 5 5 5" stroke="#FFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m210 106 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#B5A0D6"/><path d="m405 51 2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7Z" fill="#D4AE8B"/><circle cx="208" cy="175" r="3" fill="#D2B695"/><circle cx="386" cy="30" r="3" fill="#C3B2D4"/></svg></div></section>`;
}

function uploadMarkup() {
  const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  return `<section class="card send-card"><div class="card-heading"><div class="card-title">${icon('arrow-up-right')}<h2>Send files</h2></div><span class="section-kicker">A GOOD THING TO SHARE</span></div><div id="dropzone" class="dropzone ${selectedFiles.length ? 'has-files' : ''}" ${selectedFiles.length ? '' : 'role="button" tabindex="0" aria-label="Choose files or drop files here" data-action="choose"'}>${selectedFiles.length ? `<div class="selected-header"><span>${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} ready to go</span><button class="text-button" data-action="choose">${icon('plus')}Add more</button></div><div class="selected-files">${selectedFiles.map((file, index) => `<div class="selected-file"><span class="file-icon">${icon(fileIcon(file.name))}</span><div><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div><button class="icon-button" data-action="remove-file" data-index="${index}" aria-label="Remove ${escapeHtml(file.name)}" ${isSending ? 'disabled' : ''}>${icon('x')}</button></div>`).join('')}</div><div class="selection-total">${formatBytes(totalSize)} in total <span>Good to go.</span></div>` : `<div class="upload-symbol">${icon('arrow-up')}</div><h3>Drop it like it’s a file.</h3><p>Drag and drop here, or <span class="browse-link">browse files</span></p><span class="dropzone-detail">Photos, videos, documents. All welcome.</span>`}</div>${selectedFiles.length && devices.size ? `<div class="destination-field"><label for="destination">Send to</label><div>${icon('monitor-smartphone')}<select id="destination">${Array.from(devices.values()).map((device) => `<option value="${escapeHtml(device.id)}" ${selectedPeer === device.id ? 'selected' : ''}>${escapeHtml(device.name)}</option>`).join('')}</select>${icon('chevron-down')}</div></div>` : ''}<button class="primary-button send-button" data-action="${selectedFiles.length ? devices.size ? 'send' : 'pair' : 'choose'}" ${isSending ? 'disabled' : ''}>${icon(isSending ? 'loader-circle' : selectedFiles.length && devices.size ? 'send' : 'plus', isSending ? 'spin' : '')}${isSending ? 'Transfer in progress' : selectedFiles.length ? devices.size ? `Send ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}` : 'Connect a device to send' : 'Choose files'}${icon('arrow-right')}</button><div class="card-footnote">${icon('lock-keyhole')}Your files are never stored on a server.</div></section>`;
}

function devicesMarkup() {
  const unconnected = Array.from(nearby.values()).filter((device) => !devices.has(device.id));
  return `<section class="card devices-card"><div class="card-heading"><div class="card-title">${icon('monitor-smartphone')}<h2>Your devices</h2><span class="count-badge">${devices.size + 1}</span></div><button class="text-button refresh-button" data-action="refresh">${icon('refresh-cw', scanActive ? 'spin' : '')}<span>${scanActive ? 'Refreshing' : 'Refresh'}</span></button></div><p class="section-description">One connection. Endless possibilities.</p><div class="device-list"><div class="device-row local-device"><div class="device-icon">${icon(platform.kind)}</div><div class="device-details"><h3>${escapeHtml(deviceName)}</h3><p>${platform.os}<span>·</span>${platform.browser}</p></div><span class="device-label">This device</span></div>${Array.from(devices.values()).map((device) => `<div class="device-row"><div class="device-icon connected">${icon(device.kind)}</div><div class="device-details"><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(device.os)}<span>·</span>${escapeHtml(device.browser)}</p></div><span class="connected-label"><span class="status-dot"></span>Connected</span><button class="icon-button disconnect-button" data-action="disconnect" data-peer="${escapeHtml(device.id)}" aria-label="Disconnect ${escapeHtml(device.name)}">${icon('x')}</button></div>`).join('')}${unconnected.map((device) => `<button class="device-row nearby-device" data-action="connect-nearby" data-peer="${escapeHtml(device.id)}"><div class="device-icon">${icon(device.kind)}</div><div class="device-details"><h3>${escapeHtml(device.name)}</h3><p>Nearby browser session</p></div><span class="connect-label">Connect ${icon('arrow-up-right')}</span></button>`).join('')}</div><button class="connect-device" data-action="pair"><span class="connect-icon">${icon('plus')}</span><span><strong>Connect another device</strong><span>A small code. A whole new connection.</span></span>${icon('chevron-right')}</button><div class="connection-code-row"><span>Your connection code</span><button class="code-copy" data-action="copy-code" aria-label="Copy connection code">${ownCode.slice(0, 3)} ${ownCode.slice(3)} ${icon('copy')}</button></div><div class="network-note">${icon('wifi')}<span>Same Wi-Fi? You’re in the right place.</span><span class="status-dot"></span></div></section>`;
}

function fileIcon(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|heic)$/i.test(name) ? 'file-image' : /\.(txt|pdf|docx?|md)$/i.test(name) ? 'file-text' : 'file';
}

function historyMarkup(full: boolean) {
  const filtered = transfers.filter((transfer) => historyFilter === 'all' || transfer.direction === historyFilter);
  const list = full ? filtered : transfers.slice(0, 4);
  return `<section class="card history-card ${full ? 'full-history' : ''}"><div class="card-heading"><div class="card-title">${icon('clock-3')}<h2>Recent transfers</h2>${transfers.length ? `<span class="count-badge">${transfers.length}</span>` : ''}</div>${full ? `<button class="text-button" data-action="clear-history" ${transfers.some((transfer) => transfer.status === 'active') ? 'disabled' : ''}>Clear history</button>` : `<button class="text-button" data-action="history">View all ${icon('arrow-up-right')}</button>`}</div>${full ? `<div class="history-filters"><button class="filter-button ${historyFilter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">All transfers</button><button class="filter-button ${historyFilter === 'sent' ? 'active' : ''}" data-action="filter" data-filter="sent">${icon('arrow-up-right')}Sent</button><button class="filter-button ${historyFilter === 'received' ? 'active' : ''}" data-action="filter" data-filter="received">${icon('arrow-down')}Received</button></div>` : ''}${list.length ? `<div class="transfer-table"><div class="table-head"><span>FILE</span><span>DEVICE</span><span>STATUS</span><span>TIME</span><span></span></div>${list.map((transfer) => `<div class="transfer-row"><div class="transfer-file"><span class="file-icon ${transfer.direction === 'received' ? 'received' : ''}">${icon(fileIcon(transfer.name))}</span><div><strong>${escapeHtml(transfer.name)}</strong><span>${formatBytes(transfer.size)} <span class="transfer-direction">· ${transfer.direction === 'sent' ? 'Sent' : 'Received'}</span></span></div></div><div class="transfer-device">${icon(transfer.direction === 'sent' ? 'arrow-up-right' : 'arrow-down')}<span>${escapeHtml(transfer.device)}</span></div><div class="transfer-status ${transfer.status}">${transfer.status === 'active' ? `<span>${Math.round(transfer.progress)}%</span><div class="progress-track"><div style="width:${transfer.progress}%"></div></div>` : `${icon(transfer.status === 'complete' ? 'check-check' : 'x')}${transfer.status === 'complete' ? 'Complete' : 'Interrupted'}`}</div><div class="transfer-time">${new Date(transfer.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><div>${transfer.url ? `<button class="icon-button download-button" data-action="download" data-id="${transfer.id}" aria-label="Download ${escapeHtml(transfer.name)}">${icon('download')}</button>` : ''}</div></div>`).join('')}</div>` : `<div class="empty-history"><div class="empty-file-art"><span class="empty-sheet back"></span><span class="empty-sheet front">${icon('arrow-left-right')}</span><span class="empty-spark">✦</span></div><div><h3>${historyFilter === 'all' ? 'Nothing here. Yet.' : `No ${historyFilter} files. Yet.`}</h3><p>Your next great transfer starts above.</p></div><span class="empty-history-note">A clean slate. A fresh start.</span></div>`}</section>`;
}

let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, error = false) {
  const element = document.querySelector('#toast');
  if (!element) return;
  clearTimeout(toastTimer);
  element.innerHTML = `${icon(error ? 'circle-help' : 'check')}<span>${escapeHtml(message)}</span>`;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  refreshIcons();
  toastTimer = setTimeout(() => element.classList.remove('visible'), 4200);
}

function openModal(content: string, className = '') {
  if (!modal || !modalContent) return;
  delete modalContent.dataset.offer;
  modalContent.innerHTML = `<button class="modal-close icon-button" data-action="close-modal" aria-label="Close dialog">${icon('x')}</button>${content.replace('<h2>', '<h2 id="dialog-title">')}`;
  modal.className = className;
  if (!modal.open) modal.showModal();
  refreshIcons();
}

function pairModal() {
  openModal(`<div class="modal-symbol">${icon('monitor-smartphone')}</div><span class="eyebrow">A SMALL CODE. A BIG CONNECTION.</span><h2>Bring your devices closer.</h2><p>Open Relay on your other device to connect.</p><div class="pair-own-code"><span>Your device’s connection code</span><button class="large-code" data-action="copy-code">${ownCode.slice(0, 3)} <span>${ownCode.slice(3)}</span>${icon('copy')}</button><button class="text-button" data-action="copy-link">${icon('link')}Copy an invite link</button></div><div class="modal-separator"><span></span>OR CONNECT TO A DEVICE<span></span></div><form id="pair-form"><label for="pair-code">Enter the other device’s code</label><div class="pair-input-row"><input id="pair-code" name="code" placeholder="ABC 123" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" required /><button class="primary-button" type="submit">Connect ${icon('arrow-right')}</button></div><p id="pair-status" class="form-status">${networkError ? 'The connection service is unavailable. Try Refresh.' : !networkReady ? 'Please wait while your connection gets ready.' : 'Keep both devices open on Relay.'}</p></form><div class="modal-privacy">${icon('shield-check')}A public service pairs devices. Your files transfer directly.</div>`);
  document.querySelector<HTMLFormElement>('#pair-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#pair-code');
    if (input) connectTo(normalizeCode(input.value));
  });
}

function helpModal(privacy = false) {
  openModal(`<div class="modal-symbol">${icon(privacy ? 'shield-check' : 'sparkles')}</div><span class="eyebrow">${privacy ? 'YOUR FILES. YOUR BUSINESS.' : 'FEWER STEPS. MORE CONNECTION.'}</span><h2>${privacy ? 'A more direct way to share.' : 'From here to there, in three.'}</h2><p>${privacy ? 'Your files stay between the devices you choose.' : 'No account, no cables, no cloud storage.'}</p><div class="help-steps"><div><span>01</span><div><h3>Make a connection</h3><p>Open this site on both devices. Select “Connect another device” and enter the other device’s code.</p></div></div><div><span>02</span><div><h3>Pick something to share</h3><p>Drop your files here, select the connected device, and press Send. Any file type works.</p></div></div><div><span>03</span><div><h3>Accept. Download. Done.</h3><p>Accept the transfer on the other device. Use the download button to save each file.</p></div></div></div><div class="help-detail">${icon('lock-keyhole')}<p>WebRTC encrypts transfers. PeerJS provides public connection signaling, not file storage. Relay does not automatically discover devices across your Wi-Fi. Codes connect them instead. Keep both tabs open. Each transfer supports up to 2 GB, within available browser memory. Transfers can use a network relay if a direct route is unavailable.</p></div><button class="primary-button full-width" data-action="close-modal">Sounds good ${icon('check')}</button>`);
}

function settingsModal() {
  openModal(`<div class="modal-symbol">${icon('settings-2')}</div><h2>Make yourself at home.</h2><p>A few little things to make Relay yours.</p><form id="settings-form"><label for="device-name">Device name</label><input id="device-name" name="name" value="${escapeHtml(deviceName)}" maxlength="40" required /><span class="field-hint">This is the name your other devices see.</span><div class="setting-row"><div><h3>Appearance</h3><p>A different light for your workspace.</p></div><button type="button" class="theme-selector" data-action="theme">${icon(theme === 'light' ? 'sun' : 'moon')}${theme === 'light' ? 'Light' : 'Dark'}</button></div><div class="setting-row"><div><h3>Ask before a transfer</h3><p>You always choose which files to accept.</p></div><span class="setting-enabled">${icon('shield-check')}Always on</span></div><button class="primary-button full-width" type="submit">Save changes ${icon('check')}</button></form>`);
  document.querySelector<HTMLFormElement>('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.querySelector<HTMLInputElement>('#device-name')?.value.trim();
    if (!value) return;
    deviceName = value;
    localStorage.setItem('relay-name', value);
    for (const device of devices.values()) device.connection.send(helloMessage());
    broadcastPresence();
    modal?.close();
    render();
    toast('Your device has a new name.');
  });
}

async function copyText(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    openModal(`<div class="modal-symbol">${icon('copy')}</div><h2>Copy your connection.</h2><p>Select and copy the text below.</p><input class="copy-fallback" value="${escapeHtml(value)}" readonly aria-label="Text to copy" /><button class="primary-button full-width" data-action="close-modal">Done</button>`);
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
  const button = document.querySelector('.theme-button');
  if (button) button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  const selector = document.querySelector('.theme-selector');
  if (selector) selector.innerHTML = `${icon(theme === 'dark' ? 'moon' : 'sun')}${theme === 'dark' ? 'Dark' : 'Light'}`;
  refreshIcons();
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || target.hasAttribute('disabled')) return;
  const action = target.dataset.action;
  if (target.tagName === 'A') event.preventDefault();
  if (action === 'overview' || action === 'devices' || action === 'history') {
    activeView = action;
    historyFilter = 'all';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (action === 'choose') fileInput?.click();
  else if (action === 'remove-file') { selectedFiles.splice(Number(target.dataset.index), 1); render(); }
  else if (action === 'pair') pairModal();
  else if (action === 'help' || action === 'privacy') helpModal(action === 'privacy');
  else if (action === 'settings') settingsModal();
  else if (action === 'close-modal') modal?.close();
  else if (action === 'theme') { theme = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('relay-theme', theme); applyTheme(); }
  else if (action === 'copy-code') void copyText(ownCode, 'Connection code copied. Share it with your other device.');
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
    setTimeout(() => { scanActive = false; render(); toast(devices.size ? 'Your devices are up to date.' : 'All set. Use a code to connect another device.'); }, 1100);
  } else if (action === 'connect-nearby' && target.dataset.peer) connectTo(target.dataset.peer.replace('relay-', ''));
  else if (action === 'disconnect' && target.dataset.peer) devices.get(target.dataset.peer)?.connection.close();
  else if (action === 'send') void sendFiles();
  else if (action === 'filter') { historyFilter = target.dataset.filter || 'all'; render(); }
  else if (action === 'clear-history') {
    for (const transfer of transfers) if (transfer.url) URL.revokeObjectURL(transfer.url);
    transfers.splice(0);
    render();
    toast('A fresh start. Transfer history cleared.');
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
  if (event.target instanceof HTMLElement && event.target.id === 'dropzone' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    fileInput?.click();
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
  if (code === ownCode) { pairStatus('That’s this device. Use the code from your other device.', true); return; }
  if (!networkReady) { pairStatus('Your connection is not ready. Please wait or try Refresh.', true); return; }
  const id = `relay-${code}`;
  if (devices.has(id)) { modal?.close(); toast('You are already connected to this device.'); return; }
  if (pendingPair === id) return;
  pendingPair = id;
  pairStatus('Making a little connection…');
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
  const status = document.querySelector('#pair-status');
  if (status) { status.textContent = message; status.classList.toggle('error', error); }
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
      pendingPair = '';
      if (document.querySelector('#pair-form')) modal?.close();
      render();
      if (!wasConnected) toast(`${device.name} is connected. Share something good.`);
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
    if (modalContent?.dataset.offer && !offers.has(modalContent.dataset.offer)) modal?.close();
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
    if (!modal?.open) showOffer(offer);
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
    if (modalContent?.dataset.offer === message.batchId) modal?.close();
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
  openModal(`<div class="modal-symbol">${icon('arrow-down-to-line')}</div><span class="eyebrow">SOMETHING GOOD, COMING YOUR WAY</span><h2>${escapeHtml(offer.device.name)} wants to share.</h2><p>${offer.files.length} file${offer.files.length > 1 ? 's' : ''} · ${formatBytes(offer.files.reduce((sum, file) => sum + file.size, 0))} · Direct to this device</p><div class="offer-files">${offer.files.map((file) => `<div class="selected-file"><span class="file-icon">${icon(fileIcon(file.name))}</span><div><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span></div></div>`).join('')}</div><div class="offer-actions"><button class="secondary-button" data-action="decline-offer" data-batch="${escapeHtml(offer.batchId)}">No, thanks</button><button class="primary-button" data-action="accept-offer" data-batch="${escapeHtml(offer.batchId)}">Accept files ${icon('arrow-down')}</button></div><div class="modal-privacy">${icon('shield-check')}Only accept files from devices you trust.</div>`);
  if (modalContent) modalContent.dataset.offer = offer.batchId;
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
  modal?.close();
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
  toast(`Waiting for ${device.name} to accept your files.`);
  try {
    const accepted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { acceptance.delete(batchId); resolve(false); }, 120000);
      acceptance.set(batchId, { peerId: device.id, resolve, timer });
      device.connection.send({ type: 'offer', batchId, files: fileInfos });
    });
    if (!accepted) {
      if (device.connection.open) device.connection.send({ type: 'cancel', batchId });
      toast('The transfer was not accepted. Your files are still ready.', true);
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
    toast('Your files arrived. A little closer together.');
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
      if (modalContent?.dataset.offer === id) modal?.close();
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
