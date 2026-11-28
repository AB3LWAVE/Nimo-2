import assert from 'node:assert/strict';
import test from 'node:test';
import { appCheckDevSetupState } from '../src/appCheckDevSetup.ts';
import {
  APP_CHECK_IDB_DEBUG_KEY,
  APP_CHECK_IDB_NAME,
  APP_CHECK_IDB_STORE,
  getAppCheckDebugReport,
  inspectAppCheckIndexedDb,
} from '../src/utils/appCheckDebug.ts';

function createMockIndexedDb(options: {
  oldVersion?: number;
  hasStore?: boolean;
  records?: Record<string, unknown>;
  openError?: string;
}): IDBFactory {
  return {
    open(_name: string, _version?: number) {
      const req: Record<string, unknown> = {
        error: null,
        result: null,
        transaction: {
          abort() {
            queueMicrotask(() => {
              if (typeof req.onerror === 'function') {
                (req.onerror as (ev: unknown) => void)({});
              }
            });
          },
        },
        onupgradeneeded: null,
        onblocked: null,
        onerror: null,
        onsuccess: null,
      };

      queueMicrotask(() => {
        if (options.openError) {
          req.error = { message: options.openError };
          if (typeof req.onerror === 'function') {
            (req.onerror as (ev: unknown) => void)({});
          }
          return;
        }

        if (options.oldVersion === 0) {
          if (typeof req.onupgradeneeded === 'function') {
            (req.onupgradeneeded as (ev: { oldVersion: number }) => void)({
              oldVersion: 0,
            });
          }
          return;
        }

        const hasStore = options.hasStore ?? true;
        const records = options.records ?? {};
        const db = {
          version: 1,
          objectStoreNames: {
            contains(storeName: string) {
              return hasStore && storeName === APP_CHECK_IDB_STORE;
            },
          },
          close() {},
          transaction() {
            const tx: Record<string, unknown> = {
              error: null,
              onerror: null,
              objectStore() {
                return {
                  get(key: string) {
                    const getReq: Record<string, unknown> = {
                      result: undefined,
                      onsuccess: null,
                      onerror: null,
                    };
                    queueMicrotask(() => {
                      if (Object.prototype.hasOwnProperty.call(records, key)) {
                        getReq.result = { compositeKey: key, value: records[key] };
                      }
                      if (typeof getReq.onsuccess === 'function') {
                        (getReq.onsuccess as (ev: unknown) => void)({});
                      }
                    });
                    return getReq;
                  },
                };
              },
            };
            return tx;
          },
        };

        req.result = db;
        if (typeof req.onsuccess === 'function') {
          (req.onsuccess as (ev: unknown) => void)({});
        }
      });

      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

test('appCheckDevSetupState keeps debug mode off outside Vite dev browser runtime', () => {
  assert.equal(appCheckDevSetupState.isDevMode, false);
  assert.equal(appCheckDevSetupState.debugModeActive, false);
  assert.equal(appCheckDevSetupState.tokenMode, 'disabled');
});

test('inspectAppCheckIndexedDb reports unavailable cleanly when IndexedDB is missing', async () => {
  const result = await inspectAppCheckIndexedDb('test-app-id', 100);
  assert.equal(result.indexedDbAvailable, false);
  assert.equal(result.databaseName, APP_CHECK_IDB_NAME);
  assert.equal(result.storeName, APP_CHECK_IDB_STORE);
  assert.equal(result.accessStatus, 'unavailable');
  assert.equal(result.debugTokenPresent, false);
});

test('inspectAppCheckIndexedDb aborts upgrade cleanly if database has not been initialized by SDK yet', async () => {
  const mockIdb = createMockIndexedDb({ oldVersion: 0 });
  const result = await inspectAppCheckIndexedDb('test-app-id', 200, mockIdb);
  assert.equal(result.indexedDbAvailable, true);
  assert.equal(result.accessStatus, 'not-initialized-yet');
  assert.equal(result.debugTokenPresent, false);
  assert.equal(result.errorMessage, null);
});

test('inspectAppCheckIndexedDb detects debug token presence without exposing the token value', async () => {
  const secretDebugUuid = '11111111-2222-4333-8444-555555555555';
  const secretCachedToken = 'eyJhbGciOiJFUzI1NiJ9.secret-cached-token';
  const mockIdb = createMockIndexedDb({
    oldVersion: 1,
    hasStore: true,
    records: {
      [APP_CHECK_IDB_DEBUG_KEY]: secretDebugUuid,
      'test-app-id-[DEFAULT]': { token: secretCachedToken },
    },
  });

  const result = await inspectAppCheckIndexedDb('test-app-id', 200, mockIdb);
  assert.equal(result.accessStatus, 'ok');
  assert.equal(result.storeExists, true);
  assert.equal(result.debugTokenPresent, true);
  assert.equal(result.cachedAppCheckTokenPresent, true);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secretDebugUuid), false);
  assert.equal(serialized.includes(secretCachedToken), false);
});

test('getAppCheckDebugReport never exposes API keys, site keys, or debug tokens', async () => {
  const secretDebugUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const mockIdb = createMockIndexedDb({
    oldVersion: 1,
    hasStore: true,
    records: {
      [APP_CHECK_IDB_DEBUG_KEY]: secretDebugUuid,
    },
  });

  const report = await getAppCheckDebugReport(mockIdb);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secretDebugUuid), false);
  assert.equal(serialized.includes('AIzaSy'), false);
  assert.equal(serialized.includes('6Ldp2Cwu'), false);
  assert.equal(report.indexedDb.debugTokenPresent, true);
});
