#!/usr/bin/env node

import { createSign, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

const apiBaseUrl = 'https://api.wise.com';
const defaultCurrencies = ['USD', 'EUR', 'GBP'];
const maxStatementDays = 469;

type CliOptions = {
  currencies: string[];
  end?: string;
  generateKeypair: boolean;
  help: boolean;
  listProfiles: boolean;
  outputDir: string;
  privateKeyPath?: string;
  profileId?: number;
  profileName?: string;
  statementLocale: string;
  statementType: 'COMPACT' | 'FLAT';
  start?: string;
};

type WiseProfile = {
  id: number;
  type: string;
  businessName?: string;
  companyRole?: string;
  currentState?: string;
  details?: Record<string, unknown>;
  firstName?: string;
  fullName?: string;
  lastName?: string;
};

type WiseBalance = {
  id: number | string;
  currency: string;
  type?: string;
};

type WiseRequest = {
  path: string;
  privateKeyPath: string;
  query?: Record<string, string>;
  token: string;
};

function usage() {
  return `Usage:
  node src/get-statements.ts --start YYYY-MM-DD --end YYYY-MM-DD [options]
  pnpm statements --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --profile-id ID          Skip the interactive profile picker
  --profile-name NAME      Use the active profile whose name exactly matches NAME
  --currencies LIST        Comma-separated currencies (default: USD,EUR,GBP)
  --output-dir DIR         Directory for JSON output files (default: statements)
  --type COMPACT|FLAT      Wise statement type (default: COMPACT)
  --locale en              Statement locale (default: en)
  --private-key PATH       RSA private key for SCA signing (default: WISE_PRIVATE_KEY_PATH or keys/wise-private.pem)
  --list-profiles          Print profiles visible to the token, then exit
  --generate-keypair       Generate keys/wise-private.pem and keys/wise-public.pem, then exit
  --help                   Show this help

Date arguments accept YYYY-MM-DD or any ISO-8601 date-time. Date-only values are treated as UTC day bounds.`;
}

function loadEnvFileIfPresent() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
}

function valueForArg(args: string[], index: number, argName: string, inlineValue?: string) {
  if (inlineValue !== undefined) {
    return { value: inlineValue, nextIndex: index };
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argName} requires a value.`);
  }

  return { value, nextIndex: index + 1 };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    currencies: defaultCurrencies,
    generateKeypair: false,
    help: false,
    listProfiles: false,
    outputDir: 'statements',
    statementLocale: 'en',
    statementType: 'COMPACT',
  };

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index];
    if (rawArg === '--') {
      continue;
    }

    const [argName, inlineValue] = rawArg.includes('=') ? rawArg.split(/=(.*)/s, 2) : [rawArg, undefined];

    switch (argName) {
      case '--start': {
        const result = valueForArg(args, index, argName, inlineValue);
        options.start = result.value;
        index = result.nextIndex;
        break;
      }
      case '--end': {
        const result = valueForArg(args, index, argName, inlineValue);
        options.end = result.value;
        index = result.nextIndex;
        break;
      }
      case '--profile-id': {
        const result = valueForArg(args, index, argName, inlineValue);
        const profileId = Number(result.value);
        if (!Number.isInteger(profileId) || profileId <= 0) {
          throw new Error('--profile-id must be a positive integer.');
        }
        options.profileId = profileId;
        index = result.nextIndex;
        break;
      }
      case '--profile-name': {
        const result = valueForArg(args, index, argName, inlineValue);
        if (result.value.length === 0) {
          throw new Error('--profile-name must not be empty.');
        }
        options.profileName = result.value;
        index = result.nextIndex;
        break;
      }
      case '--currencies': {
        const result = valueForArg(args, index, argName, inlineValue);
        const currencies = result.value
          .split(/[\s,]+/)
          .map((currency) => currency.trim().toUpperCase())
          .filter(Boolean);
        if (currencies.length === 0) {
          throw new Error('--currencies must include at least one currency code.');
        }
        options.currencies = currencies;
        index = result.nextIndex;
        break;
      }
      case '--output-dir': {
        const result = valueForArg(args, index, argName, inlineValue);
        options.outputDir = result.value;
        index = result.nextIndex;
        break;
      }
      case '--type': {
        const result = valueForArg(args, index, argName, inlineValue);
        const statementType = result.value.toUpperCase();
        if (statementType !== 'COMPACT' && statementType !== 'FLAT') {
          throw new Error('--type must be COMPACT or FLAT.');
        }
        options.statementType = statementType;
        index = result.nextIndex;
        break;
      }
      case '--locale': {
        const result = valueForArg(args, index, argName, inlineValue);
        options.statementLocale = result.value;
        index = result.nextIndex;
        break;
      }
      case '--private-key': {
        const result = valueForArg(args, index, argName, inlineValue);
        options.privateKeyPath = result.value;
        index = result.nextIndex;
        break;
      }
      case '--generate-keypair':
        options.generateKeypair = true;
        break;
      case '--list-profiles':
        options.listProfiles = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${rawArg}`);
    }
  }

  return options;
}

