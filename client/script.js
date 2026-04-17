/**
 * Dashboard Script — Request Logger + System Monitor
 *
 * Architecture note (server metrics vs client data):
 *   This script runs in the BROWSER (client side). It has zero direct access
 *   to the server's OS, memory, or CPU. All server data must travel over HTTP
 *   from our Express API. The browser's own data (resolution, navigator, etc.)
 *   is available via Web APIs but is NOT what we display here — we care about
 *   the SERVER's health, not the visitor's device.
 *
 * Auto-refresh strategy:
 *   We use setInterval to trigger fetch() every REFRESH_MS milliseconds.
 *   All three endpoints (/status, /info, /logs) are fetched in parallel with
 *   Promise.allSettled so one failing endpoint doesn't block the others.
 */

'use strict';

const REFRESH_MS = 5000; // 5-second polling interval

// ──────────────────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────────────────

/** Safely query a single DOM element by ID */
const el = (id) => document.getElementById(id);

/** Format seconds into a readable uptime string: 3d 2h 15m 4s */
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** Format an ISO timestamp to a compact local time string */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Clamp a number between min and max */
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// ──────────────────────────────────────────────────────────────────────────
// Section renderers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render /status response into the Status section.
 * Applies colour-coded CSS classes (LOW, NORMAL, HIGH, STABLE, WARNING, CRITICAL)
 * that are pre-defined in style.css to avoid JS colour manipulation.
 */
function renderStatus(data) {
  // Traffic badge
  const trafficEl = el('badge-traffic');
  trafficEl.textContent = data.traffic;
  trafficEl.className = `badge ${data.traffic}`;

  // Server load badge
  const loadEl = el('badge-load');
  loadEl.textContent = data.serverLoad;
  loadEl.className = `badge ${data.serverLoad}`;

  // Supporting stats
  el('status-recent').textContent = `${data.recentRequests} req`;
  el('status-cpu-ratio').textContent = `${data.cpuLoadRatio}`;

  // Colour recent count by threshold: > 50 → red, > 10 → yellow, else green
  const recentEl = el('status-recent');
  if (data.recentRequests > 50)     recentEl.className = 'badge CRITICAL';
  else if (data.recentRequests > 10) recentEl.className = 'badge WARNING';
  else                               recentEl.className = 'badge STABLE';

  // Colour CPU ratio: > 0.8 → red, > 0.5 → yellow, else green
  const cpuEl = el('status-cpu-ratio');
  if (data.cpuLoadRatio > 0.8)      cpuEl.className = 'badge CRITICAL';
  else if (data.cpuLoadRatio > 0.5) cpuEl.className = 'badge WARNING';
  else                               cpuEl.className = 'badge STABLE';

  // Narrative message
  el('status-message').textContent = data.message;

  // Checked-at timestamp in the card header
  el('status-time').textContent = `checked at ${formatTime(data.checkedAt)}`;
}

/**
 * Render /info response into the Server Info section.
 * Memory bar width is clamped 0–100% to protect against edge-case NaN.
 */
function renderInfo(data) {
  el('info-hostname').textContent = data.hostname;
  el('info-platform').textContent = data.platform;
  el('info-uptime').textContent = formatUptime(data.uptimeSeconds);
  el('info-cpu').textContent = data.cpuModel;
  el('info-cores').textContent = data.cpuCores;
  el('info-load').textContent = `${data.cpuLoad.level} (${data.cpuLoad.ratio})`;
  el('info-mem-used').textContent = `${data.usedMemoryMB} MB`;
  el('info-mem-free').textContent = `Free: ${data.freeMemoryMB} MB`;
  el('info-mem-total').textContent = `Total: ${data.totalMemoryMB} MB`;

  const pct = parseFloat(data.memoryUsagePercent) || 0;
  el('info-mem-pct').textContent = `${pct} %`;

  // Update the progress bar fill width
  el('mem-bar-fill').style.width = `${clamp(pct, 0, 100)}%`;

  // Colour the bar: > 85% red, > 65% yellow, otherwise accent
  const fill = el('mem-bar-fill');
  if (pct > 85)      fill.style.background = 'var(--red)';
  else if (pct > 65) fill.style.background = 'var(--yellow)';
  else               fill.style.background = 'var(--accent)';
}

/**
 * Render /logs response into the Request Logs table.
 * Each row is built with createElement for XSS safety —
 * we never set innerHTML with server-supplied strings.
 */
function renderLogs(data) {
  el('log-count').textContent = `${data.total} / ${data.limit}`;

  const tbody = el('log-body');
  tbody.innerHTML = ''; // clear previous rows

  if (!data.logs || data.logs.length === 0) {
    const empty = document.createElement('tr');
    empty.innerHTML = `<td colspan="4" class="empty-state">No requests logged yet.</td>`;
    tbody.appendChild(empty);
    return;
  }

  data.logs.forEach((entry) => {
    const tr = document.createElement('tr');

    // Method cell — colour applied via CSS class on the span
    const methodTd = document.createElement('td');
    const methodSpan = document.createElement('span');
    methodSpan.className = `method ${entry.method}`;
    methodSpan.textContent = entry.method;
    methodTd.appendChild(methodSpan);

    // URL cell
    const urlTd = document.createElement('td');
    urlTd.className = 'url-cell';
    urlTd.textContent = entry.url;
    urlTd.title = entry.url; // show full URL on hover for truncated paths

    // IP cell
    const ipTd = document.createElement('td');
    ipTd.className = 'ip-cell';
    ipTd.textContent = entry.ip;

    // Timestamp cell
    const timeTd = document.createElement('td');
    timeTd.className = 'time-cell';
    timeTd.textContent = formatTime(entry.timestamp);
    timeTd.title = entry.timestamp; // show full ISO string on hover

    tr.append(methodTd, urlTd, ipTd, timeTd);
    tbody.appendChild(tr);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch all three API endpoints in parallel.
 * Promise.allSettled ensures one 500-error doesn't break the other panels.
 * We silently skip any rejected promise but log the error to the console
 * so developers can debug without spamming the UI.
 */
async function fetchAll() {
  const [statusResult, infoResult, logsResult] = await Promise.allSettled([
    fetch('/status').then((r) => r.json()),
    fetch('/info').then((r) => r.json()),
    fetch('/logs').then((r) => r.json()),
  ]);

  if (statusResult.status === 'fulfilled') {
    renderStatus(statusResult.value);
  } else {
    console.error('[status] fetch failed:', statusResult.reason);
  }

  if (infoResult.status === 'fulfilled') {
    renderInfo(infoResult.value);
  } else {
    console.error('[info] fetch failed:', infoResult.reason);
  }

  if (logsResult.status === 'fulfilled') {
    renderLogs(logsResult.value);
  } else {
    console.error('[logs] fetch failed:', logsResult.reason);
  }

  // Update the last-refreshed timestamp in the header
  el('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────────────────────

// Fetch immediately on page load, then every REFRESH_MS milliseconds
fetchAll();
setInterval(fetchAll, REFRESH_MS);
