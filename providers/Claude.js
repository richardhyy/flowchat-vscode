// ==FlowChatProvider==
// @name                Anthropic Claude
// @version             1.0
// @description         FlowChat provider for Claude by Anthropic. System prompt is supported by Claude 2.1 (or later). Docs: https://docs.anthropic.com/claude/docs. This script is not affiliated with Anthropic.
// @author              Alan Richard
// @license             MIT
// @variableSecure      APIKey
// @variableRequired    Model=claude-3-opus-20240229
// @variableRequired    MaxTokensToSample=4000
// @variableRequired    SystemPrompt=You are a helpful assistant.
// @variableOptional    Temperature=0.5
// @variableOptional    LogitBias={}
// ==/FlowChatProvider==

const https = require('https');

function debug(message) {
  process.send({
    type: 'debug',
    content: message
  });
}

let requests = {};

process.on('message', (message) => {
  const requestID = message.requestID;
  if (message.type === 'getCompletion') {
    const messageTrail = message.messageTrail;
    const config = message.config;

    debug(`Received message trail: ${JSON.stringify(messageTrail)}\n`);
    debug(`Received config: ${JSON.stringify(config)}\n`);

    const messages = messageTrail.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const requestBody = JSON.stringify({
      model: config.Model,
      messages: messages,
      max_tokens: parseInt(config.MaxTokensToSample),
      stream: true,
      system: config.SystemPrompt,
      temperature: parseFloat(config.Temperature || '0'),
    });

    debug(`Request body: ${requestBody}\n`);

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': config.APIKey,
        ...JSON.parse(config.AdditionalHeaders || '{}'),
      },
    };

    debug(`Request options: ${JSON.stringify(options)}\n`);

    function handleEvent(event, data) {
      debug(`Received event: ${event}\n`);
      debug(`Received event data: ${JSON.stringify(data)}\n`);

      if (event === 'message_start') {
        process.send({
          type: 'stream',
          requestID: requestID,
          partialText: ''
        });
      } else if (event === 'content_block_delta') {
        if (data.delta.type === 'text_delta') {
          process.send({
            type: 'stream',
            requestID: requestID,
            partialText: data.delta.text
          });
          return data.delta.text;
        }
      } else if (event === 'error') {
        process.send({
          type: 'error',
          requestID: requestID,
          error: data.error.message
        });
      }

      return null;
    }

    let responseText = '';

    const req = https.request(options, (res) => {
      debug(`Response status code: ${res.statusCode}\n`);
      debug(`Response headers: ${JSON.stringify(res.headers)}\n`);

      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
        debug(`Received data: ${chunk}\n`);

        const lines = responseData.split('\n');
        let event = null;
        let data = null;
        let jsonBlob = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            if (event !== null && data !== null) {
              responseData = '';
              const partialText = handleEvent(event, data);
              if (partialText !== null) {
                responseText += partialText;
              }
            }
            event = line.substring(7).trim();
            data = null;
          } else if (line.startsWith('data: ')) {
            try {
              data = JSON.parse(line.substring(6));
            } catch (error) {
              // There's a chance that the JSON is not complete yet
              jsonBlob += line.substring(6);
            }
          } else if (jsonBlob !== '') {
            try {
              data = JSON.parse(jsonBlob + line);
            } catch (error) {
              jsonBlob += line;
            }
          }
        }

        if (event !== null && data !== null) {
          debug(`Processing event: ${event}\n`);
          responseData = '';
          const partialText = handleEvent(event, data);
          if (partialText !== null) {
            responseText += partialText;
          }
        }
      });

      res.on('end', () => {
        debug('Response ended\n');
        process.send({
          type: 'done',
          requestID: requestID,
          finalText: responseText
        });

        if (requests[requestID]) {
          delete requests[requestID];
        }
      });
    });

    requests[requestID] = req;

    req.on('error', (error) => {
      debug(`Request error: ${error.message}\n`);
      process.send({
        type: 'error',
        requestID: requestID,
        error: error.message
      });
      if (requests[requestID]) {
        delete requests[requestID];
      }
    });

    req.on('close', () => {
      debug('Request aborted\n');
      process.send({
        type: 'done',
        requestID: requestID,
        finalText: responseText
      });

      if (requests[requestID]) {
        delete requests[requestID];
      }
    });

    req.write(requestBody);
    req.end();

  } else if (message.type === 'cancel') {
    if (requests[requestID]) {
      requests[requestID].destroy();
      delete requests[requestID];
    }
  } else {
    debug(`Unknown message type: ${message.type}\n`);
  }
});
