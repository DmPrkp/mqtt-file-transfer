import { MqttClient } from "mqtt/*";
import { ReadStream } from "fs";

type TXProps = {
  pendingAckTimeout: number
}

export type MqttReceiverOptions = {
  client: MqttClient;
  topic: string;
  outputDir: string;
}

export type MqttTransmitterOptions = {
  client: MqttClient;
  topic: string;
  stream: ReadStream;
  props?: TXProps;
}