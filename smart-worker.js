const { parentPort, workerData } = require('worker_threads');
try {
  const { getAllDiskSmart } = require('./disk-smart');
  const result = getAllDiskSmart(workerData && workerData.forceRefresh);
  parentPort.postMessage({ success: true, data: result });
} catch(e) {
  parentPort.postMessage({ success: false, error: e.message, stack: e.stack });
}
