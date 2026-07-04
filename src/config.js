'use strict';

// Immutable connection settings for a UARegistry EPP session.
//
// The public endpoint is strict RFC EPP over TLS (host uaregistry.com, port 700) and needs
// NO client certificate. The optional clientCert / clientKey / clientKeyPassphrase are only
// used if your endpoint requires mutual TLS. When objUris / extUris are left null the client
// logs in advertising exactly the services the server greeting offers, so it is never
// rejected for an unsupported service.

class Config {
  constructor(opts = {}) {
    this.host = opts.host || '';
    this.clid = opts.clid || '';
    this.password = opts.password || '';
    this.port = opts.port != null ? opts.port : 700;
    this.lang = opts.lang || 'en';
    // Timeouts in milliseconds (Node convention).
    this.connectTimeout = opts.connectTimeout != null ? opts.connectTimeout : 10000;
    this.readTimeout = opts.readTimeout != null ? opts.readTimeout : 30000;
    this.verifyPeer = opts.verifyPeer != null ? opts.verifyPeer : true;
    this.verifyPeerName = opts.verifyPeerName != null ? opts.verifyPeerName : true;
    // CA bundle that signs the SERVER certificate (PEM path, for a private-CA endpoint).
    this.caFile = opts.caFile != null ? opts.caFile : null;
    // Your (registrar) client certificate — only when mutual TLS is required. PEM path.
    this.clientCert = opts.clientCert != null ? opts.clientCert : null;
    // Your client private key. PEM path. May be omitted when bundled in clientCert.
    this.clientKey = opts.clientKey != null ? opts.clientKey : null;
    // Passphrase for an encrypted client private key, if any.
    this.clientKeyPassphrase = opts.clientKeyPassphrase != null ? opts.clientKeyPassphrase : null;
    // Override the login objURIs / extURIs; null = use the greeting's.
    this.objUris = opts.objUris != null ? opts.objUris : null;
    this.extUris = opts.extUris != null ? opts.extUris : null;
    // Prefix for auto-generated client transaction ids (clTRID).
    this.clTRIDPrefix = opts.clTRIDPrefix || 'UAR-SDK';
  }
}

module.exports = { Config };
