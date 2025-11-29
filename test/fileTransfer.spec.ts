import crypto from 'crypto';
import fs, { createReadStream } from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { MqttTransmitter, MqttReceiver } from '../src';

const MQTT_URL = 'mqtt://localhost:1883';
const TEST_TOPIC = 'test/file-transfer';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TEST_FILE_NAME = 'sample.json';
const TEST_FILE = path.join(FIXTURES_DIR, TEST_FILE_NAME);
const OUTPUT_DIR = path.join(__dirname, 'downloads');
const TIMEOUT_MS = 20000;

function ensureDirectories() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

function ensureFixtureFile() {
  const sampleData = {
    message: 'mqtt-file-transfer integration test payload',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(TEST_FILE, JSON.stringify(sampleData, null, 2));
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
ensureFixtureFile();

const clientTx = mqtt.connect(MQTT_URL);
const clientRx = mqtt.connect(MQTT_URL);

const receiver = new MqttReceiver({
  client: clientRx,
  topic: TEST_TOPIC,
  outputDir: OUTPUT_DIR,
});

const transmitter = new MqttTransmitter({
  client: clientTx,
  topic: TEST_TOPIC,
  stream: createReadStream(TEST_FILE, { highWaterMark: 64 * 1024 }),
});

const timer = setTimeout(() => {
  console.error(`Test timed out after ${TIMEOUT_MS}ms`);
  shutdown(1);
}, TIMEOUT_MS);

receiver.on('error', err => {
  console.error('Receiver error', err);
  clearTimeout(timer);
  shutdown(1);
});

transmitter.on('error', err => {
  console.error('Transmitter error', err);
  clearTimeout(timer);
  shutdown(1);
});

receiver.on('done', ({ checksum, fileName }: any) => {
  const origChecksum = crypto.createHash('sha256').update(fs.readFileSync(TEST_FILE)).digest('hex');

  if (checksum === origChecksum) {
    console.log('done', fileName);
    clearTimeout(timer);
    shutdown(0);
  } else {
    console.error('Checksum mismatch');
    clearTimeout(timer);
    shutdown(1);
  }
});

Promise.all([waitForConnection(clientRx), waitForConnection(clientTx)])
  .then(() => {
    receiver.start();
    transmitter.start();

    transmitter.on('progress', p => {
      console.info('progress', p);
    });
  })
  .catch(err => {
    console.error('Failed to connect to MQTT broker', err);
    clearTimeout(timer);
    shutdown(1);
  });
