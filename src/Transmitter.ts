import type { MqttClient } from 'mqtt';
import { ReadStream, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { basename } from 'path';
import { Writable } from 'stream';

const DEFAULT_PROGRESS_INTERVAL = 1000;

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
  private mqttWritable?: MqttWritable;

  constructor({ client, topic, stream, progressInterval = DEFAULT_PROGRESS_INTERVAL }: MqttTransmitterOptions) {
    super();
    this.client = client;
    this.topic = topic;
    this.stream = stream;
    this.progressInterval = progressInterval;

    const filePath = this.stream.path?.toString();
    this.fileName = basename(filePath || `file_${Date.now()}`);
    this.totalSize = filePath && existsSync(filePath) ? statSync(filePath).size : 0;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startProgressWatch();

      // 1️⃣ Send metadata
      const metaMessage = JSON.stringify({
        start: true,
        fileName: this.fileName,
        size: this.totalSize,
      });

      this.client.publish(this.topic, metaMessage, { qos: 2 }, () => {
        // 2️⃣ After send metadata, start streaming
        this.sendStream(resolve, reject);
      });

      this.stream.on('error', err => this.onErrorHandler(err, reject));
    });
  }

  private sendStream(resolve: () => void, reject: (err: Error) => void) {
    // Создаем Writable stream с обработкой прогресса и хеша
    this.mqttWritable = new MqttWritable(this.client, this.topic, (chunk: Buffer) => {
      this.transferred += chunk.length;
      this.hash.update(chunk);
    });

    // Обработка ошибок в Writable stream
    this.mqttWritable.on('error', error => {
      this.onErrorHandler(error, reject);
    });

    // Обработка завершения потока
    this.mqttWritable.on('finish', () => {
      this.onEndHandler(resolve);
    });

    // Запускаем передачу
    this.stream.pipe(this.mqttWritable);
  }

  private onErrorHandler(err: Error, reject: (err: Error) => void) {
    this.cleanup();
    this.emit('error', err);
    reject(err);
  }

  private onEndHandler(resolve: () => void) {
    const checksum = this.hash.digest('hex');

    const endMessage = JSON.stringify({
      end: true,
      fileName: this.fileName,
      size: this.totalSize,
      transferred: this.transferred,
      checksum,
    });

    this.client.publish(this.topic, endMessage, { qos: 2 }, error => {
      this.cleanup();

      if (error) {
        this.emit('error', error);
      } else {
        this.emit('progress', 100);
        this.emit('done', {
          fileName: this.fileName,
          checksum,
          size: this.totalSize,
          transferred: this.transferred,
        });
      }
      resolve();
    });
  }

  private startProgressWatch() {
    this.interval = setInterval(() => {
      const percent = this.totalSize > 0 ? (this.transferred / this.totalSize) * 100 : 0;
      this.emit('progress', Math.min(percent, 100));
    }, this.progressInterval);
  }

  private cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    // Уничтожаем потоки если они еще активны
    if (!this.stream.destroyed) {
      this.stream.destroy();
    }

    if (this.mqttWritable && !this.mqttWritable.destroyed) {
      this.mqttWritable.destroy();
    }
  }

  public destroy() {
    this.cleanup();
  }
}

class MqttWritable extends Writable {
  constructor(
    private client: MqttClient,
    private topic: string,
    private onChunk?: (chunk: Buffer) => void,
  ) {
    super({
      highWaterMark: 5,
      objectMode: false,
    });
  }

  _write(chunk: Buffer, encoding: string, callback: (error?: Error) => void) {
    // Вызываем callback для отслеживания чанка
    if (this.onChunk) {
      this.onChunk(chunk);
    }

    this.client.publish(this.topic, chunk, { qos: 2 }, error => {
      if (error) {
        callback(error);
      } else {
        callback();
      }
    });
  }

  _final(callback: (error?: Error) => void) {
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error) => void) {
    callback(error || undefined);
  }
}