function requireApiToken() {
  const token = process.env.WISE_API_TOKEN?.trim();
  if (!token) {
    throw new Error('WISE_API_TOKEN is missing. Put it in .env or export it in your shell.');
  }
  return token;
}

function normalizePrivateKeyPath(options: CliOptions) {
  return options.privateKeyPath ?? process.env.WISE_PRIVATE_KEY_PATH ?? 'keys/wise-private.pem';
}

function statementInterval(options: CliOptions) {
  if (!options.start || !options.end) {
    throw new Error('--start and --end are required unless you use --help, --list-profiles, or --generate-keypair.');
  }

  const intervalStart = parseDateTimeArg(options.start, false);
  const intervalEnd = parseDateTimeArg(options.end, true);
  const startMs = Date.parse(intervalStart);
  const endMs = Date.parse(intervalEnd);

  if (endMs <= startMs) {
    throw new Error('--end must be after --start.');
  }

  const days = (endMs - startMs) / 86_400_000;
  if (days > maxStatementDays) {
    throw new Error(`Wise statement intervals cannot exceed ${maxStatementDays} days.`);
  }

  return { intervalStart, intervalEnd };
}

function parseDateTimeArg(value: string, endOfDay: boolean) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid date/time: ${value}`);
  }

  return date.toISOString();
}

function publicKeyPathForPrivateKey(privateKeyPath: string) {
  const privatePath = resolve(privateKeyPath);
  const fileName = privatePath.endsWith('-private.pem')
    ? privatePath.replace(/-private\.pem$/, '-public.pem')
    : join(dirname(privatePath), 'wise-public.pem');
  return resolve(fileName);
}

function generateKeypair(privateKeyPath: string) {
  const privatePath = resolve(privateKeyPath);
  const publicPath = publicKeyPathForPrivateKey(privatePath);

  if (existsSync(privatePath)) {
    throw new Error(`Refusing to overwrite existing private key: ${privatePath}`);
  }
  if (existsSync(publicPath)) {
    throw new Error(`Refusing to overwrite existing public key: ${publicPath}`);
  }

  mkdirSync(dirname(privatePath), { recursive: true });
  mkdirSync(dirname(publicPath), { recursive: true });

  const keypair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });

  writeFileSync(privatePath, keypair.privateKey, { mode: 0o600 });
  writeFileSync(publicPath, keypair.publicKey, { mode: 0o644 });
  chmodSync(privatePath, 0o600);
  chmodSync(publicPath, 0o644);

  console.log(`Generated private key: ${privatePath}`);
  console.log(`Generated public key:  ${publicPath}`);
  console.log('Upload the public key in Wise under API tokens / Manage public keys, then rerun the statement command.');
}

async function wiseGetJson(request: WiseRequest) {
  const url = new URL(request.path, apiBaseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = { Authorization: `Bearer ${request.token}` };
  let response = await fetch(url, { headers });

  if (response.ok) {
    return parseJsonResponse(response);
  }

  const oneTimeToken = response.headers.get('x-2fa-approval');
  if (response.status === 403 && oneTimeToken) {
    if (!existsSync(request.privateKeyPath)) {
      throw new Error(
        `Wise requested SCA, but no private key exists at ${request.privateKeyPath}. ` +
          'Run `pnpm generate-keypair`, upload keys/wise-public.pem to Wise, then rerun this command.',
      );
    }

    const signature = signOneTimeToken(oneTimeToken, request.privateKeyPath);
    response = await fetch(url, {
      headers: {
        ...headers,
        'x-2fa-approval': oneTimeToken,
        'X-Signature': signature,
      },
    });

    if (response.ok) {
      return parseJsonResponse(response);
    }

    if (response.status === 403) {
      throw await scaSignatureError(response, request.privateKeyPath);
    }
  }

  throw await wiseError(response);
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Wise returned non-JSON response from ${response.url}: ${text.slice(0, 500)}`);
  }
}

