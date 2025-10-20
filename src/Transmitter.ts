import type { MqttClient } from "mqtt";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { basename } from "path";
import { ReadStream, existsSync, statSync } from "fs";

export interface MqttTransmitterOptions {
  client: MqttClient;
  topic: string;
  stream: ReadStream;
  progressInterval?: number;
}

export class MqttTransmitter extends EventEmitter {
  private client: MqttClient;
  private topic: string;
  private stream: ReadStream;
  private totalSize: number;
  private transferred = 0;
  private hash = createHash("sha256");
  private fileName: string;
  private chunkId = 0;

  private pendingAck?: (id: number) => void;

  constructor({ client, topic, stream }: MqttTransmitterOptions) {
    super();
    this.client = client;
    this.topic = topic;
    this.stream = stream;

    const filePath = this.stream.path?.toString();
    this.fileName = basename(filePath || `file_${Date.now()}`);
    this.totalSize = filePath && existsSync(filePath) ? statSync(filePath).size : 0;

    this.client.on("message", (_, payload) => this.handleAck(payload));
    this.client.subscribe(`${this.topic}/ack`);
  }

  public async start() {
    this.client.publish(
      this.topic,
      JSON.stringify({ type: "start", fileName: this.fileName, size: this.totalSize }),
      { qos: 2 }
    );

    for await (const chunk of this.stream) {
      const id = ++this.chunkId;
      const base64 = (chunk as Buffer).toString("base64");

      await this.sendChunk(id, base64);

      this.transferred += (chunk as Buffer).length;
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
  }

  private sendChunk(id: number, data: string): Promise<void> {
    return new Promise((resolve) => {
      this.pendingAck = (ackId: number) => {
        if (ackId === id) resolve();
      };
      this.client.publish(this.topic, JSON.stringify({ type: "chunk", id, data }), { qos: 2 });
    });
  }

  private handleAck(payload: Buffer) {
    try {
      const msg = JSON.parse(payload.toString());
      if (msg.type === "ack" && this.pendingAck) {
        this.pendingAck(msg.id);
        this.pendingAck = undefined;
      }
    } catch { }
  }
}
