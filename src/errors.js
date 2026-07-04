'use strict';

// Error hierarchy raised by the SDK. Catch EppError to handle any SDK failure; catch the
// subclasses to distinguish a transport problem from a command rejection.

class EppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EppError';
  }
}

class ConnectionError extends EppError {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
  }
}

class ConfigError extends EppError {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

class CommandError extends EppError {
  constructor(eppCode, message, response = null) {
    super(message);
    this.name = 'CommandError';
    this.eppCode = eppCode;   // the EPP result code (>= 2000)
    this.response = response;  // the full parsed Response, if one was received
  }
}

class AuthError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'AuthError';
  }
}

module.exports = { EppError, ConnectionError, ConfigError, CommandError, AuthError };