async function wiseError(response: Response) {
  const text = await response.text();
  const body = text ? `: ${text.slice(0, 1_000)}` : '';
  return new Error(`Wise API HTTP ${response.status} ${response.statusText}${body}`);
}

async function scaSignatureError(response: Response, privateKeyPath: string) {
  const text = await response.text();
  const result = response.headers.get('x-2fa-approval-result');
  const resultText = result ? ` (${result})` : '';
  const body = text ? ` Wise response: ${text.slice(0, 1_000)}` : '';
  return new Error(
    `Wise rejected the SCA signature${resultText}. Upload ${publicKeyPathForPrivateKey(privateKeyPath)} ` +
      `under Wise API tokens / Manage public keys, and make sure it matches ${resolve(privateKeyPath)}.${body}`,
  );
}

function signOneTimeToken(oneTimeToken: string, privateKeyPath: string) {
  const privateKey = readFileSync(privateKeyPath, 'utf8');
  const signer = createSign('RSA-SHA256');
  signer.update(oneTimeToken);
  return signer.sign(privateKey, 'base64');
}

async function getProfiles(token: string, privateKeyPath: string) {
  const profiles = await wiseGetJson({ path: '/v2/profiles', privateKeyPath, token });
  if (!Array.isArray(profiles)) {
    throw new Error('Wise returned an unexpected profiles response.');
  }
  return profiles as WiseProfile[];
}

function profileName(profile: WiseProfile) {
  const details = profile.details ?? {};
  if (typeof profile.businessName === 'string') {
    return profile.businessName;
  }
  if (typeof profile.fullName === 'string') {
    return profile.fullName;
  }
  if (typeof details.name === 'string') {
    return details.name;
  }

  const firstName = typeof profile.firstName === 'string'
    ? profile.firstName
    : typeof details.firstName === 'string'
      ? details.firstName
      : '';
  const lastName = typeof profile.lastName === 'string'
    ? profile.lastName
    : typeof details.lastName === 'string'
      ? details.lastName
      : '';
  return [firstName, lastName].filter(Boolean).join(' ');
}

function profileLabel(profile: WiseProfile) {
  const name = profileName(profile);
  const details = profile.details ?? {};
  const roleValue = typeof profile.companyRole === 'string' ? profile.companyRole : details.companyRole;
  const role = typeof roleValue === 'string' ? `, role=${roleValue}` : '';
  const state = profile.currentState ? `, state=${profile.currentState}` : '';
  return `id=${profile.id}, type=${profile.type}${state}${name ? `, name=${name}` : ''}${role}`;
}

async function selectProfileByName(token: string, privateKeyPath: string, name: string) {
  const profiles = (await getProfiles(token, privateKeyPath)).filter((profile) => profile.currentState !== 'DEACTIVATED');
  const matches = profiles.filter((profile) => profileName(profile) === name);

  if (matches.length === 1) {
    return matches[0].id;
  }

  if (matches.length > 1) {
    throw new Error(`Multiple active Wise profiles exactly matched name ${JSON.stringify(name)}. Use --profile-id instead.`);
  }

  const activeProfiles = profiles.map((profile) => `  - ${profileLabel(profile)}`).join('\n');
  throw new Error(`No active Wise profile exactly matched name ${JSON.stringify(name)}. Active profiles:\n${activeProfiles}`);
}

async function selectProfile(token: string, privateKeyPath: string) {
  const allProfiles = await getProfiles(token, privateKeyPath);
  const profiles = allProfiles.filter((profile) => profile.currentState !== 'DEACTIVATED');

  if (profiles.length === 0) {
    throw new Error('The token can access no active Wise profiles.');
  }

  console.log('Active profiles visible to this token:');
  profiles.forEach((profile, index) => {
    console.log(`  ${index + 1}) ${profileLabel(profile)}`);
  });

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await readline.question('Choose a profile number or profile id: ')).trim();
      const numericAnswer = Number(answer);
      if (Number.isInteger(numericAnswer)) {
        const byNumber = profiles[numericAnswer - 1];
        if (byNumber) {
          return byNumber.id;
        }

        const byId = profiles.find((profile) => profile.id === numericAnswer);
        if (byId) {
          return byId.id;
        }
      }
      console.log('Invalid choice. Try again.');
    }
  } finally {
    readline.close();
  }
}

