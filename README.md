# UARegistry EPP SDK (Node.js)

A small, **dependency-free** Node.js client for the **UARegistry** EPP service — standard
**RFC 5730–5734** EPP over **TLS on port 700**. It speaks the wire protocol directly
(no framework, no server-side code), so you can drop it into any Node.js 16+ project.
Every command frame is standard, schema-valid EPP. Ships with TypeScript types.

- TLS transport with correct RFC 5734 framing (4-byte length prefix, UTF-8 byte-safe).
- Session: `connect` / `login` / `logout`, with the login services taken from the server
  greeting automatically (never rejected for an unsupported service).
- Full object commands: **domain**, **contact**, **host** (check / info / create / update /
  delete / transfer / renew), plus **poll** and **balance**.
- Extensions: **secDNS** (RFC 5910), **RGP restore** (RFC 3915), and the UARegistry native
  **.ua trademark licence**.
- Clean `Response` objects (result code, message, availability map, value getters) and typed
  errors. Every command returns a `Promise`.

## Install

```bash
npm install uaregistry
```

Requires only Node.js ≥ 16 (uses the built-in `tls` / `net` modules — no dependencies).

## Quick start

```js
const { Client, Config, EppError } = require('uaregistry');

const client = new Client(new Config({
  host: 'uaregistry.com',
  clid: 'UAR0001',
  password: 'your-secret',
  port: 700,          // default; override only if the endpoint moves
  lang: 'uk',         // localized result messages: en | uk | ua | ru
  // caFile: '/path/to/ca.pem',   // for a private-CA / self-signed endpoint
}));

try {
  await client.connect();   // TLS + read <greeting>
  await client.login();

  const avail = (await client.domain.check(['example.com.ua'])).availability();
  //  => { 'example.com.ua': true }

  const info = await client.domain.info('example.com.ua');
  console.log(info.value('exDate'));

  await client.logout();
} catch (err) {
  if (err instanceof EppError) console.error('EPP error:', err.message);
} finally {
  client.disconnect();
}
```

ESM is supported too: `import { Client, Config } from 'uaregistry';`.

## TLS notes

| Scenario | Config |
|---|---|
| Public, browser-trusted cert | defaults (`verifyPeer: true`, `verifyPeerName: true`) |
| Private-CA / self-signed endpoint | set `caFile` to the CA `.pem` |
| Hostname mismatch (dev) | `verifyPeerName: false` |
| Mutual-TLS endpoint | `clientCert` + `clientKey` (+ `clientKeyPassphrase` if the key is encrypted) |

The public endpoint on `uaregistry.com:700` is strict RFC EPP and needs **no client
certificate** — auth is clID + password (over TLS) with an IP allowlist.

## Commands

