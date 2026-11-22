import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvironmentSchema } from '../../../src/config/env/schema.js';
import { assertGatewayImplemented } from '../../../src/config/payment/payment.config.js';
import {
  resolvePushProviderName,
  resolveSmsProviderName,
} from '../../../src/modules/notifications/notification.config.js';
import { readScanner } from '../../../src/modules/files/config/storage.config.js';
import { assertRestrictedDatabaseRole } from '../../../src/bootstrap/database.bootstrap.js';
import { hashAccountNumber } from '../../../src/shared/crypto/bank-account-crypto.js';
import { shouldLogDevOtp } from '../../../src/modules/auth/services/otp/dev-otp-log.js';
import { origins } from '../../../src/config/realtime/realtime.config.js';

/// Every name APP_ENV accepts, and how each safety rule must treat it. The legacy names
/// (development, testing, production) must behave exactly like local, test and prod:
/// a guard that knows only one spelling silently switches itself off for the other.
const NAMES = [
  { name: 'local', deployed: false, realUsers: false, devMachine: true },
  { name: 'development', deployed: false, realUsers: false, devMachine: true },
  { name: 'test', deployed: false, realUsers: false, devMachine: false },
  { name: 'testing', deployed: false, realUsers: false, devMachine: false },
  { name: 'dev', deployed: true, realUsers: false, devMachine: false },
  { name: 'staging', deployed: true, realUsers: true, devMachine: false },
  { name: 'prod', deployed: true, realUsers: true, devMachine: false },
  { name: 'production', deployed: true, realUsers: true, devMachine: false },
] as const;

const SECRET = 'x'.repeat(40);
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: SECRET,
  JWT_REFRESH_SECRET: SECRET,
};
const DEPLOYED_KEYS = {
  ENCRYPTION_KEY: SECRET,
  RIDE_PIN_PEPPER: SECRET,
  BANK_DATA_ENCRYPTION_KEY: SECRET,
  BANK_ACCOUNT_HASH_KEY: SECRET,
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('APP_ENV schema', () => {
  it('refuses to boot without APP_ENV instead of defaulting to development', () => {
    assert.equal(EnvironmentSchema.safeParse(BASE).success, false);
  });

  it('refuses a name it does not know', () => {
    assert.equal(EnvironmentSchema.safeParse({ ...BASE, APP_ENV: 'prd' }).success, false);
  });

  for (const [legacy, canonical] of [
    ['development', 'local'],
    ['testing', 'test'],
    ['production', 'prod'],
    ['local', 'local'],
    ['dev', 'dev'],
    ['test', 'test'],
    ['staging', 'staging'],
    ['prod', 'prod'],
  ] as const) {
    it(`reports APP_ENV=${legacy} as "${canonical}"`, () => {
      const parsed = EnvironmentSchema.safeParse({ ...BASE, ...DEPLOYED_KEYS, APP_ENV: legacy });
      assert.equal(parsed.success && parsed.data.APP_ENV, canonical);
    });
  }

  for (const { name, deployed } of NAMES) {
    it(`${deployed ? 'requires' : 'does not require'} the deployment keys for APP_ENV=${name}`, () => {
      assert.equal(EnvironmentSchema.safeParse({ ...BASE, APP_ENV: name }).success, !deployed);
    });
  }
});

describe('safety rules apply to every spelling of a deployed environment', () => {
  for (const { name, deployed, realUsers } of NAMES) {
    it(`mock payment gateway is ${deployed ? 'refused' : 'allowed'} for APP_ENV=${name}`, () => {
      const run = () => assertGatewayImplemented('mock', name);
      if (deployed) assert.throws(run, /placeholder that performs no network call/);
      else assert.doesNotThrow(run);
    });

    it(`mock SMS is ${deployed ? 'refused' : 'allowed'} and the default is ${deployed ? 'airtel' : 'mock'} for APP_ENV=${name}`, () => {
      if (deployed) {
        assert.throws(() => resolveSmsProviderName(name, 'mock'), /delivers nothing/);
        assert.equal(resolveSmsProviderName(name, undefined), 'airtel');
      } else {
        assert.equal(resolveSmsProviderName(name, 'mock'), 'mock');
        assert.equal(resolveSmsProviderName(name, undefined), 'mock');
      }
    });

    it(`mock push is ${deployed ? 'refused' : 'allowed'} for APP_ENV=${name}`, () => {
      const run = () => resolvePushProviderName(name, 'mock');
      if (deployed) assert.throws(run, /delivers nothing/);
      else assert.equal(run(), 'mock');
    });

    // Real-user environments only: DEV runs on DigitalOcean Spaces, which GuardDuty cannot scan.
    it(`malware scanner is ${realUsers ? 'mandatory' : 'optional'} for APP_ENV=${name}`, () => {
      withEnv({ STORAGE_MALWARE_SCANNER: 'disabled' }, () => {
        if (realUsers) assert.throws(() => readScanner(name), /not permitted in/);
        else assert.equal(readScanner(name), 'disabled');
      });
      withEnv({ STORAGE_MALWARE_SCANNER: undefined }, () => {
        assert.equal(readScanner(name), realUsers ? 'guardduty' : 'disabled');
      });
    });

    it(`database role that can rewrite the audit trail is ${deployed ? 'refused' : 'tolerated'} for APP_ENV=${name}`, async () => {
      let queried = false;
      const ownerDb = {
        $queryRawUnsafe: async <T>() => {
          queried = true;
          return [{ role: 'zaroorat', superuser: true, owner: true, rewrite: true }] as T;
        },
      };
      if (deployed) {
        await assert.rejects(assertRestrictedDatabaseRole(ownerDb, name), /Refusing to start/);
      } else {
        await assertRestrictedDatabaseRole(ownerDb, name);
        assert.equal(queried, false);
      }
    });

    it(`bank-account keys are ${deployed ? 'mandatory' : 'derived locally'} for APP_ENV=${name}`, () => {
      withEnv(
        { APP_ENV: name, BANK_DATA_ENCRYPTION_KEY: undefined, BANK_ACCOUNT_HASH_KEY: undefined },
        () => {
          if (deployed) assert.throws(() => hashAccountNumber('123456789012'), /must be set/);
          else assert.match(hashAccountNumber('123456789012'), /^[0-9a-f]{64}$/);
        },
      );
    });
  }
});

describe('developer-machine conveniences apply to local and development alike', () => {
  for (const { name, devMachine } of NAMES) {
    it(`OTP is ${devMachine ? 'printed' : 'never printed'} with mock SMS for APP_ENV=${name}`, () => {
      assert.equal(shouldLogDevOtp(name, 'mock'), devMachine);
    });
  }

  it('reads REALTIME_CORS_ORIGINS="*" as any origin, not as the literal origin "*"', () => {
    withEnv({ REALTIME_CORS_ORIGINS: '*' }, () => assert.equal(origins(), true));
  });
});
