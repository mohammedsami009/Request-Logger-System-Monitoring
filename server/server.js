/**
 * Request Logger + System Monitor
 * Backend: Node.js + Express
 */

const express = require('express');
const os = require('os');
const path = require('path');

const app = express();
const PORT = 80;
const HOST = '0.0.0.0';

// ---------------------------------------------------------------------------
// STATIC FILES (Frontend)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'client')));

// ---------------------------------------------------------------------------
// IN-MEMORY REQUEST LOG STORE
// ---------------------------------------------------------------------------
const MAX_LOGS = 50;
const requestLogs = [];

// Logging Middleware
app.use((req, res, next) => {
  const entry = {
    method: req.method,
    url: req.originalUrl,
    timestamp: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
  };

  requestLogs.push(entry);
  if (requestLogs.length > MAX_LOGS) requestLogs.shift();

  next();
});

// ---------------------------------------------------------------------------
// HELPER — CPU Load
// ---------------------------------------------------------------------------
function getCpuLoad() {
  const cores = os.cpus().length;
  const [oneMin] = os.loadavg();
  const ratio = oneMin / (cores || 1);

  if (ratio > 0.8) return { level: 'HIGH', ratio: +ratio.toFixed(2) };
  if (ratio > 0.5) return { level: 'MEDIUM', ratio: +ratio.toFixed(2) };
  return { level: 'LOW', ratio: +ratio.toFixed(2) };
}

// ---------------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------------

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

app.get('/logs', (req, res) => {
  res.json({
    total: requestLogs.length,
    limit: MAX_LOGS,
    logs: [...requestLogs].reverse(),
  });
});

app.get('/status', (req, res) => {
  const now = Date.now();
  const windowMs = 10 * 1000;

  const recentCount = requestLogs.filter(
    (entry) => now - new Date(entry.timestamp).getTime() < windowMs
  ).length;

  const cpu = getCpuLoad();

  let traffic = recentCount > 50 ? 'HIGH' : (recentCount >= 10 ? 'NORMAL' : 'LOW');

  let serverLoad = 'STABLE';
  if (traffic === 'HIGH' && cpu.level === 'HIGH') serverLoad = 'CRITICAL';
  else if (cpu.level === 'HIGH' || traffic === 'HIGH') serverLoad = 'WARNING';

  res.json({
    traffic,
    serverLoad,
    recentRequests: recentCount,
    cpuLoadRatio: cpu.ratio,
    message: `System is ${serverLoad}. Traffic is ${traffic}.`,
    checkedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// ROOT ROUTE
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ---------------------------------------------------------------------------
// CATCH-ALL ROUTE (IMPORTANT FIX)
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});