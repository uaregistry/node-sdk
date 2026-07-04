'use strict';

// UARegistry EPP SDK (Node.js).
//
// A small, dependency-free client for the UARegistry EPP service — standard RFC 5730-5734
// EPP over TLS on port 700. Speaks the wire protocol directly (no framework, no server code).
//
//   const { Client, Config } = require('uaregistry');
//   const client = new Client(new Config({ host: 'uaregistry.com', clid: 'UAR0001', password: 'secret' }));
//   await client.connect();
//   await client.login();
//   console.log((await client.domain.check(['example.com.ua'])).availability());
//   await client.logout();
//   client.disconnect();

const Namespaces = require('./src/namespaces');
const { Client } = require('./src/client');
const { Config } = require('./src/config');
const { Frame } = require('./src/frame');
const { Response } = require('./src/response');
const { Connection } = require('./src/transport');
const { ResultCode } = require('./src/resultCode');
const { Domain, Contact, Host, Poll } = require('./src/commands');
const { EppError, ConnectionError, ConfigError, CommandError, AuthError } = require('./src/errors');

module.exports = {
  Client,
  Config,
  Frame,
  Response,
  Connection,
  ResultCode,
  Namespaces,
  Domain,
  Contact,
  Host,
  Poll,
  EppError,
  ConnectionError,
  ConfigError,
  CommandError,
  AuthError,
};
