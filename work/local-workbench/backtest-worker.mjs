import { parentPort, workerData } from 'node:worker_threads';
import { runCachedBacktest } from './cache-backtest.mjs';

function requestMinutes(ranges) {
  return new Promise((resolve) => {
    const onMessage = (msg) => {
      if (msg && msg.type === 'minutes') {
        parentPort.off('message', onMessage);
        resolve(msg.minute);
      }
    };
    parentPort.on('message', onMessage);
    parentPort.postMessage({ type: 'need-minutes', ranges });
  });
}

try {
  const result = await runCachedBacktest({
    primary: workerData.primary,
    higher: workerData.higher,
    options: workerData.options,
    loadMinutes: workerData.canLoadMinutes ? requestMinutes : undefined,
    includeRawReport: false,
  });
  parentPort.postMessage({ type: 'done', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    status: error?.status || 400,
    message: error instanceof Error ? error.message : String(error),
  });
}
