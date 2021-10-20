/*!
 * This source file is part of the EdgeDB open source project.
 *
 * Copyright 2019-present MagicStack Inc. and the EdgeDB authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  path,
  homeDir,
  crypto,
  fs,
  readFileUtf8Sync,
  tls,
} from "./adapter.node";
import * as errors from "./errors";
import {
  Credentials,
  getCredentialsPath,
  readCredentialsFile,
} from "./credentials";
import * as platform from "./platform";

export type Address = [string, number];

interface PartiallyNormalizedConfig {
  connectionParams: ResolvedConnectConfig;

  // true if the program is run in a directory with `edgedb.toml`
  inProject: boolean;
  // true if the connection params were initialized from a project
  fromProject: boolean;
  // true if any of the connection params were sourced from environment
  fromEnv: boolean;
}

export interface NormalizedConnectConfig extends PartiallyNormalizedConfig {
  connectTimeout?: number;

  commandTimeout?: number;
  waitUntilAvailable: number;

  logging: boolean;
}

export interface ConnectConfig {
  dsn?: string;
  credentialsFile?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  serverSettings?: any;
  tlsCAFile?: string;
  tlsVerifyHostname?: boolean;

  timeout?: number;
  commandTimeout?: number;
  waitUntilAvailable?: number;
  logging?: boolean;
}

export function parseConnectArguments(
  opts: ConnectConfig = {}
): NormalizedConnectConfig {
  if (opts.commandTimeout != null) {
    if (typeof opts.commandTimeout !== "number" || opts.commandTimeout < 0) {
      throw new Error(
        "invalid commandTimeout value: " +
          "expected greater than 0 float (got " +
          JSON.stringify(opts.commandTimeout) +
          ")"
      );
    }
  }

  const projectDir = findProjectDir();

  return {
    ...parseConnectDsnAndArgs(opts, projectDir),
    connectTimeout: opts.timeout,
    commandTimeout: opts.commandTimeout,
    waitUntilAvailable: opts.waitUntilAvailable ?? 30_000,
    logging: opts.logging ?? true,
  };
}

export class ResolvedConnectConfig {
  _host: string | null = null;
  _hostSource: string | null = null;

  _port: number | null = null;
  _portSource: string | null = null;

  _database: string | null = null;
  _databaseSource: string | null = null;

  _user: string | null = null;
  _userSource: string | null = null;

  _password: string | null = null;
  _passwordSource: string | null = null;

  _tlsCAData: string | null = null;
  _tlsCADataSource: string | null = null;

  _tlsVerifyHostname: boolean | null = null;
  _tlsVerifyHostnameSource: string | null = null;

  serverSettings: {[key: string]: string} = {};

  constructor() {
    this.setHost = this.setHost.bind(this);
    this.setPort = this.setPort.bind(this);
    this.setDatabase = this.setDatabase.bind(this);
    this.setUser = this.setUser.bind(this);
    this.setPassword = this.setPassword.bind(this);
    this.setTlsCAData = this.setTlsCAData.bind(this);
    this.setTlsCAFile = this.setTlsCAFile.bind(this);
    this.setTlsVerifyHostname = this.setTlsVerifyHostname.bind(this);
  }

  _setParam<
    Param extends
      | "host"
      | "port"
      | "database"
      | "user"
      | "password"
      | "tlsCAData"
      | "tlsVerifyHostname",
    Value extends any
  >(
    param: Param,
    value: Value,
    source: string,
    validator?: (value: NonNullable<Value>) => this[`_${Param}`]
  ): boolean {
    if (this[`_${param}`] === null) {
      this[`_${param}Source`] = source;
      if (value !== null) {
        this[`_${param}`] = validator
          ? validator(value as any)
          : (value as any);
        return true;
      }
    }
    return false;
  }

  setHost(host: string | null, source: string): boolean {
    return this._setParam("host", host, source, validateHost);
  }

  setPort(port: string | number | null, source: string): boolean {
    return this._setParam("port", port, source, parseValidatePort);
  }

  setDatabase(database: string | null, source: string): boolean {
    return this._setParam("database", database, source, (db: string) => {
      if (db === "") {
        throw new Error(`invalid database name: '${db}'`);
      }
      return db;
    });
  }

  setUser(user: string | null, source: string): boolean {
    return this._setParam("user", user, source, (_user: string) => {
      if (_user === "") {
        throw new Error(`invalid user name: '${_user}'`);
      }
      return _user;
    });
  }

  setPassword(password: string | null, source: string): boolean {
    return this._setParam("password", password, source);
  }

  setTlsCAData(caData: string | null, source: string): boolean {
    return this._setParam("tlsCAData", caData, source);
  }

  setTlsCAFile(caFile: string | null, source: string): boolean {
    return this._setParam("tlsCAData", caFile, source, (caFilePath) =>
      readFileUtf8Sync(caFilePath)
    );
  }

  setTlsVerifyHostname(
    verifyHostname: boolean | string | null,
    source: string
  ): boolean {
    return this._setParam(
      "tlsVerifyHostname",
      verifyHostname,
      source,
      (verifyHN) =>
        typeof verifyHN === "boolean"
          ? verifyHN
          : parseVerifyHostname(verifyHN)
    );
  }

  addServerSettings(settings: {[key: string]: string}): void {
    this.serverSettings = {
      ...settings,
      ...this.serverSettings,
    };
  }

  get address(): Address {
    return [this._host ?? "localhost", this._port ?? 5656];
  }

  get database(): string {
    return this._database ?? "edgedb";
  }

  get user(): string {
    return this._user ?? "edgedb";
  }

  get password(): string | undefined {
    return this._password ?? undefined;
  }

  get tlsVerifyHostname(): boolean {
    return (
      this._tlsVerifyHostname ?? (this._tlsCAData === null ? true : false)
    );
  }

  private _tlsOptions?: tls.ConnectionOptions;
  get tlsOptions(): tls.ConnectionOptions {
    if (this._tlsOptions) {
      return this._tlsOptions;
    }

    this._tlsOptions = {ALPNProtocols: ["edgedb-binary"]};

    if (this._tlsCAData !== null) {
      // this option replaces the system CA certificates with the one provided.
      this._tlsOptions.ca = this._tlsCAData;
    }

    if (!this.tlsVerifyHostname) {
      this._tlsOptions.checkServerIdentity = (hostname: string, cert: any) => {
        const err = tls.checkServerIdentity(hostname, cert);

        if (err === undefined) {
          return undefined;
        }

        // ignore failed hostname check
        if (err.message.startsWith("Hostname/IP does not match certificate")) {
          return undefined;
        }

        return err;
      };
    }

    return this._tlsOptions;
  }

  explainConfig(): string {
    const output: string[] = [];

    const outputLine = (param: string, val: any, rawVal: any, source: any) => {
      output.push(
        `${param}: ${typeof val === "string" ? `'${val}'` : val} from ${
          source
            ? `${source}${rawVal === null ? " (default)" : ""}`
            : "default"
        }`
      );
    };

    outputLine("host", this.address[0], this._host, this._hostSource);
    outputLine("port", this.address[1], this._port, this._portSource);
    outputLine(
      "database",
      this.database,
      this._database,
      this._databaseSource
    );
    outputLine("user", this.user, this._user, this._userSource);
    outputLine(
      "password",
      this.password,
      this._password,
      this._passwordSource
    );
    outputLine(
      "tlsCAData",
      this._tlsCAData ? this._tlsCAData.slice(0, 50) + "..." : this._tlsCAData,
      this._tlsCAData,
      this._tlsCADataSource
    );
    outputLine(
      "tlsVerifyHostname",
      this.tlsVerifyHostname,
      this._tlsVerifyHostname,
      this._tlsVerifyHostnameSource
    );

    return output.join("\n");
  }
}

function parseVerifyHostname(s: string): boolean {
  switch (s.toLowerCase()) {
    case "true":
    case "t":
    case "yes":
    case "y":
    case "on":
    case "1":
      return true;
    case "false":
    case "f":
    case "no":
    case "n":
    case "off":
    case "0":
      return false;
    default:
      throw new Error(`invalid tls_verify_hostname value: ${s}`);
  }
}

function parseValidatePort(port: string | number): number {
  let parsedPort: number;
  if (typeof port === "string") {
    if (!/^\d*$/.test(port)) {
      throw new Error(`invalid port: ${port}`);
    }
    parsedPort = parseInt(port, 10);
    if (Number.isNaN(parsedPort)) {
      throw new Error(`invalid port: ${port}`);
    }
  } else {
    parsedPort = port;
  }
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return parsedPort;
}

function validateHost(host: string): string {
  if (host.includes("/")) {
    throw new Error(`unix socket paths not supported`);
  }
  if (!host.length || host.includes(",")) {
    throw new Error(`invalid host: '${host}'`);
  }
  return host;
}

function parseConnectDsnAndArgs(
  config: ConnectConfig,
  projectDir: string | null
): PartiallyNormalizedConfig {
  const resolvedConfig = new ResolvedConnectConfig();
  let fromEnv = false;
  let fromProject = false;

  const [dsn, instanceName]: [string | undefined, string | undefined] =
    config.dsn && /^[a-z]+:\/\//i.test(config.dsn)
      ? [config.dsn, undefined]
      : [undefined, config.dsn];

  // resolve explicit config options
  let {hasCompoundOptions} = resolveConfigOptions(
    resolvedConfig,
    {
      dsn,
      instanceName,
      credentialsFile: config.credentialsFile,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      tlsCAFile: config.tlsCAFile,
      tlsVerifyHostname: config.tlsVerifyHostname,
      serverSettings: config.serverSettings,
    },
    {
      dsn: `'dsnOrInstanceName' option (parsed as dsn)`,
      instanceName: `'dsnOrInstanceName' option (parsed as instance name)`,
      credentialsFile: `'credentialsFile' option`,
      host: `'host' option`,
      port: `'port' option`,
      database: `'database' option`,
      user: `'user' option`,
      password: `'password' option`,
      tlsCAFile: `'tlsCAFile' option`,
      tlsVerifyHostname: `'tlsVerifyHostname' option`,
      serverSettings: `'serverSettings' option`,
    },
    `Cannot have more than one of the following connection options: ` +
      `'dsnOrInstanceName', 'credentialsFile' or 'host'/'port'`
  );

  if (!hasCompoundOptions) {
    // resolve config from env vars

    let port: string | undefined = process.env.EDGEDB_PORT;
    if (resolvedConfig._port === null && port?.startsWith("tcp://")) {
      // EDGEDB_PORT is set by 'docker --link' so ignore and warn
      // tslint:disable-next-line: no-console
      console.warn(
        `EDGEDB_PORT in 'tcp://host:port' format, so will be ignored`
      );
      port = undefined;
    }

    ({hasCompoundOptions, anyOptionsUsed: fromEnv} = resolveConfigOptions(
      resolvedConfig,
      {
        dsn: process.env.EDGEDB_DSN,
        instanceName: process.env.EDGEDB_INSTANCE,
        credentialsFile: process.env.EDGEDB_CREDENTIALS_FILE,
        host: process.env.EDGEDB_HOST,
        port,
        database: process.env.EDGEDB_DATABASE,
        user: process.env.EDGEDB_USER,
        password: process.env.EDGEDB_PASSWORD,
        tlsCAFile: process.env.EDGEDB_TLS_CA_FILE,
        tlsVerifyHostname: process.env.EDGEDB_TLS_VERIFY_HOSTNAME,
      },
      {
        dsn: `'EDGEDB_DSN' environment variable`,
        instanceName: `'EDGEDB_INSTANCE' environment variable`,
        credentialsFile: `'EDGEDB_CREDENTIALS_FILE' environment variable`,
        host: `'EDGEDB_HOST' environment variable`,
        port: `'EDGEDB_PORT' environment variable`,
        database: `'EDGEDB_DATABASE' environment variable`,
        user: `'EDGEDB_USER' environment variable`,
        password: `'EDGEDB_PASSWORD' environment variable`,
        tlsCAFile: `'EDGEDB_TLS_CA_FILE' environment variable`,
        tlsVerifyHostname: `'EDGEDB_TLS_VERIFY_HOSTNAME' environment variable`,
      },
      `Cannot have more than one of the following connection environment variables: ` +
        `'EDGEDB_DSN', 'EDGEDB_INSTANCE', 'EDGEDB_CREDENTIALS_FILE' or 'EDGEDB_HOST'`
    ));
  }

  if (!hasCompoundOptions) {
    // resolve config from project
    if (!projectDir) {
      throw new errors.ClientConnectionError(
        "no 'edgedb.toml' found and no connection options specified" +
          " either via arguments to `connect()` API or via environment" +
          " variables EDGEDB_HOST, EDGEDB_INSTANCE, EDGEDB_DSN or EDGEDB_CREDENTIALS_FILE"
      );
    }
    const stashDir = stashPath(projectDir);
    if (fs.existsSync(stashDir)) {
      const instName = readFileUtf8Sync(
        path.join(stashDir, "instance-name")
      ).trim();

      resolveConfigOptions(
        resolvedConfig,
        {instanceName: instName},
        {instanceName: `project linked instance ('${instName}')`},
        ""
      );
      fromProject = true;
    } else {
      throw new errors.ClientConnectionError(
        "Found 'edgedb.toml' but the project is not initialized. " +
          "Run `edgedb project init`."
      );
    }
  }

  return {
    connectionParams: resolvedConfig,
    inProject: !!projectDir,
    fromEnv,
    fromProject,
  };
}

function stashPath(projectDir: string): string {
  let projectPath = fs.realpathSync(projectDir);
  if (platform.isWindows && !projectPath.startsWith("\\\\")) {
    projectPath = "\\\\?\\" + projectPath;
  }

  const hash = crypto.createHash("sha1").update(projectPath).digest("hex");
  const baseName = path.basename(projectPath);
  const dirName = baseName + "-" + hash;

  return platform.searchConfigDir("projects", dirName);
}

function findProjectDir(): string | null {
  let dir = process.cwd();
  const cwdDev = fs.statSync(dir).dev;
  while (true) {
    if (fs.existsSync(path.join(dir, "edgedb.toml"))) {
      return dir;
    }
    const parentDir = path.join(dir, "..");
    if (parentDir === dir || fs.statSync(parentDir).dev !== cwdDev) {
      return null;
    }
    dir = parentDir;
  }
}

interface ResolveConfigOptionsConfig {
  dsn: string;
  instanceName: string;
  credentialsFile: string;
  host: string;
  port: number | string;
  database: string;
  user: string;
  password: string;
  tlsCAFile: string;
  tlsVerifyHostname: boolean | string;
  serverSettings: {[key: string]: string};
}

function resolveConfigOptions<
  Config extends Partial<ResolveConfigOptionsConfig>
>(
  resolvedConfig: ResolvedConnectConfig,
  config: Config,
  sources: {[key in keyof Config]: string},
  compoundParamsError: string
): {hasCompoundOptions: boolean; anyOptionsUsed: boolean} {
  let anyOptionsUsed = false;

  anyOptionsUsed =
    resolvedConfig.setDatabase(config.database ?? null, sources.database!) ||
    anyOptionsUsed;
  anyOptionsUsed =
    resolvedConfig.setUser(config.user ?? null, sources.user!) ||
    anyOptionsUsed;
  anyOptionsUsed =
    resolvedConfig.setPassword(config.password ?? null, sources.password!) ||
    anyOptionsUsed;
  anyOptionsUsed =
    resolvedConfig.setTlsCAFile(
      config.tlsCAFile ?? null,
      sources.tlsCAFile!
    ) || anyOptionsUsed;
  anyOptionsUsed =
    resolvedConfig.setTlsVerifyHostname(
      config.tlsVerifyHostname ?? null,
      sources.tlsVerifyHostname!
    ) || anyOptionsUsed;
  resolvedConfig.addServerSettings(config.serverSettings ?? {});

  const compoundParamsCount = [
    config.dsn,
    config.instanceName,
    config.credentialsFile,
    config.host ?? config.port,
  ].filter((param) => param !== undefined).length;

  if (compoundParamsCount > 1) {
    throw new Error(compoundParamsError);
  }

  if (compoundParamsCount === 1) {
    if (
      config.dsn !== undefined ||
      config.host !== undefined ||
      config.port !== undefined
    ) {
      let dsn = config.dsn;
      if (dsn === undefined) {
        if (config.port !== undefined) {
          resolvedConfig.setPort(config.port, sources.port!);
        }
        dsn = `edgedb://${
          config.host != null ? validateHost(config.host) : ""
        }`;
      }
      parseDSNIntoConfig(
        dsn,
        resolvedConfig,
        config.dsn
          ? sources.dsn!
          : config.host !== undefined
          ? sources.host!
          : sources.port!
      );
    } else {
      let credentialsFile = config.credentialsFile;
      if (credentialsFile === undefined) {
        if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(config.instanceName!)) {
          throw new Error(
            `invalid DSN or instance name: '${config.instanceName}'`
          );
        }
        credentialsFile = getCredentialsPath(config.instanceName!);
      }
      const creds = readCredentialsFile(credentialsFile);

      const source = config.credentialsFile
        ? sources.credentialsFile!
        : sources.instanceName!;

      resolvedConfig.setHost(creds.host ?? null, source);
      resolvedConfig.setPort(creds.port ?? null, source);
      resolvedConfig.setDatabase(creds.database ?? null, source);
      resolvedConfig.setUser(creds.user ?? null, source);
      resolvedConfig.setPassword(creds.password ?? null, source);
      resolvedConfig.setTlsCAData(creds.tlsCAData ?? null, source);
      resolvedConfig.setTlsVerifyHostname(
        creds.tlsVerifyHostname ?? null,
        source
      );
    }
    return {hasCompoundOptions: true, anyOptionsUsed: true};
  }

  return {hasCompoundOptions: false, anyOptionsUsed};
}

function parseDSNIntoConfig(
  dsnString: string,
  config: ResolvedConnectConfig,
  source: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(dsnString);
  } catch (e) {
    throw new Error(`invalid DSN or instance name: '${dsnString}'`);
  }

  if (parsed.protocol !== "edgedb:") {
    throw new Error(
      `invalid DSN: scheme is expected to be ` +
        `'edgedb', got '${parsed.protocol.slice(0, -1)}'`
    );
  }

  const searchParams = new Map<string, string>();
  for (const [key, value] of parsed.searchParams) {
    if (searchParams.has(key)) {
      throw new Error(`invalid DSN: duplicate query parameter '${key}'`);
    }
    searchParams.set(key, value);
  }

  function handleDSNPart(
    paramName: string,
    value: string | null,
    currentValue: any,
    setter: (value: string | null, source: string) => void,
    formatter: (val: string) => string = (val) => val
  ): void {
    if (
      [
        value || null,
        searchParams.get(paramName),
        searchParams.get(`${paramName}_env`),
        searchParams.get(`${paramName}_file`),
      ].filter((param) => param != null).length > 1
    ) {
      throw new Error(
        `invalid DSN: more than one of ${
          value !== null ? `'${paramName}', ` : ""
        }'?${paramName}=', ` +
          `'?${paramName}_env=' or '?${paramName}_file=' was specified ${dsnString}`
      );
    }

    if (currentValue === null) {
      let param = value || (searchParams.get(paramName) ?? null);
      let paramSource = source;
      if (param === null) {
        const env = searchParams.get(`${paramName}_env`);
        if (env != null) {
          param = process.env[env] ?? null;
          if (param === null) {
            throw new Error(
              `'${paramName}_env' environment variable '${env}' doesn't exist`
            );
          }
          paramSource += ` (${paramName}_env: ${env})`;
        }
      }
      if (param === null) {
        const file = searchParams.get(`${paramName}_file`);
        if (file != null) {
          param = readFileUtf8Sync(file);
          paramSource += ` (${paramName}_file: ${file})`;
        }
      }

      param = param !== null ? formatter(param) : null;

      setter(param, paramSource);
    }

    searchParams.delete(paramName);
    searchParams.delete(`${paramName}_env`);
    searchParams.delete(`${paramName}_file`);
  }

  handleDSNPart("host", parsed.hostname, config._host, config.setHost);

  handleDSNPart("port", parsed.port, config._port, config.setPort);

  const stripLeadingSlash = (str: string) => str.replace(/^\//, "");
  handleDSNPart(
    "database",
    stripLeadingSlash(parsed.pathname),
    config._database,
    config.setDatabase,
    stripLeadingSlash
  );

  handleDSNPart("user", parsed.username, config._user, config.setUser);

  handleDSNPart(
    "password",
    parsed.password,
    config._password,
    config.setPassword
  );

  handleDSNPart("tls_cert_file", null, config._tlsCAData, config.setTlsCAFile);

  handleDSNPart(
    "tls_verify_hostname",
    null,
    config._tlsVerifyHostname,
    config.setTlsVerifyHostname
  );

  const serverSettings: any = {};
  for (const [key, value] of searchParams) {
    serverSettings[key] = value;
  }
  config.addServerSettings(serverSettings);
}
