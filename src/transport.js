'use strict';

const tls = require('tls');
const fs = require('fs');
const { ConnectionError } = require('./errors');

// The raw EPP-over-TLS transport: a TLS socket plus RFC 5734 framing (each message is
// prefixed with a 4-byte big-endian total length that INCLUDES the 4 header bytes). Knows
// nothing about EPP semantics — it ships and receives byte frames. All methods are async.
//
// Framing uses Buffer byte lengths, so multibyte (Cyrillic / IDN) payloads are correct.

const MAX_FRAME = 1048576; // 1 MiB guard against a runaway length prefix

class Connection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this._buffer = Buffer.alloc(0);
    this._waiters = []; // pending readFrame() resolvers: {resolve, reject}
    this._fatal = null; // a terminal error once the socket dies
  }

  open() {
    const cfg = this.config;
    return new Promise((resolve, reject) => {
      const options = {
        host: cfg.host,
        port: cfg.port,
        servername: cfg.host, // SNI
        minVersion: 'TLSv1.2',
        rejectUnauthorized: cfg.verifyPeer,
        checkServerIdentity: cfg.verifyPeerName ? undefined : () => undefined,
      };
      if (cfg.caFile) options.ca = fs.readFileSync(cfg.caFile);
      if (cfg.clientCert) options.cert = fs.readFileSync(cfg.clientCert);
      if (cfg.clientKey) options.key = fs.readFileSync(cfg.clientKey);
      if (cfg.clientKeyPassphrase) options.passphrase = cfg.clientKeyPassphrase;

      let settled = false;
      const socket = tls.connect(options, () => {
        settled = true;
        socket.setTimeout(Math.max(1000, cfg.readTimeout | 0));
        resolve();
      });
      this.socket = socket;

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        const e = new ConnectionError(`TLS/socket error on ${cfg.host}:${cfg.port} — ${err.message}`);
        if (!settled) { settled = true; reject(e); }
        this._fail(e);
      });
      socket.on('timeout', () => {
        const e = new ConnectionError('Read/connect timed out');
        if (!settled) { settled = true; reject(e); }
        this._fail(e);
        socket.destroy();
      });
      socket.on('close', () => this._fail(new ConnectionError('Connection closed')));
      socket.setTimeout(Math.max(1000, cfg.connectTimeout | 0));
    });
  }

  isOpen() {
    return this.socket !== null && !this.socket.destroyed && this._fatal === null;
  }

  writeFrame(xml) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new ConnectionError('Not connected'));
        return;
      }
      const body = Buffer.from(xml, 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length + 4, 0);
      this.socket.write(Buffer.concat([header, body]), (err) => {
        if (err) reject(new ConnectionError(`Write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  readFrame() {
    return new Promise((resolve, reject) => {
      if (this._fatal) { reject(this._fatal); return; }
      this._waiters.push({ resolve, reject });
      this._pump();
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this._fail(new ConnectionError('Connection closed'));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._pump();
  }

  _pump() {
    while (this._waiters.length > 0) {
      if (this._buffer.length < 4) return;
      const total = this._buffer.readUInt32BE(0);
      if (total < 4 || total > MAX_FRAME) {
        this._fail(new ConnectionError(`Invalid EPP frame length: ${total}`));
        return;
      }
      if (this._buffer.length < total) return;
      const frame = this._buffer.slice(4, total).toString('utf8');
      this._buffer = this._buffer.slice(total);
      this._waiters.shift().resolve(frame);
    }
  }

  _fail(err) {
    if (this._fatal) return;
    this._fatal = err;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w.reject(err);
  }
}

module.exports = { Connection };
