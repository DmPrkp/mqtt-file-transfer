import fs, { createReadStream } from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { MqttTransmitter, MqttReceiver } from '../src';

const MQTT_URL = 'mqtt://localhost:1883';
const TEST_TOPIC = 'test/file-transfer';
const TEST_FILE = path.join(__dirname, 'fixtures/skd_redis_backup_00004236__28_08_2025__12_01.json');
const OUTPUT_DIR = path.join(__dirname, 'downloads');

const clientTx = mqtt.connect(MQTT_URL);
const clientRx = mqtt.connect(MQTT_URL);

const receiver = new MqttReceiver({
  client: clientRx,
  topic: TEST_TOPIC,
  outputDir: OUTPUT_DIR,
});

receiver.start();

const transmitter = new MqttTransmitter({
  client: clientTx,
  topic: TEST_TOPIC,
  stream: createReadStream(TEST_FILE, { highWaterMark: 64 * 1024 }),
});

receiver.on('done', ({ checksum, fileName }: any) => {
  console.log(checksum, fileName);
  const origChecksum = require('crypto').createHash('sha256').update(fs.readFileSync(TEST_FILE)).digest('hex');

  checksum === origChecksum ? console.log('done') : process.exit(1);

  clientTx.end();
  clientRx.end();

  receiver.on('error', () => process.exit(1));
});

transmitter.start();

transmitter.on('progress', p => {
  console.log('progress', p);
});
