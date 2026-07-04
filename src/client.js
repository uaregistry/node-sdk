'use strict';

const ns = require('./namespaces');
const { Frame } = require('./frame');
const { Response } = require('./response');
const { Connection } = require('./transport');
const { Domain, Contact, Host, Poll } = require('./commands');
const { ConfigError, ConnectionError, CommandError, AuthError } = require('./errors');

// EPP client for the UARegistry service. Open a connection, log in, then reach the object
// commands through the resource getters — client.domain, .contact, .host, .poll. Every
// command returns a Promise<Response>. By default any EPP error code (>= 2000) is thrown as a
// CommandError; call throwOnFailure(false) to inspect codes yourself instead.
//
//   const client = new Client(new Config({ host: 'uaregistry.com', clid: 'UAR0001', password: '...' }));
//   await client.connect();
//   await client.login();
//   const avail = (await client.domain.check(['example.com.ua'])).availability();
//   await client.logout();
//   client.disconnect();

const PW_RE = /(<(?:[\w.-]+:)?(?:pw|newPW)>)([\s\S]*?)(<\/(?:[\w.-]+:)?(?:pw|newPW)>)/g;

function utcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

class Client {
  constructor(config, connection = null, logger = null) {
    this._config = config;
    this._connection = connection || new Connection(config);
    this._logger = logger;
    this._greeting = null;
    this._loggedIn = false;
    this._throw = true;
    this._tridCounter = 0;
    // Per-process component of the client transaction id (clTRID): ids from one process share
    // a stable middle segment and stay unique across concurrent processes.
    this._processToken = String(process.pid);
    this._handlers = {};
  }

  static async connectAndLogin(config) {
    const client = new Client(config);
    await client.connect();
    await client.login();
    return client;
  }

  // Toggle automatic CommandError throwing on EPP error codes.
  throwOnFailure(value = true) {
    this._throw = value;
    return this;
  }

  setLogger(logger) {
    this._logger = logger;
    return this;
  }

  // --- session ---------------------------------------------------------------

  async connect() {
    if (this._config.host === '') throw new ConfigError('Config: host must not be empty');
    if (!this._connection.isOpen()) await this._connection.open();
    const raw = await this._connection.readFrame();
    this._logDebug('EPP << greeting', raw);
    this._greeting = Response.fromXml(raw);
    return this._greeting;
  }

  get greeting() {
    return this._greeting;
  }

  // Send <hello>; the server replies with a fresh <greeting>.
  async hello() {
    await this._connection.writeFrame(`<?xml version="1.0" encoding="UTF-8"?><epp xmlns="${ns.EPP}"><hello/></epp>`);
    this._greeting = Response.fromXml(await this._connection.readFrame());
    return this._greeting;
  }

  // Authenticate. Advertises exactly the services the greeting offered unless
  // Config.objUris / extUris override them. Pass newPassword to rotate the EPP password.
  async login(newPassword = null) {
    if (this._config.clid === '' || this._config.password === '') {
      throw new ConfigError(
        `login requires a non-empty clID and password (clID ${this._config.clid ? 'set' : 'EMPTY'}, password ${this._config.password ? 'set' : 'EMPTY'}) — check your config`,
      );
    }
    if (this._greeting === null) await this.connect();

    const greetingObj = this._greeting ? this._greeting.serviceObjUris() : [];
    const greetingExt = this._greeting ? this._greeting.serviceExtUris() : [];
    let objUris = this._config.objUris || (greetingObj.length ? greetingObj : ns.DEFAULT_OBJ_URIS);
    const extUris = this._config.extUris !== null ? this._config.extUris : (greetingExt.length ? greetingExt : ns.DEFAULT_EXT_URIS);
    // The epp-1.0 base URI is not an object service and is never listed in <login>.
    objUris = objUris.filter((u) => u !== ns.EPP);

    const frame = this.frame();
    const login = frame.verb('login');
    frame.epp(login, 'clID', this._config.clid);
    frame.epp(login, 'pw', this._config.password);
    if (newPassword !== null) frame.epp(login, 'newPW', newPassword);
    const options = frame.epp(login, 'options');
    frame.epp(options, 'version', '1.0');
    frame.epp(options, 'lang', this._config.lang);
    const svcs = frame.epp(login, 'svcs');
    for (const uri of objUris) frame.epp(svcs, 'objURI', uri);
    if (extUris.length) {
      const svcExt = frame.epp(svcs, 'svcExtension');
      for (const uri of extUris) frame.epp(svcExt, 'extURI', uri);
    }

    const response = await this._transact(frame.toXml());
    if (response.code() !== 1000) {
      throw new AuthError(response.code(), `Login failed (EPP ${response.code()}): ${response.message() || 'no message'}`, response);
    }
    this._loggedIn = true;
    return response;
  }

