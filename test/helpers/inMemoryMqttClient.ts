import { EventEmitter } from 'events';
import type { MqttClient, IClientPublishOptions, IClientSubscribeOptions } from 'mqtt';

interface Subscription {
  topic: string;
  client: InMemoryMqttClient;
}

class InMemoryBroker {
  private subscriptions: Subscription[] = [];

  subscribe(topic: string, client: InMemoryMqttClient) {
    this.subscriptions.push({ topic, client });
  }

  unsubscribe(client: InMemoryMqttClient) {
    this.subscriptions = this.subscriptions.filter((entry) => entry.client !== client);
  }

  publish(topic: string, payload: Buffer, publisher?: InMemoryMqttClient) {
    for (const { topic: subscribedTopic, client } of this.subscriptions) {
      if (subscribedTopic === topic && client !== publisher) {
        queueMicrotask(() => client.emit('message', topic, payload));
      }
    }
  }
}

const sharedBroker = new InMemoryBroker();

export class InMemoryMqttClient extends EventEmitter {
  private broker = sharedBroker;
  private closed = false;

  publish(
    topic: string,
    message: string | Buffer,
    _options?: IClientPublishOptions,
    callback?: (error?: Error) => void,
  ): MqttClient {
    if (this.closed) {
      callback?.(new Error('Client closed'));
      return this as unknown as MqttClient;
    }

    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    this.broker.publish(topic, payload, this);
    callback?.();
    return this as unknown as MqttClient;
  }

  subscribe(
    topic: string,
    _options?: IClientSubscribeOptions,
    callback?: (err?: Error) => void,
  ): MqttClient {
    if (this.closed) {
      callback?.(new Error('Client closed'));
      return this as unknown as MqttClient;
    }
    this.broker.subscribe(topic, this);
    callback?.();
    return this as unknown as MqttClient;
  }

  end(_force?: boolean, callback?: () => void): MqttClient {
    this.closed = true;
    this.removeAllListeners();
    this.broker.unsubscribe(this);
    callback?.();
    return this as unknown as MqttClient;
  }
}

export function createInMemoryMqttPair(): { publisher: MqttClient; receiver: MqttClient } {
  return {
    publisher: new InMemoryMqttClient() as unknown as MqttClient,
    receiver: new InMemoryMqttClient() as unknown as MqttClient,
  };
}
