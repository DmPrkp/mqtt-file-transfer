import type { MqttClient } from 'mqtt';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

type MqttReceiverOptions = {
  client: MqttClient;
  topic: string;
  outputDir: string;
};

export class MqttReceiver extends EventEmitter {
  private client: MqttClient;
  private topic: string;
  private outputDir: string;
  private fileStream?: ReturnType<typeof createWriteStream>;
  private hash = createHash('sha256');
  private received = 0;
  private expectedSize = 0;
  private expectedChecksum = '';
  private fileName = '';

  constructor({ client, topic, outputDir }: MqttReceiverOptions) {
    super();
    this.client = client;
    this.topic = topic;
    this.outputDir = outputDir;

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public start() {
    this.client.subscribe(this.topic, { qos: 2 }, err => err && this.emit('error', err));

    this.client.on('message', (topic, payload) => {
      if (topic !== this.topic) return;
      if (this.tryHandleJson(payload)) return;

      this.handleChunk(payload);
    });
  }

  private tryHandleJson(payload: Buffer): boolean {
    let msg: any;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return false; // не JSON — это обычный чанк
    }

    if (msg.start) {
      this.startFile(msg.fileName, msg.size);
      return true;
    }

    if (msg.end) {
      this.finishFile(msg.checksum);
      return true;
    }

    return false;
  }

  private startFile(fileName: string, size: number) {
    this.fileName = fileName;
    this.expectedSize = size;
    this.received = 0;
    this.hash = createHash('sha256');
    const filePath = join(this.outputDir, this.fileName);
    this.fileStream = createWriteStream(filePath);
    this.emit<'start'>('start', this.fileName);
  }

  private finishFile(checksum: string) {
    this.expectedChecksum = checksum;

    if (!this.fileStream) return;

    this.fileStream.end(() => {
      const digest = this.hash.digest('hex');
      const valid = digest === this.expectedChecksum && this.received === this.expectedSize;
      if (valid) {
        this.emit('done', { fileName: this.fileName, checksum: digest });
      } else {
        this.emit(
          'error',
          new Error(
            `Checksum mismatch or size mismatch: expected ${this.expectedChecksum}/${this.expectedSize}, got ${digest}/${this.received}`,
          ),
        );
      }
    });
  }

  private handleChunk(chunk: Buffer) {
    if (!this.fileStream) return;

    this.hash.update(chunk);
    this.received += chunk.length;
    this.fileStream.write(chunk);
  }
}