  async logout() {
    const frame = this.frame();
    frame.verb('logout');
    const response = await this._transact(frame.toXml()); // 1500; the server then closes the link
    this._loggedIn = false;
    return response;
  }

  disconnect() {
    this._connection.close();
    this._loggedIn = false;
  }

  isConnected() {
    return this._connection.isOpen();
  }

  isLoggedIn() {
    return this._loggedIn;
  }

  // --- resource handlers -----------------------------------------------------

  get domain() {
    return this._handlers.domain || (this._handlers.domain = new Domain(this));
  }

  get contact() {
    return this._handlers.contact || (this._handlers.contact = new Contact(this));
  }

  get host() {
    return this._handlers.host || (this._handlers.host = new Host(this));
  }

  get poll() {
    return this._handlers.poll || (this._handlers.poll = new Poll(this));
  }

  // Query the registrar account balance (creditLimit / balance / availableCredit).
  balance() {
    const frame = this.frame();
    frame.ns(frame.verb('info'), ns.UAREG_BALANCE, 'balance:info');
    return this.request(frame);
  }

  // --- low-level -------------------------------------------------------------

  // A new command frame with an auto-generated clTRID already stamped.
  frame() {
    return Frame.command(this._nextClTrid());
  }

  // Send a frame (a Frame or raw XML string) and resolve to the parsed Response. Rejects with
  // CommandError on an EPP error code unless throwOnFailure(false) is set.
  async request(frame) {
    const xml = typeof frame === 'string' ? frame : frame.toXml();
    const response = await this._transact(xml);
    if (this._throw && !response.isSuccess()) {
      throw new CommandError(response.code(), `EPP ${response.code()}: ${response.message() || 'command failed'}`, response);
    }
    return response;
  }

  // --- internals -------------------------------------------------------------

  async _transact(xml) {
    if (!this._connection.isOpen()) throw new ConnectionError('Not connected — call connect() first');
    this._logDebug('EPP >> request', this._redact(xml));
    await this._connection.writeFrame(xml);
    const raw = await this._connection.readFrame();
    this._logDebug('EPP << response', this._redact(raw));
    const response = Response.fromXml(raw);
    if (this._logger) {
      const level = response.isSuccess() ? 'info' : 'warn';
      const fn = this._logger[level] || this._logger.log;
      if (fn) fn.call(this._logger, `EPP result ${response.code()} (svTRID=${response.svTRID()} clTRID=${response.clTRID()})`);
    }
    return response;
  }

  _logDebug(msg, frame) {
    if (this._logger && this._logger.debug) this._logger.debug(`${msg} ${frame}`);
  }

  // Mask passwords / authInfo (any namespace) before a frame is logged.
  _redact(xml) {
    return xml.replace(PW_RE, '$1***$3');
  }

  _nextClTrid() {
    this._tridCounter += 1;
    // A client transaction id that is easy to correlate in logs: prefix, a UTC timestamp,
    // the per-process token and a monotonic counter.
    const counter = String(this._tridCounter).padStart(4, '0');
    return `${this._config.clTRIDPrefix}-${utcStamp()}-${this._processToken}-${counter}`;
  }
}

module.exports = { Client };
