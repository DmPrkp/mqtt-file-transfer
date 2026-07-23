import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { MqttReceiver } from '../src';

const MQTT_URL = 'mqtt://localhost:1883';
const TEST_TOPIC = 'test/file-transfer-order';
const OUTPUT_DIR = path.join(__dirname, 'downloads');
const TEST_FILE_NAME = 'ordered.txt';
const CHUNK_TIMEOUT_MS = 2000;
const TOLERANCE_MS = 500;
const TEST_TIMEOUT_MS = 20000;

const CHUNKS = ['Hello, ', 'this is ', 'a test.'];
const FULL_CONTENT = CHUNKS.join('');

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

function publishChunk(id: number, text: string) {
  clientTx.publish(
    TEST_TOPIC,
    JSON.stringify({ type: 'chunk', id, data: Buffer.from(text).toString('base64') }),
    { qos: 2 }
  );
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
  console.error(`Test timed out after ${TEST_TIMEOUT_MS}ms`);
  shutdown(1);
}, TEST_TIMEOUT_MS);

let lastValidChunkAt = 0;

receiver.on('error', (err: Error) => {
  const isTimeoutError = /timeout/i.test(err.message);

  if (!isTimeoutError) {
    clearTimeout(overallTimer);
    console.error('Expected chunk timeout, got:', err.message);
    shutdown(1);
    return;
  }

  clearTimeout(overallTimer);
  const elapsed = Date.now() - lastValidChunkAt;
  const withinExpectedWindow = Math.abs(elapsed - CHUNK_TIMEOUT_MS) <= TOLERANCE_MS;

  if (!withinExpectedWindow) {
    console.error(
      `Timeout fired ${elapsed}ms after last VALID chunk, expected ~${CHUNK_TIMEOUT_MS}ms — ` +
      `duplicate/out-of-order chunk incorrectly reset the timer`
    );
    shutdown(1);
    return;
  }

  console.log(
    `Out-of-order chunk correctly ignored (no timer reset). ` +
    `Timeout fired ${elapsed}ms after last valid chunk (expected ~${CHUNK_TIMEOUT_MS}ms):`,
    err.message
  );
  shutdown(0);
});

receiver.on('done', () => {
  clearTimeout(overallTimer);
  console.error('Receiver unexpectedly completed — duplicate chunk must have been written');
  shutdown(1);
});

Promise.all([waitForConnection(clientRx), waitForConnection(clientTx)])
  .then(async () => {
    await receiver.start();

    clientTx.publish(
      TEST_TOPIC,
      JSON.stringify({ type: 'start', fileName: TEST_FILE_NAME, size: FULL_CONTENT.length }),
      { qos: 2 }
    );

    await new Promise(r => setTimeout(r, 100));

    publishChunk(1, CHUNKS[0]); // id=1
    await new Promise(r => setTimeout(r, 100));

    publishChunk(2, CHUNKS[1]); // id=2
    await new Promise(r => setTimeout(r, 100));

    publishChunk(3, CHUNKS[2]); // id=3
    lastValidChunkAt = Date.now();
    await new Promise(r => setTimeout(r, 100));

    publishChunk(2, CHUNKS[1]); // id=2 skip
  })
  .catch(err => {
    console.error('Failed to connect to MQTT broker', err);
    shutdown(1);
  });