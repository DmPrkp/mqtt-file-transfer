import fs from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { MqttReceiver } from '../src';

const MQTT_URL = 'mqtt://localhost:1883';
const TEST_TOPIC = 'test/file-transfer-timeout';
const OUTPUT_DIR = path.join(__dirname, 'downloads-timeout');
const CHUNK_TIMEOUT_MS = 2000; // short timeout to keep the test fast
const TOLERANCE_MS = 500;      // allowed slack around the expected fire time
const TEST_TIMEOUT_MS = 20000;

function ensureDirectories() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function waitForConnection(client: mqtt.MqttClient) {
  return new Promise<void>((resolve, reject) => {
    const handleConnect = () => {
      cleanup();
      resolve();
    };

    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client.off('connect', handleConnect);
      client.off('error', handleError);
    };

    client.once('connect', handleConnect);
    client.once('error', handleError);
  });
}

function shutdown(code: number) {
  clientTx.end();
  clientRx.end();
  process.exit(code);
}

ensureDirectories();

const clientTx = mqtt.connect(MQTT_URL);
const clientRx = mqtt.connect(MQTT_URL);

const receiver = new MqttReceiver({
  client: clientRx,
  topic: TEST_TOPIC,
  outputDir: OUTPUT_DIR,
  props: {
    pendingChunkTimeout: CHUNK_TIMEOUT_MS,
  },
});

const overallTimer = setTimeout(() => {
  console.error(`Test timed out after ${TEST_TIMEOUT_MS}ms without the expected timeout error`);
  shutdown(1);
}, TEST_TIMEOUT_MS);

let startedAt = 0;

receiver.on('start', () => {
  startedAt = Date.now();
});

receiver.on('error', (err: Error) => {
  clearTimeout(overallTimer);

  const elapsed = Date.now() - startedAt;
  const withinExpectedWindow =
    Math.abs(elapsed - CHUNK_TIMEOUT_MS) <= TOLERANCE_MS;
  const isTimeoutError = /timeout/i.test(err.message);

  if (!isTimeoutError) {
    console.error('Expected a chunk timeout error, got:', err.message);
    shutdown(1);
    return;
  }

  if (!withinExpectedWindow) {
    console.error(
      `Timeout fired after ${elapsed}ms, expected ~${CHUNK_TIMEOUT_MS}ms (+/- ${TOLERANCE_MS}ms)`
    );
    shutdown(1);
    return;
  }

  console.log(
    `Chunk timeout fired correctly: expected ~${CHUNK_TIMEOUT_MS}ms, got ${elapsed}ms —`,
    err.message
  );
  shutdown(0);
});

receiver.on('done', () => {
  clearTimeout(overallTimer);
  console.error('Receiver unexpectedly completed a transfer that was never sent');
  shutdown(1);
});

Promise.all([waitForConnection(clientRx), waitForConnection(clientTx)])
  .then(async () => {
    await receiver.start();

    // Simulate a transmitter that announces a transfer, then stalls forever
    // (never publishes any "chunk" or "end" messages).
    clientTx.publish(
      TEST_TOPIC,
      JSON.stringify({ type: 'start', fileName: 'stalled.json', size: 1024 }),
      { qos: 2 }
    );
  })
  .catch(err => {
    console.error('Failed to connect to MQTT broker', err);
    shutdown(1);
  });