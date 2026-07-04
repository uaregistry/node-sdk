// Type definitions for the UARegistry EPP SDK (Node.js).

export interface ConfigOptions {
  host: string;
  clid: string;
  password: string;
  port?: number;
  lang?: string;
  connectTimeout?: number;
  readTimeout?: number;
  verifyPeer?: boolean;
  verifyPeerName?: boolean;
  caFile?: string | null;
  clientCert?: string | null;
  clientKey?: string | null;
  clientKeyPassphrase?: string | null;
  objUris?: string[] | null;
  extUris?: string[] | null;
  clTRIDPrefix?: string;
}

export class Config {
  constructor(opts: ConfigOptions);
  host: string;
  clid: string;
  password: string;
  port: number;
  lang: string;
  connectTimeout: number;
  readTimeout: number;
  verifyPeer: boolean;
  verifyPeerName: boolean;
  caFile: string | null;
  clientCert: string | null;
  clientKey: string | null;
  clientKeyPassphrase: string | null;
  objUris: string[] | null;
  extUris: string[] | null;
  clTRIDPrefix: string;
}

export interface DsRecord { keyTag: number; alg: number; digestType: number; digest: string; }
export interface KeyRecord { flags: number; protocol: number; alg: number; pubKey: string; }
export interface BalanceInfo { creditLimit: string; balance: string; availableCredit: string; }
export interface PriceInfo { value: string; currency: string; }

export interface SecDnsCreate { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[]; maxSigLife?: number; }
export interface SecDnsUpdate {
  add?: { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[] };
  rem?: { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[] };
  remAll?: boolean;
  maxSigLife?: number;
}

export interface PostalInfo {
  type?: 'int' | 'loc';
  name?: string;
  org?: string;
  street?: string[];
  city?: string;
  sp?: string;
  pc?: string;
  cc?: string;
}

export interface Disclose {
  flag?: boolean;
  name?: Array<'int' | 'loc'>;
  org?: Array<'int' | 'loc'>;
  addr?: Array<'int' | 'loc'>;
  voice?: boolean;
  fax?: boolean;
  email?: boolean;
}

export interface DomainCreateOptions {
  years?: number;
  registrant?: string;
  contacts?: Record<string, string>;
  nameservers?: string[];
  authInfo?: string;
  license?: string;
  secDNS?: SecDnsCreate;
}

export interface DomainUpdateOptions {
  add?: { ns?: string[]; contacts?: Record<string, string>; statuses?: string[] };
  rem?: { ns?: string[]; contacts?: Record<string, string>; statuses?: string[] };
  chg?: { registrant?: string; authInfo?: string };
  restore?: boolean;
  license?: string;
  secDNS?: SecDnsUpdate;
}

export interface ContactCreateOptions extends PostalInfo {
  postalInfos?: PostalInfo[];
  voice?: string;
  fax?: string;
  email: string;
  authInfo?: string;
  disclose?: Disclose;
}

export interface ContactUpdateOptions {
  addStatuses?: string[];
  remStatuses?: string[];
  chg?: {
    postalInfo?: PostalInfo;
    postalInfos?: PostalInfo[];
    voice?: string;
    fax?: string;
    email?: string;
    authInfo?: string;
    disclose?: Disclose;
  };
}

export interface HostUpdateOptions {
  addAddresses?: string[];
  remAddresses?: string[];
  addStatuses?: string[];
  remStatuses?: string[];
  newName?: string;
}

export type TransferOp = 'request' | 'approve' | 'reject' | 'cancel' | 'query';

