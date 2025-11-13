import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';

import { MqttReceiver, MqttTransmitter } from '../src';
import { createInMemoryMqttPair } from './helpers/inMemoryMqttClient';

const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'sample.txt');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

async function ensureCleanDownloadDir() {
  await fs.rm(DOWNLOAD_DIR, { force: true, recursive: true });
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
}

afterEach(async () => {
  await ensureCleanDownloadDir();
});

describe('MQTT file transfer integration', () => {
  it('transfers a file and verifies checksum', async () => {
    await ensureCleanDownloadDir();

    const fileBuffer = await fs.readFile(FIXTURE_FILE);
    const expectedChecksum = createHash('sha256').update(fileBuffer).digest('hex');
    const topic = `test/file-transfer/${Date.now()}`;

    const { publisher: transmitterClient, receiver: receiverClient } = createInMemoryMqttPair();

    const receiver = new MqttReceiver({
      client: receiverClient,
      topic,
      outputDir: DOWNLOAD_DIR,
    });

    const progressEvents: string[] = [];
    receiver.start();

    const receiverDone = new Promise<{ fileName: string; checksum: string }>((resolve, reject) => {
      receiver.once('done', resolve);
      receiver.once('error', reject);
    });

    const transmitter = new MqttTransmitter({
      client: transmitterClient,
      topic,
      stream: createReadStream(FIXTURE_FILE, { highWaterMark: 8 }),
    });

    transmitter.on('progress', (value) => {
      progressEvents.push(value);
    });

    await Promise.all([receiverDone, transmitter.start()]);
    const { fileName, checksum } = await receiverDone;

    assert.equal(checksum, expectedChecksum);
    assert.ok(progressEvents.includes('100'));

    const outputPath = path.join(DOWNLOAD_DIR, fileName);
    const receivedBuffer = await fs.readFile(outputPath);
    const receivedChecksum = createHash('sha256').update(receivedBuffer).digest('hex');
    assert.equal(receivedChecksum, expectedChecksum);

    transmitterClient.end(true);
    receiverClient.end(true);
  });

  it('emits an error when the checksum does not match', async () => {
    await ensureCleanDownloadDir();

    const fileBuffer = await fs.readFile(FIXTURE_FILE);
    const topic = `test/file-transfer/${Date.now()}-mismatch`;

    const { publisher: publisherClient, receiver: receiverClient } = createInMemoryMqttPair();

    const receiver = new MqttReceiver({
      client: receiverClient,
      topic,
      outputDir: DOWNLOAD_DIR,
    });

    receiver.start();

    const errorPromise = new Promise<Error>((resolve) => {
      receiver.once('error', resolve);
    });

    let doneCalled = false;
    receiver.on('done', () => {
      doneCalled = true;
    });

    const publish = (message: any) => {
      publisherClient.publish(topic, JSON.stringify(message), { qos: 2 });
    };

    publish({ type: 'start', fileName: 'tampered.txt', size: fileBuffer.length });
    publish({ type: 'chunk', id: 1, data: fileBuffer.toString('base64') });
    publish({
      type: 'end',
      checksum: '0000000000000000000000000000000000000000000000000000000000000000',
    });

    const error = await errorPromise;
    assert.match(error.message, /Checksum mismatch/);
    assert.equal(doneCalled, false);

    publisherClient.end(true);
    receiverClient.end(true);
  });
});
