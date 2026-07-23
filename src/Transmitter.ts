import type { MqttClient } from "mqtt";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { basename } from "path";
import { ReadStream, existsSync, statSync } from "fs";
import { MqttTransmitterOptions } from "./types";
import { PENDING_ACK_TIMEOUT, THROTTLING_TIME, RETRY_ATTEMPTS } from "./constants";
export class MqttTransmitter extends EventEmitter {
  private client: MqttClient;
  private topic: string;
  private stream: ReadStream;
  private totalSize: number;
  private transferred = 0;
  private hash = createHash("sha256");
  private fileName: string;
  private chunkId = 0;
  private pendingAckTimeout: number
  private throttling: number
  private retry: number

  private stopped = false

  private pendingAck?: (id: number) => void;

  constructor({ client, topic, stream, props }: MqttTransmitterOptions) {
    super();

    const { pendingAckTimeout, throttling, retry } = props || {}

    this.client = client;
    this.topic = topic;
    this.stream = stream;
    this.throttling = throttling || THROTTLING_TIME
    this.pendingAckTimeout = (pendingAckTimeout || PENDING_ACK_TIMEOUT) + this.throttling
    this.retry = retry || RETRY_ATTEMPTS

    const filePath = this.stream.path?.toString();
    this.fileName = basename(filePath || `file_${Date.now()}`);
    this.totalSize = filePath && existsSync(filePath) ? statSync(filePath).size : 0;

    this.client.on("message", this.handleAck);
    this.client.subscribe(`${this.topic}/ack`);
    this.stream.on("error", (error) => {
      this.emit("error", error);
    });
  }

  public async start() {
    try {
      this.client.publish(
        this.topic,
        JSON.stringify({ type: "start", fileName: this.fileName, size: this.totalSize }),
        { qos: 2 }
      );

      for await (const chunk of this.stream) {
        if (this.stopped) break

        const id = ++this.chunkId;
        const base64 = chunk.toString("base64");

        await new Promise(r => { setTimeout(() => r(null), this.throttling) })
        await this.sendChunk(id, base64);

        this.transferred += chunk.length;
        this.hash.update(chunk);

        if (id % 100 === 0 || this.transferred === this.totalSize) {
          this.emit("progress", ((this.transferred / this.totalSize) * 100).toFixed(0));
        }
      }

      const checksum = this.hash.digest("hex");
      this.client.publish(
        this.topic,
        JSON.stringify({ type: "end", checksum }),
        { qos: 2 }
      );
      this.emit("done", { fileName: this.fileName, checksum });
    } catch (error) {
      this.emit("error", error);
    }
  }

  private sendChunk(id: number, data: string, attempt = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAck = undefined;
        const error = new Error(`ACK timeout for chunk ${id}`);
        this.emit("error", error);

        if (attempt < this.retry) {
          this.sendChunk(id, data, attempt + 1).then(resolve, reject);
        } else {
          reject(error);
        }
      }, this.pendingAckTimeout);

      this.pendingAck = (ackId: number) => {
        if (ackId === id) {
          clearTimeout(timeout);
          resolve();
        }
      };

      this.client.publish(
        this.topic,
        JSON.stringify({ type: "chunk", id, data }),
        { qos: 2 },
        (err) => { if (err) this.emit("error", err); }
      );
    });
  }

  private handleAck = (_topic: string, payload: Buffer) => {
    try {
      const msg = JSON.parse(payload.toString());

      if (msg.type === "ack" && this.pendingAck) {
        this.pendingAck(msg.id);
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  public stop() {
    this.stopped = true
    this.stream.destroy?.();
    this.client.removeListener("message", this.handleAck);
    this.removeAllListeners();
    this.pendingAck = undefined;
  }
}
