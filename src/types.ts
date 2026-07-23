import { MqttClient } from "mqtt/*";
import { ReadStream } from "fs";

type TXProps = {
  pendingAckTimeout: number
  throttling: number
  retry: number
}

type RXProps = {
  pendingChunkTimeout: number
}

export type MqttReceiverOptions = {
  client: MqttClient;
  topic: string;
  outputDir: string;
  props?: RXProps
}

export type MqttTransmitterOptions = {
  client: MqttClient;
  topic: string;
  stream: ReadStream;
  props?: TXProps;
}