```js
// Session
await client.connect(); await client.login(); await client.logout(); client.disconnect();
await client.login('new-password');          // rotate the EPP password during login
await client.hello();                        // re-read the greeting / keep-alive

// Domain
await client.domain.check(['a.com.ua', 'b.com.ua']);
await client.domain.info('a.com.ua', 'pw');
await client.domain.create('a.com.ua', {
  years: 1, registrant: 'C1', contacts: { admin: 'C1', tech: 'C2' },
  nameservers: ['ns1.x.ua', 'ns2.x.ua'], authInfo: 'pw',
  license: 'TM-123',                                        // second-level .ua only
  secDNS: { dsData: [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'ABCD...' }] },
});
await client.domain.update('a.com.ua', {
  add: { ns: ['ns3.x.ua'], statuses: ['clientHold'] },
  rem: { statuses: ['clientHold'] },
  chg: { registrant: 'C9', authInfo: 'newpw' },
  // DNSSEC (RFC 5910): secDNS: { add: { dsData: [...] }, remAll: true, maxSigLife: 1209600 }
});
await client.domain.renew('a.com.ua', '2027-01-15', 1);
await client.domain.restore('a.com.ua');     // RGP restore (op="request")
await client.domain.delete('a.com.ua');
await client.domain.transfer('request', 'a.com.ua', 'pw', 1);

// Contact
await client.contact.check(['c1']);
await client.contact.info('c1', 'pw');
await client.contact.create('c1', {
  name: 'ACME', city: 'Kyiv', cc: 'UA', email: 'a@b.ua', authInfo: 'pw',
  // postalInfos: [{ type: 'int', ... }, { type: 'loc', ... }],   // int + localized
  // disclose: { flag: false, addr: ['int'], voice: true },       // RFC 5733 privacy
});
await client.contact.update('c1', { chg: { email: 'new@b.ua' }, addStatuses: ['clientUpdateProhibited'] });
await client.contact.delete('c1');
await client.contact.transfer('request', 'c1', 'pw');

// Host
await client.host.check(['ns1.x.ua']);
await client.host.info('ns1.x.ua');
await client.host.create('ns1.x.ua', ['203.0.113.10', '2001:db8::1']);  // v4/v6 auto-detected
await client.host.update('ns1.x.ua', { addAddresses: ['203.0.113.11'] });
await client.host.delete('ns1.x.ua');

// Poll & balance
const msg = await client.poll.request();     // 1301 with a message, 1300 when empty
if (msg.messageId() !== null) {               // messageCount() = how many remain
  await client.poll.ack(msg.messageId());
}
const b = (await client.balance()).balance(); // { creditLimit, balance, availableCredit }
```

## Responses

Every command resolves to a `Response`:

```js
r.code();            // int EPP result code (1000, 1001, 2303, ...)
r.isSuccess();       // true for 1xxx
r.isPending();       // true for 1001 (registry resolves via a poll message)
r.message();         // human-readable <msg>
r.messageLang();     // "en" | "uk" | "ua" | "ru"
r.availability();    // { name: boolean } for *:check
r.statuses();        // ['ok'] or ['clientHold', ...]
r.value('exDate');   // first element with that local name
r.values('ns');      // all elements with that local name
r.balance();         // { creditLimit, balance, availableCredit } or null
r.prices();          // { renewal: { value, currency: 'UAH' }, ... }
r.license();         // .ua trademark/licence number, or null
r.rgpStatus();       // ['redemptionPeriod'], ...
r.transferStatus();  // "pending" | "serverApproved" | ... or null
r.dsRecords();       // [{ keyTag, alg, digestType, digest }, ...]
r.keyRecords();      // [{ flags, protocol, alg, pubKey }, ...]
r.isSigned();        // boolean: any DNSSEC data present
r.messageId();       // poll: id to pass to poll.ack(); messageCount() = queue size
r.errorReasons();    // extra <extValue><reason> text on a failed command
r.svTRID();          // server transaction id
r.raw();             // the raw XML
```

## Error handling

By default any EPP error code (≥ 2000) throws `CommandError` (with `.eppCode` and
`.response`). Login failures throw `AuthError`; transport problems throw `ConnectionError`.
All extend `EppError`.

```js
const { CommandError, ResultCode } = require('uaregistry');

try {
  await client.domain.create('taken.com.ua', { years: 1, registrant: 'C1',
    contacts: { admin: 'C1', tech: 'C2' }, nameservers: ['ns1.x.ua'] });
} catch (err) {
  if (err instanceof CommandError && err.eppCode === ResultCode.OBJECT_EXISTS) { /* 2302 */ }
}

// Prefer branching on codes yourself?
client.throwOnFailure(false);
const resp = await client.domain.info('maybe.com.ua');
if (resp.code() === ResultCode.OBJECT_DOES_NOT_EXIST) { /* not found */ }
```

## Custom frames

Anything the high-level API doesn't cover can be built with `Frame` and sent raw:

```js
const { Frame, Namespaces } = require('uaregistry');

const frame = Frame.command('my-trid-1');
const check = frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
frame.ns(check, Namespaces.DOMAIN, 'domain:name', 'x.com.ua');
const resp = await client.request(frame);     // or client.request(rawXmlString)
```

## Testing

A no-dependency offline self-test (frame building + response parsing, no server):

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