export class Response {
  static fromXml(xml: string): Response;
  code(): number;
  message(): string | null;
  messageLang(): string | null;
  isSuccess(): boolean;
  isPending(): boolean;
  isGreeting(): boolean;
  clTRID(): string | null;
  svTRID(): string | null;
  availability(): Record<string, boolean>;
  messageId(): string | null;
  messageCount(): number;
  statuses(): string[];
  balance(): BalanceInfo | null;
  prices(): Record<string, PriceInfo>;
  license(): string | null;
  rgpStatus(): string[];
  transferStatus(): string | null;
  dsRecords(): DsRecord[];
  keyRecords(): KeyRecord[];
  isSigned(): boolean;
  errorReasons(): string[];
  serviceObjUris(): string[];
  serviceExtUris(): string[];
  value(local: string): string | null;
  values(local: string): string[];
  resData(): unknown;
  raw(): string;
  root(): unknown;
}

export class Domain {
  check(names: string[]): Promise<Response>;
  info(name: string, authInfo?: string | null, hosts?: 'all' | 'sub'): Promise<Response>;
  create(name: string, opts?: DomainCreateOptions): Promise<Response>;
  update(name: string, opts?: DomainUpdateOptions): Promise<Response>;
  renew(name: string, curExpDate: string, years?: number): Promise<Response>;
  delete(name: string): Promise<Response>;
  restore(name: string): Promise<Response>;
  transfer(op: TransferOp, name: string, authInfo?: string | null, years?: number | null): Promise<Response>;
}

export class Contact {
  check(ids: string[]): Promise<Response>;
  info(id: string, authInfo?: string | null): Promise<Response>;
  create(id: string, opts: ContactCreateOptions): Promise<Response>;
  update(id: string, opts?: ContactUpdateOptions): Promise<Response>;
  delete(id: string): Promise<Response>;
  transfer(op: TransferOp, id: string, authInfo?: string | null): Promise<Response>;
}

export class Host {
  check(names: string[]): Promise<Response>;
  info(name: string): Promise<Response>;
  create(name: string, addresses?: string[]): Promise<Response>;
  update(name: string, opts?: HostUpdateOptions): Promise<Response>;
  delete(name: string, force?: boolean): Promise<Response>;
}

export class Poll {
  request(): Promise<Response>;
  ack(messageId: string): Promise<Response>;
}

export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  log?(message: string): void;
}

export interface Transport {
  open(): Promise<void>;
  isOpen(): boolean;
  writeFrame(xml: string): Promise<void>;
  readFrame(): Promise<string>;
  close(): void;
}

export class Frame {
  static command(clTRID: string): Frame;
  verb(name: string): unknown;
  extension(): unknown;
  epp(parent: unknown, name: string, text?: string | null, attrs?: Record<string, unknown>): unknown;
  ns(parent: unknown, nsUri: string, qname: string, text?: string | null, attrs?: Record<string, unknown>): unknown;
  toXml(): string;
}

export class Connection implements Transport {
  constructor(config: Config);
  open(): Promise<void>;
  isOpen(): boolean;
  writeFrame(xml: string): Promise<void>;
  readFrame(): Promise<string>;
  close(): void;
}

export class Client {
  constructor(config: Config, connection?: Transport | null, logger?: Logger | null);
  static connectAndLogin(config: Config): Promise<Client>;
  throwOnFailure(value?: boolean): this;
  setLogger(logger: Logger | null): this;
  connect(): Promise<Response>;
  readonly greeting: Response | null;
  hello(): Promise<Response>;
  login(newPassword?: string | null): Promise<Response>;
  logout(): Promise<Response>;
  disconnect(): void;
  isConnected(): boolean;
  isLoggedIn(): boolean;
  readonly domain: Domain;
  readonly contact: Contact;
  readonly host: Host;
  readonly poll: Poll;
  balance(): Promise<Response>;
  frame(): Frame;
  request(frame: Frame | string): Promise<Response>;
}

export class EppError extends Error {}
export class ConnectionError extends EppError {}
export class ConfigError extends EppError {}
export class CommandError extends EppError { eppCode: number; response: Response | null; }
export class AuthError extends CommandError {}

export const ResultCode: Readonly<Record<string, number>>;
export const Namespaces: Readonly<Record<string, string | string[]>>;
