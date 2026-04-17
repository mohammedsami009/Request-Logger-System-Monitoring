/**
 * Request Logger + System Monitor
 * Backend: Node.js + Express
 *
 * DEPLOYMENT NOTE:
 * We bind to '0.0.0.0' instead of 'localhost' (127.0.0.1) because:
 *   - 'localhost' only accepts connections from the same machine.
 *   - On AWS EC2, the public IP and internal IP are different. 
 *     Binding to '0.0.0.0' tells Node to accept connections on ALL
 *     network interfaces — including the EC2 public-facing NIC.
 *   - Without this, the server would be completely unreachable from
 *     the internet even if the security group ports are open.
 */

const express = require('express');
const os = require('os');
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0'; // Required for EC2 — see note above

// ---------------------------------------------------------------------------
// IN-MEMORY REQUEST LOG STORE
// ---------------------------------------------------------------------------
/**
 * Why in-memory?
 *   - No database dependency → zero setup, instant start.
 *   - Perfectly suited for short-lived monitoring sessions.
 *
 * Limitations:
 *   - Logs are lost when the server restarts.
 *   - Not suitable for multi-instance deployments (each instance has its own array).
 *   - Not durable — a crash wipes everything.
 *
 * For production, swap this out for Redis, a DB write, or a log file.
 */
const MAX_LOGS = 50;
const requestLogs = []; // [ { method, url, timestamp, ip } ]

// ---------------------------------------------------------------------------
// MIDDLEWARE — Global Request Logger
// ---------------------------------------------------------------------------
/**
 * How it works:
 *   Express middleware runs as a chain. Every incoming request passes through
 *   this function BEFORE reaching any route handler. We capture four fields:
 *     - method    : HTTP verb (GET, POST, …)
 *     - url       : full request path + query string
 *     - timestamp : ISO-8601 wall-clock time at the moment of arrival
 *     - ip        : client IP — sourced from x-forwarded-for header first
 *                   (set by load balancers / proxies like ALB on EC2) then
 *                   falling back to the raw socket remote address.
 *
 *   After logging we call next() to hand control to the next middleware/route.
 *   Without next() the request would hang forever.
 */
app.use((req, res, next) => {
  const entry = {
    method: req.method,
    url: req.originalUrl,
    timestamp: new Date().toISOString(),
    // x-forwarded-for is set by AWS ALB / CloudFront; fall back to socket IP
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
  };

  requestLogs.push(entry);

  // Keep only the last MAX_LOGS entries — slice from the end
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.shift(); // remove oldest entry (O(n) acceptable for 50 items)
  }

  next();
});

// ---------------------------------------------------------------------------
// ROUTE: GET / — always returns JSON (API root)
// ---------------------------------------------------------------------------
// Defined BEFORE static middleware so API clients (curl, Postman) always
// receive the JSON health-check. Browsers wanting the dashboard should visit /dashboard.
app.get('/', (req, res) => {
  res.json({ message: 'Server running on EC2' });
});

// Serve dashboard at /dashboard (explicit, avoids root ambiguity)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Serve the /client directory as static files (css, js, etc.)
app.use(express.static(path.join(__dirname, '..', 'client')));

// ---------------------------------------------------------------------------
// HELPER — CPU Load Average
// ---------------------------------------------------------------------------
/**
 * os.loadavg() returns 3 values: 1-min, 5-min, 15-min load averages.
 * These are UNIX-style averages — NOT available on Windows (returns [0,0,0]).
 * On Linux EC2 instances this works correctly.
 *
 * We use the 1-minute average normalised by CPU count:
 *   ratio = loadavg[0] / cpuCount
 *   ratio > 0.8  → HIGH (80 %+ of all cores saturated)
 *   ratio > 0.5  → MEDIUM
 *   otherwise    → LOW
 */
function getCpuLoad() {
  const cores = os.cpus().length;
  const [oneMin] = os.loadavg();
  const ratio = oneMin / (cores || 1);
  if (ratio > 0.8) return { level: 'HIGH', ratio: +ratio.toFixed(2) };
  if (ratio > 0.5) return { level: 'MEDIUM', ratio: +ratio.toFixed(2) };
  return { level: 'LOW', ratio: +ratio.toFixed(2) };
}



