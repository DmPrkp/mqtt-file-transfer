import type { MqttClient } from "mqtt";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { MqttReceiverOptions } from "./types";

export class MqttReceiver extends EventEmitter {
  private client: MqttClient;
  private topic: string;
  private outputDir: string;
  private fileStream?: ReturnType<typeof createWriteStream>;
  private hash = createHash("sha256");
  private received = 0;
  private expectedSize = 0;
  private expectedChecksum = "";
  private fileName = "";
  private state = 'idle';

  constructor({ client, topic, outputDir }: MqttReceiverOptions) {
    super();
    this.client = client;
    this.topic = topic;
    this.outputDir = outputDir;

    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  }

  public start() {
    if (this.state !== 'idle') return;
    this.state = 'receiving';

    this.client.subscribe(this.topic, { qos: 2 });
    this.client.on("message", this.onMessage);
  }

  private onMessage = (topic: string, payload: Buffer) => {
    if (topic !== this.topic || this.state !== "receiving") return;

    this.handleMessage(payload);
  }

  private handleMessage(payload: Buffer) {
    try {
      const msg = JSON.parse(payload.toString());
      switch (msg.type) {
        case "start":
          this.startFile(msg.fileName, msg.size);
          break;
        case "chunk":
          this.handleChunk(msg.id, msg.data);
          break;
        case "end":
          this.finishFile(msg.checksum);
          break;
      }
    } catch { }
  }

  private startFile(fileName: string, size: number) {
    this.fileName = fileName;
    this.expectedSize = size;
    this.received = 0;
    this.hash = createHash("sha256");
    const filePath = join(this.outputDir, fileName);
    this.fileStream = createWriteStream(filePath);

    this.fileStream.on("error", (error) => {
      this.state = "error"
      this.emit("error", error);
    });

    this.emit("start", fileName);
  }

  private handleChunk(id: number, base64: string) {
    const chunk = Buffer.from(base64, "base64");
    this.fileStream?.write(chunk);
    this.hash.update(chunk);
    this.received += chunk.length;
    this.client.publish(`${this.topic}/ack`, JSON.stringify({ type: "ack", id }), { qos: 2 }, (err) => {
      if (err) this.emit("error", err);
    });

    if (id % 100 === 0 || this.received === this.expectedSize) {
      const progress = ((this.received / this.expectedSize) * 100).toFixed(0);
      this.emit("progress", progress);
    }
  }

  private finishFile(expectedChecksum: string) {
    this.expectedChecksum = expectedChecksum;
    this.state = 'finished'

    if (this.fileStream) {
      this.fileStream.end(() => this.calculateChecksum());
      return
    };

    this.calculateChecksum()
  }

  private calculateChecksum() {
    const actual = this.hash.digest("hex");
    if (actual === this.expectedChecksum) {
      this.emit("done", { fileName: this.fileName, checksum: actual });
    } else {
      this.emit("error", new Error(`Checksum mismatch: expected ${this.expectedChecksum}, got ${actual}`));
    }
  }

  public stop() {
    this.state = "stopped";
    this.fileStream?.destroy();
    this.client.removeListener("message", this.onMessage);
    this.removeAllListeners();
  }
}
