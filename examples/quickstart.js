'use strict';

// Minimal end-to-end example. Requires a live endpoint + credentials.
//   node examples/quickstart.js

const { Client, Config, CommandError, EppError } = require('..');

async function main() {
  const client = new Client(
    new Config({
      host: 'uaregistry.com',
      clid: 'UAR0001',
      password: 'your-secret',
      port: 700,          // default; override only if the endpoint moves
      lang: 'uk',         // localized result messages: en | uk | ua | ru
      // caFile: '/path/to/ca.pem',   // for a private-CA / self-signed endpoint
    }),
    null,
    console, // optional logger (passwords/authInfo are masked)
  );

  try {
    await client.connect();   // TLS + read <greeting>
    await client.login();

    const avail = (await client.domain.check(['example.com.ua'])).availability();
    console.log('availability:', avail);

    const info = await client.domain.info('example.com.ua');
    console.log('exDate:', info.value('exDate'));

    const bal = (await client.balance()).balance();
    console.log('balance:', bal);

    const msg = await client.poll.request();
    if (msg.messageId() !== null) {
      console.log('poll:', msg.message());
      await client.poll.ack(msg.messageId());
    }

    await client.logout();
  } catch (err) {
    if (err instanceof CommandError) console.error(`EPP error ${err.eppCode}: ${err.message}`);
    else if (err instanceof EppError) console.error('SDK error:', err.message);
    else throw err;
  } finally {
    client.disconnect();
  }
}

main();
