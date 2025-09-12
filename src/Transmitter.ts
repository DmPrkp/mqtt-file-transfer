import type { MqttClient } from 'mqtt';
import { ReadStream, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { basename } from 'path';

const DEFAULT_PROCESS_INTERVAL = 1000;

export type MqttTransmitterOptions = {
  client: MqttClient;
  topic: string;
  stream: ReadStream;
  progressInterval?: number;
};

export class MqttTransmitter extends EventEmitter {
  private client: MqttClient;
  private topic: string;
  private stream: ReadStream;
  private totalSize: number;
  private transferred = 0;
  private interval?: NodeJS.Timeout;
  private progressInterval: number;
  private hash = createHash('sha256');
  private fileName: string;

  constructor({ client, topic, stream, progressInterval = DEFAULT_PROCESS_INTERVAL }: MqttTransmitterOptions) {
    super();
    this.client = client;
    this.topic = topic;
    this.stream = stream;
    this.progressInterval = progressInterval;

    this.fileName = basename(this.stream.path?.toString() || `file_${Date.now()}`);
    const filePath = this.stream.path?.toString();
    this.totalSize = filePath && existsSync(filePath) ? statSync(filePath).size : 0;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startProcessWatch();

      // 1️⃣ Отправляем метаданные файла
      const metaMessage = JSON.stringify({
        start: true,
        fileName: this.fileName,
        size: this.totalSize,
      });

      this.client.publish(this.topic, metaMessage, { qos: 2 }, () => {
        // 2️⃣ После отправки метаданных начинаем отправку чанков
        this.sendNextChunk(resolve, reject);
      });

      this.stream.on('error', err => this.onErrorHandler(err, reject));
    });
  }

  private sendNextChunk(resolve: () => void, reject: (err: Error) => void) {
    const chunk = this.stream.read();
    if (chunk === null) {
      this.stream.once('readable', () => this.sendNextChunk(resolve, reject));
      return;
    }

    this.transferred += chunk.length;
    this.hash.update(chunk);

    this.client.publish(this.topic, chunk, { qos: 2 }, () => {
      if (this.stream.readableEnded) {
        this.onEndHandler(resolve);
      } else {
        this.sendNextChunk(resolve, reject);
      }
    });
  }

  private onErrorHandler(err: Error, reject: (err: Error) => void) {
    if (this.interval) clearInterval(this.interval);
    this.emit('error', err);
    reject(err);
  }

  private onEndHandler(resolve: () => void) {
    if (this.interval) clearInterval(this.interval);

    const checksum = this.hash.digest('hex');

    const endMessage = JSON.stringify({
      end: true,
      fileName: this.fileName,
      size: this.totalSize,
      checksum,
    });

    this.client.publish(this.topic, endMessage, { qos: 2 }, () => {
      this.emit('progress', 100);
      this.emit('done', { fileName: this.fileName, checksum });
      resolve();
    });
  }

  private startProcessWatch() {
    this.interval = setInterval(() => {
      const percent = this.totalSize > 0 ? (this.transferred / this.totalSize) * 100 : 0;
      this.emit('progress', percent);
    }, this.progressInterval);
  }
}
