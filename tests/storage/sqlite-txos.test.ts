import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TxoStorageSQLite } from "../../src/storage/sqlite/sqlite-txos";
import { Txo, TxoStatus } from "../../src/models/txo";
import { Outpoint } from "../../src/models/outpoint";
import { Block } from "../../src/models/block";
import { IngestStatus, type Ingest } from "../../src/models/ingest";
import { ParseMode, TxLog } from "../../src/models";
import { TxoLookup, TxoSort } from "../../src/models/search";
import { mkdirSync, rmSync } from "node:fs";

describe("TxoStorageSQLite", () => {
  let storage: TxoStorageSQLite;
  const testDbPath = "/tmp/spv-store-test";

  // Mock TxnStore
  const mockTxnStore = {} as any;

  beforeEach(() => {
    mkdirSync(testDbPath, { recursive: true });
    storage = TxoStorageSQLite.init("test-account", "testnet", mockTxnStore, testDbPath);
  });

  afterEach(async () => {
    await storage.destroy();
    try {
      rmSync(`${testDbPath}/txos-test-account-testnet.db`, { force: true });
      rmSync(`${testDbPath}/txos-test-account-testnet.db-shm`, { force: true });
      rmSync(`${testDbPath}/txos-test-account-testnet.db-wal`, { force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  const createTestTxo = (
    txid: string,
    vout: number,
    satoshis = 1000n,
    status = TxoStatus.Validated
  ): Txo => {
    const txo = new Txo(
      new Outpoint(txid, vout),
      satoshis,
      [0x76, 0xa9, 0x14], // Script bytes
      status,
      new Block(100, 0n)
    );
    txo.owner = "1TestAddress";
    return txo;
  };

  test("should initialize with memory database when no path provided", () => {
    const memStorage = TxoStorageSQLite.init("test", "mainnet", mockTxnStore);
    expect(memStorage).toBeDefined();
    memStorage.destroy();
  });

  test("should put and get a single TXO", async () => {
    const txo = createTestTxo("abc123", 0);
    await storage.put(txo);

    const retrieved = await storage.get(new Outpoint("abc123", 0));
    expect(retrieved).toBeDefined();
    expect(retrieved?.outpoint.txid).toBe("abc123");
    expect(retrieved?.outpoint.vout).toBe(0);
    expect(retrieved?.satoshis).toBe(1000n);
    expect(retrieved?.owner).toBe("1TestAddress");
  });

  test("should return undefined for non-existent TXO", async () => {
    const retrieved = await storage.get(new Outpoint("nonexistent", 0));
    expect(retrieved).toBeUndefined();
  });

  test("should get many TXOs", async () => {
    const txos = [
      createTestTxo("tx1", 0),
      createTestTxo("tx2", 0),
      createTestTxo("tx3", 0),
    ];

    await storage.putMany(txos);

    const outpoints = [
      new Outpoint("tx1", 0),
      new Outpoint("tx2", 0),
      new Outpoint("tx3", 0),
    ];

    const retrieved = await storage.getMany(outpoints);
    expect(retrieved.length).toBe(3);
    expect(retrieved[0]?.outpoint.txid).toBe("tx1");
    expect(retrieved[1]?.outpoint.txid).toBe("tx2");
    expect(retrieved[2]?.outpoint.txid).toBe("tx3");
  });

  test("should handle missing TXOs in getMany", async () => {
    await storage.put(createTestTxo("tx1", 0));

    const outpoints = [
      new Outpoint("tx1", 0),
      new Outpoint("missing", 0),
    ];

    const retrieved = await storage.getMany(outpoints);
    expect(retrieved[0]?.outpoint.txid).toBe("tx1");
    expect(retrieved[1]).toBeUndefined();
  });

  test("should get TXOs by spend", async () => {
    const txo1 = createTestTxo("tx1", 0);
    txo1.spend = "spending_tx";
    const txo2 = createTestTxo("tx2", 0);
    txo2.spend = "spending_tx";
    const txo3 = createTestTxo("tx3", 0);
    txo3.spend = "other_tx";

    await storage.putMany([txo1, txo2, txo3]);

    const spent = await storage.getBySpend("spending_tx");
    expect(spent.length).toBe(2);
    expect(spent[0].spend).toBe("spending_tx");
    expect(spent[1].spend).toBe("spending_tx");
  });

  test("should get UTXOs (unspent with events)", async () => {
    const txo1 = createTestTxo("tx1", 0);
    txo1.spend = "";
    txo1.data = {
      testTag: {
        data: {},
        events: [{ id: "event1", value: "val1" }],
        deps: [],
      },
    };

    const txo2 = createTestTxo("tx2", 0);
    txo2.spend = "";
    txo2.data = {}; // No events, should not be included

    const txo3 = createTestTxo("tx3", 0);
    txo3.spend = "spent"; // Spent, should not be included
    txo3.data = {
      testTag: {
        data: {},
        events: [{ id: "event1", value: "val1" }],
        deps: [],
      },
    };

    await storage.putMany([txo1, txo2, txo3]);

    const utxos = await storage.getUtxos();
    expect(utxos.length).toBe(1);
    expect(utxos[0].outpoint.txid).toBe("tx1");
  });

  test("should backup TXOs with pagination", async () => {
    const txos: Txo[] = [];
    for (let i = 0; i < 15; i++) {
      txos.push(createTestTxo(`tx${i.toString().padStart(2, '0')}`, 0));
    }

    await storage.putMany(txos);

    const backup1 = await storage.backup(10);
    expect(backup1.txos.length).toBe(10);
    expect(backup1.nextPage).toBeDefined();

    const backup2 = await storage.backup(10, backup1.nextPage);
    expect(backup2.txos.length).toBeGreaterThan(0);
    expect(backup2.txos.length).toBeLessThanOrEqual(5);
  });

  test("should handle empty putMany", async () => {
    await storage.putMany([]);
    expect(true).toBe(true); // Should not throw
  });

  test("should store and retrieve state", async () => {
    await storage.setState("testKey", "testValue");
    const value = await storage.getState("testKey");
    expect(value).toBe("testValue");
  });

  test("should return undefined for non-existent state", async () => {
    const value = await storage.getState("nonexistent");
    expect(value).toBeUndefined();
  });

  test("should update existing state", async () => {
    await storage.setState("key", "value1");
    await storage.setState("key", "value2");
    const value = await storage.getState("key");
    expect(value).toBe("value2");
  });

  // Ingest queue tests
  test("should put and get ingest", async () => {
    const ingest: Ingest = {
      txid: "ingest1",
      height: 100,
      idx: 0,
      parseMode: ParseMode.Persist,
      status: IngestStatus.QUEUED,
    };

    await storage.putIngest(ingest);
    const retrieved = await storage.getIngest("ingest1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.txid).toBe("ingest1");
    expect(retrieved?.height).toBe(100);
    expect(retrieved?.status).toBe(IngestStatus.QUEUED);
  });

  test("should get queue length", async () => {
    const ingests: Ingest[] = [
      {
        txid: "ingest1",
        height: 100,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
      {
        txid: "ingest2",
        height: 101,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
      {
        txid: "ingest3",
        height: 102,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.INGESTED,
      },
    ];

    await storage.putIngests(ingests);
    const queueLength = await storage.getQueueLength();
    expect(queueLength).toBe(2); // Only QUEUED status
  });

  test("should get ingests by status", async () => {
    const ingests: Ingest[] = [
      {
        txid: "ingest1",
        height: 100,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
      {
        txid: "ingest2",
        height: 101,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
      {
        txid: "ingest3",
        height: 102,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.INGESTED,
      },
    ];

    await storage.putIngests(ingests);
    const queued = await storage.getIngests(IngestStatus.QUEUED, 10);
    expect(queued.length).toBe(2);
  });

  test("should merge outputs when putting duplicate ingest", async () => {
    const ingest1: Ingest = {
      txid: "merge_test",
      height: 100,
      idx: 0,
      parseMode: ParseMode.Persist,
      outputs: [0, 1],
      status: IngestStatus.QUEUED,
    };

    const ingest2: Ingest = {
      txid: "merge_test",
      height: 100,
      idx: 0,
      parseMode: ParseMode.Persist,
      outputs: [1, 2],
      status: IngestStatus.QUEUED,
    };

    await storage.putIngest(ingest1);
    await storage.putIngest(ingest2);

    const retrieved = await storage.getIngest("merge_test");
    expect(retrieved?.outputs).toEqual([0, 1, 2]);
  });

  test("should delete ingests", async () => {
    const ingest: Ingest = {
      txid: "delete_test",
      height: 100,
      idx: 0,
      parseMode: ParseMode.Persist,
      status: IngestStatus.QUEUED,
    };

    await storage.putIngest(ingest);
    await storage.delIngest("delete_test");

    const retrieved = await storage.getIngest("delete_test");
    expect(retrieved).toBeUndefined();
  });

  test("should delete multiple ingests", async () => {
    const ingests: Ingest[] = [
      {
        txid: "del1",
        height: 100,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
      {
        txid: "del2",
        height: 101,
        idx: 0,
        parseMode: ParseMode.Persist,
        status: IngestStatus.QUEUED,
      },
    ];

    await storage.putIngests(ingests);
    await storage.delIngests(["del1", "del2"]);

    const r1 = await storage.getIngest("del1");
    const r2 = await storage.getIngest("del2");
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });

  // TxLog tests
  test("should put and get tx log", async () => {
    const log = new TxLog("log1", 100, 0);
    log.source = "test";
    log.summary = { testTag: { id: "test" } };

    await storage.putTxLog(log);
    const retrieved = await storage.getTxLog("log1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.txid).toBe("log1");
    expect(retrieved?.height).toBe(100);
    expect(retrieved?.source).toBe("test");
    expect(retrieved?.summary).toEqual({ testTag: { id: "test" } });
  });

  test("should get multiple tx logs", async () => {
    const logs = [
      new TxLog("log1", 100, 0),
      new TxLog("log2", 101, 0),
      new TxLog("log3", 102, 0),
    ];

    await storage.putTxLogs(logs);
    const retrieved = await storage.getTxLogs(["log1", "log2", "log3"]);

    expect(retrieved.length).toBe(3);
    expect(retrieved[0]?.txid).toBe("log1");
    expect(retrieved[1]?.txid).toBe("log2");
    expect(retrieved[2]?.txid).toBe("log3");
  });

  test("should get recent tx logs", async () => {
    const logs = [
      new TxLog("log1", 100, 0),
      new TxLog("log2", 101, 0),
      new TxLog("log3", 102, 0),
    ];

    await storage.putTxLogs(logs);
    const recent = await storage.getRecentTxLogs(2);

    expect(recent.length).toBe(2);
    // Should be ordered by height DESC
    expect(recent[0].height).toBe(102);
    expect(recent[1].height).toBe(101);
  });

  test("should backup tx logs with pagination", async () => {
    const logs: TxLog[] = [];
    for (let i = 0; i < 15; i++) {
      logs.push(new TxLog(`log${i.toString().padStart(2, '0')}`, 100 + i, 0));
    }

    await storage.putTxLogs(logs);

    const backup1 = await storage.backupTxLogs(10);
    expect(backup1.logs.length).toBe(10);
    expect(backup1.nextPage).toBeDefined();

    const backup2 = await storage.backupTxLogs(10, backup1.nextPage);
    expect(backup2.logs.length).toBeGreaterThan(0);
    expect(backup2.logs.length).toBeLessThanOrEqual(5);
  });

  test("should handle concurrent TXO operations", async () => {
    const txo1 = createTestTxo("concurrent1", 0);
    const txo2 = createTestTxo("concurrent2", 0);
    const txo3 = createTestTxo("concurrent3", 0);

    await Promise.all([
      storage.put(txo1),
      storage.put(txo2),
      storage.put(txo3),
    ]);

    const [r1, r2, r3] = await Promise.all([
      storage.get(new Outpoint("concurrent1", 0)),
      storage.get(new Outpoint("concurrent2", 0)),
      storage.get(new Outpoint("concurrent3", 0)),
    ]);

    expect(r1?.outpoint.txid).toBe("concurrent1");
    expect(r2?.outpoint.txid).toBe("concurrent2");
    expect(r3?.outpoint.txid).toBe("concurrent3");
  });

  test("should preserve BigInt satoshis", async () => {
    const txo = createTestTxo("bigint_test", 0, 9007199254740991n); // MAX_SAFE_INTEGER
    await storage.put(txo);

    const retrieved = await storage.get(new Outpoint("bigint_test", 0));
    expect(retrieved?.satoshis).toBe(9007199254740991n);
  });

  test("should preserve script bytes", async () => {
    const txo = createTestTxo("script_test", 0);
    txo.script = [0x01, 0x02, 0x03, 0x04, 0x05];
    await storage.put(txo);

    const retrieved = await storage.get(new Outpoint("script_test", 0));
    expect(retrieved?.script).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
  });

  test("should handle TXO with complex data", async () => {
    const txo = createTestTxo("complex_data", 0);
    txo.data = {
      testTag: {
        data: { customField: "customValue" },
        events: [{ id: "event1", value: "val1" }],
        deps: [],
      },
    };
    await storage.put(txo);

    const retrieved = await storage.get(new Outpoint("complex_data", 0));
    expect(retrieved?.data.testTag).toBeDefined();
    expect(retrieved?.data.testTag.data.customField).toBe("customValue");
  });
});
