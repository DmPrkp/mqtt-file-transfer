# mqtt-file-transfer

A simple Node.js module for transferring files over MQTT using streams.  
Supports multiple concurrent transfers and verifies file integrity with SHA-256 checksums.

## Features

- Stream files via MQTT in chunks
- Emit progress events
- Verify checksum and file size
- Support multiple concurrent transfers

## Installation

```bash
npm install mqtt-file-transfer
```

## Usage

### Transmitter

```typescript
import { createReadStream } from "fs";
import mqtt from "mqtt";
import { MqttTransmitter } from "mqtt-file-transfer";

const client = mqtt.connect("mqtt://localhost:1883");
const stream = createReadStream("path/to/file.txt");

const transmitter = new MqttTransmitter({
  client,
  topic: "file-transfer",
  stream,
  props: {
    pendingAckTimeout: 5000, // ms to wait for a chunk ACK before retrying/failing
    throttling: 50, // ms delay between chunks
    retry: 3, // number of retries per chunk on ACK timeout
  },
});

transmitter.on("progress", (percent) => console.log("progress", percent));
transmitter.on("error", (err) => {
  console.error("error", err);
  transmitter.stop();
});

transmitter.on("done", ({ fileName, checksum }) => {
  console.log("done", fileName, checksum);
  transmitter.stop();
});

transmitter.start();
```

#### Transmitter `props` (optional)

| Option              | Default | Description                                               |
| ------------------- | ------- | --------------------------------------------------------- |
| `pendingAckTimeout` | `5000`  | Milliseconds to wait for a chunk ACK before retry/failure |
| `throttling`        | `50`    | Milliseconds delay between sending each chunk             |
| `retry`             | `3`     | Number of retry attempts per chunk before giving up       |

### Receiver

```typescript
import mqtt from "mqtt";
import { MqttReceiver } from "mqtt-file-transfer";

const client = mqtt.connect("mqtt://localhost:1883");

const receiver = new MqttReceiver({
  client,
  topic: "file-transfer",
  outputDir: "./downloads",
  props: {
    pendingChunkTimeout: 20000, // ms to wait for the next chunk before failing
  },
});

receiver.on("start", (fileName) => console.log("started", fileName));
receiver.on("progress", (percent) => console.log("progress", percent));
receiver.on("done", ({ fileName, checksum }) => {
  console.log("done", fileName, checksum);
  receiver.stop();
});
receiver.on("error", (err) => {
  console.error("error", err);
  receiver.stop();
});

receiver.start();
```

#### Receiver `props` (optional)

| Option                | Default | Description                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| `pendingChunkTimeout` | `20000` | Milliseconds to wait for the next chunk before emitting a timeout error |

### License

MIT
