const parsers = require('./message-parsers');
const utils = require('./utils');

const loggerAlias = 'arnav_mq:consumer';

class Consumer {
  constructor(connection) {
    this._connection = connection;
    this.channel = null;
  }

  set connection(value) {
    this._connection = value;
  }

  get connection() {
    return this._connection;
  }

  /**
   * Get a function to execute on incoming messages to handle RPC
   * @param  {any} msg   An amqp.node message object
   * @param  {string} queue The initial queue on which the handler received the message
   * @return {function}       a function to use in a chaining on incoming messages
   */
  checkRpc(msg, queue) {
    /**
     * When message contains a replyTo property, we try to send the answer back
     * @param  {any} content the received message:
     * @return {any}          object, string, number... the current received message
     */
    return (content) => {
      if (msg.properties.replyTo) {
        const options = { correlationId: msg.properties.correlationId, persistent: true, durable: true };
        this._connection.config.transport.debug(loggerAlias, `[${queue}][${msg.properties.replyTo}] >`, content);
        this._connection.config.logger.debug({
          message: `${loggerAlias} [${queue}][${msg.properties.replyTo}] > ${content}`,
          params: { content }
        });
        this.channel.sendToQueue(msg.properties.replyTo, parsers.out(content, options), options);
      }

      return msg;
    };
  }

  /**
   * Create a durable queue on RabbitMQ and consumes messages from it - executing a callback function.
   * Automatically answers with the callback response (can be a Promise)
   * @param  {string}   queue    The RabbitMQ queue name
   * @param  {object}   options  (Optional) Options for the queue (durable, persistent, etc.)
   * @param  {Function} callback Callback function executed when a message is received on the queue name, can return a promise
   * @return {Promise}           A promise that resolves when connection is established and consumer is ready
   */
  /* eslint no-param-reassign: "off" */
  consume(queue, options, callback) {
    return this.subscribe(queue, options, callback);
  }

  subscribe(queue, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      // default message options
      options = { persistent: true, durable: true };
    }

    // consumer gets a suffix if one is set on the configuration, to suffix all queues names
    // ex: service-something with suffix :ci becomes service-suffix:ci etc.
    const suffixedQueue = `${queue}${this._connection.config.consumerSuffix || ''}`;

    return this._connection.get().then((channel) => {
      this.channel = channel;

      // when channel is closed, we want to be sure we recreate the queue ASAP so we trigger a reconnect by recreating the consumer
      this.channel.addListener('close', () => {
        this.subscribe(queue, options, callback);
      });

      return this.channel.assertQueue(suffixedQueue, options).then((q) => {
        this._connection.config.transport.debug(loggerAlias, 'init', q.queue);
        this._connection.config.logger.debug({
          message: `${loggerAlias} init ${q.queue}`,
          params: { queue: q.queue }
        });

        this.channel.consume(q.queue, (msg) => {
          const messageString = msg.content.toString();
          this._connection.config.transport.debug(loggerAlias, `[${q.queue}] < ${messageString}`);
          this._connection.config.logger.debug({
            message: `${loggerAlias} [${q.queue}] < ${messageString}`,
            params: { queue: q.queue, message: messageString }
          });

          // main answer management chaining
          // receive message, parse it, execute callback, check if should answer, ack/reject message
          Promise.resolve(parsers.in(msg))
            .then((body) => callback(body, msg.properties))
            .then(this.checkRpc(msg, q.queue))
            .then(() => {
              this.channel.ack(msg);
            })
            .catch((error) => {
              // if something bad happened in the callback, reject the message so we can requeue it (or not)
              this._connection.config.transport.error(loggerAlias, error);
              this._connection.config.logger.error({
                message: `${loggerAlias} Failed processing message from queue ${q.queue}: ${error.message}`,
                error,
                params: { queue: q.queue, message: messageString }
              });

              this.channel.reject(msg, this._connection.config.requeue);
            });
        }, { noAck: false });

        return true;
      });
      // in case of any error creating the channel, wait for some time and then try to reconnect again (to avoid overflow)
    }).catch(() => utils.timeoutPromise(this._connection.config.timeout)
      .then(() => this.subscribe(queue, options, callback)));
  }
}

/* eslint no-unused-expressions: "off" */
/* eslint no-sequences: "off" */
/* eslint arrow-body-style: "off" */
module.exports = Consumer;