async function getBalances(token: string, privateKeyPath: string, profileId: number) {
  const balances = await wiseGetJson({
    path: `/v4/profiles/${profileId}/balances`,
    privateKeyPath,
    query: { types: 'STANDARD' },
    token,
  });

  if (!Array.isArray(balances)) {
    throw new Error('Wise returned an unexpected balances response.');
  }

  return balances as WiseBalance[];
}

function balanceForCurrency(balances: WiseBalance[], currency: string) {
  const matches = balances.filter((balance) => balance.currency === currency);
  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length > 1) {
    console.warn(`Multiple ${currency} standard balances found. Using the first one returned by Wise.`);
  }

  return matches[0];
}

async function getStatement(args: {
  balanceId: number | string;
  currency: string;
  intervalEnd: string;
  intervalStart: string;
  privateKeyPath: string;
  profileId: number;
  statementLocale: string;
  statementType: string;
  token: string;
}) {
  return wiseGetJson({
    path: `/v1/profiles/${args.profileId}/balance-statements/${args.balanceId}/statement.json`,
    privateKeyPath: args.privateKeyPath,
    query: {
      currency: args.currency,
      intervalEnd: args.intervalEnd,
      intervalStart: args.intervalStart,
      statementLocale: args.statementLocale,
      type: args.statementType,
    },
    token: args.token,
  });
}

function writeStatementFile(args: {
  balanceId: number | string;
  currency: string;
  intervalEnd: string;
  intervalStart: string;
  outputDir: string;
  profileId: number;
  statement: unknown;
  statementType: string;
}) {
  mkdirSync(args.outputDir, { recursive: true });
  const fileName = `${args.currency}-${args.intervalStart.slice(0, 10)}_${args.intervalEnd.slice(0, 10)}.json`;
  const outputPath = join(args.outputDir, fileName);
  const payload = {
    balanceId: args.balanceId,
    currency: args.currency,
    downloadedAt: new Date().toISOString(),
    intervalEnd: args.intervalEnd,
    intervalStart: args.intervalStart,
    profileId: args.profileId,
    statement: args.statement,
    type: args.statementType,
  };

  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

async function main() {
  loadEnvFileIfPresent();
  const options = parseArgs(process.argv.slice(2));
  const privateKeyPath = normalizePrivateKeyPath(options);

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.generateKeypair) {
    generateKeypair(privateKeyPath);
    return;
  }

  if (options.profileId !== undefined && options.profileName !== undefined) {
    throw new Error('--profile-id and --profile-name cannot be used together.');
  }

  const token = requireApiToken();

  if (options.listProfiles) {
    const profiles = await getProfiles(token, privateKeyPath);
    profiles.forEach((profile, index) => console.log(`${index + 1}) ${profileLabel(profile)}`));
    return;
  }

  const { intervalStart, intervalEnd } = statementInterval(options);
  const profileId = options.profileId
    ?? (options.profileName !== undefined
      ? await selectProfileByName(token, privateKeyPath, options.profileName)
      : await selectProfile(token, privateKeyPath));
  const balances = await getBalances(token, privateKeyPath, profileId);
  const failures: string[] = [];

  for (const currency of options.currencies) {
    const balance = balanceForCurrency(balances, currency);
    if (!balance) {
      failures.push(`${currency}: no standard balance found`);
      console.error(`${currency}: no standard balance found`);
      continue;
    }

    try {
      const statement = await getStatement({
        balanceId: balance.id,
        currency,
        intervalEnd,
        intervalStart,
        privateKeyPath,
        profileId,
        statementLocale: options.statementLocale,
        statementType: options.statementType,
        token,
      });
      const outputPath = writeStatementFile({
        balanceId: balance.id,
        currency,
        intervalEnd,
        intervalStart,
        outputDir: options.outputDir,
        profileId,
        statement,
        statementType: options.statementType,
      });
      console.log(`${currency}: wrote ${outputPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${currency}: ${message}`);
      console.error(`${currency}: failed: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Finished with ${failures.length} failure(s).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
