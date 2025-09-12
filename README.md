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

### Transmitter;

```ts
import { createReadStream } from "fs";
import mqtt from "mqtt";
import { MqttTransmitter } from "mqtt-file-transfer";

const client = mqtt.connect("mqtt://localhost:1883");
const stream = createReadStream("path/to/file.txt");

const transmitter = new MqttTransmitter({
  client,
  topic: "file-transfer",
  stream,
});

transmitter.on("progress", (percent) => console.log("progress", percent));
transmitter.on("done", ({ fileName, checksum }) =>
  console.log("done", fileName, checksum)
);

transmitter.start();
```

### Receiver

```ts
import mqtt from "mqtt";
import { MqttReceiver } from "mqtt-file-transfer";

const client = mqtt.connect("mqtt://localhost:1883");

const receiver = new MqttReceiver({
  client,
  topic: "file-transfer",
  outputDir: "./downloads",
});

receiver.on("start", (fileName) => console.log("started", fileName));
receiver.on("progress", (percent) => console.log("progress", percent));
receiver.on("done", ({ fileName, checksum }) =>
  console.log("done", fileName, checksum)
);
receiver.on("error", (err) => console.error("error", err));

receiver.start();
```

## Testing

A sample test file is included in test/fileTransfer.spec.ts.
Run tests with:

```bash
npm install
npm run test
```

## Notes

- Files are split into chunks using Node.js streams.
- Each transfer emits a start message with the file name, progress updates, and an end message with the checksum.
- The receiver verifies file integrity and emits events for start, progress, done, or errors.

License

MIT