// ---------------------------------------------------------------------------
// ROUTE: GET /info — Server Metrics
// ---------------------------------------------------------------------------
/**
 * Difference between SERVER metrics (this endpoint) vs CLIENT data:
 *   - Server metrics live on the machine running Node.js. They describe
 *     the host OS: RAM, CPU, uptime, hostname. The client (browser) has
 *     NO access to these natively — they must be fetched via the API.
 *   - Client data comes from the browser environment: navigator.*, screen.*,
 *     localStorage, etc. The server has NO access to client-side data
 *     unless the client explicitly sends it (e.g. in a POST body).
 *
 * This distinction matters for security: never expose sensitive server
 * info to untrusted clients in a real production system.
 */
app.get('/info', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: Math.floor(os.uptime()),
    totalMemoryMB: (totalMem / 1024 / 1024).toFixed(1),
    freeMemoryMB: (freeMem / 1024 / 1024).toFixed(1),
    usedMemoryMB: (usedMem / 1024 / 1024).toFixed(1),
    memoryUsagePercent: ((usedMem / totalMem) * 100).toFixed(1),
    cpuModel: os.cpus()[0]?.model || 'N/A',
    cpuCores: os.cpus().length,
    cpuLoad: getCpuLoad(),
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /logs — Last 50 Request Logs
// ---------------------------------------------------------------------------
app.get('/logs', (req, res) => {
  // Return a shallow copy reversed so newest entries appear first
  res.json({
    total: requestLogs.length,
    limit: MAX_LOGS,
    logs: [...requestLogs].reverse(),
  });
});

// ---------------------------------------------------------------------------
// ROUTE: GET /status — Anomaly Detection
// ---------------------------------------------------------------------------
/**
 * Anomaly Detection Logic:
 *
 *  TRAFFIC classification:
 *    - Count requests in the last 10 seconds from the in-memory log array.
 *    - HIGH   : > 50 requests in 10 s  (5 req/s sustained — unusual for 1 user)
 *    - NORMAL : 10–50 requests in 10 s
 *    - LOW    : < 10 requests in 10 s
 *
 *  SERVER LOAD classification (via CPU):
 *    - CRITICAL : HIGH traffic AND HIGH cpu load (server is overwhelmed)
 *    - WARNING  : HIGH cpu load only (background process or spike)
 *    - STABLE   : everything within normal thresholds
 *
 *  The combined message gives operators a single sentence to read.
 */
app.get('/status', (req, res) => {
  const now = Date.now();
  const windowMs = 10 * 1000; // 10-second sliding window

  // Count log entries within the window
  const recentCount = requestLogs.filter(
    (entry) => now - new Date(entry.timestamp).getTime() < windowMs
  ).length;

  // Traffic tier
  let traffic;
  if (recentCount > 50) traffic = 'HIGH';
  else if (recentCount >= 10) traffic = 'NORMAL';
  else traffic = 'LOW';

  // CPU tier
  const cpu = getCpuLoad();
  const highCpu = cpu.level === 'HIGH';
  const highTraffic = traffic === 'HIGH';

  // Server load tier
  let serverLoad;
  let message;

  if (highTraffic && highCpu) {
    serverLoad = 'CRITICAL';
    message = `Server is overwhelmed — ${recentCount} requests in the last 10s with CPU load ratio ${cpu.ratio}. Consider scaling.`;
  } else if (highCpu) {
    serverLoad = 'WARNING';
    message = `CPU load is elevated (ratio ${cpu.ratio}). Monitor closely — may degrade under traffic.`;
  } else if (highTraffic) {
    serverLoad = 'WARNING';
    message = `High traffic detected (${recentCount} req/10s) but CPU is coping. Watch for latency increase.`;
  } else {
    serverLoad = 'STABLE';
    message = `All systems normal — ${recentCount} requests in the last 10s, CPU load ratio ${cpu.ratio}.`;
  }

  res.json({
    traffic,
    serverLoad,
    recentRequests: recentCount,
    cpuLoadRatio: cpu.ratio,
    message,
    checkedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`✅  Server listening on http://${HOST}:${PORT}`);
  console.log(`    Local access  : http://localhost:${PORT}`);
  console.log(`    EC2 access    : http://<your-ec2-public-ip>:${PORT}`);
  console.log(`    Dashboard     : http://localhost:${PORT}/index.html`);
});
