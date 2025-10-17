import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BlockStorageSQLite } from "../../src/storage/sqlite/sqlite-blocks";
import type { BlockHeader } from "../../src/models/block-header";
import { mkdirSync, rmSync } from "fs";

describe("BlockStorageSQLite", () => {
  let storage: BlockStorageSQLite;
  const testDbPath = "/tmp/spv-store-test";

  beforeEach(() => {
    mkdirSync(testDbPath, { recursive: true });
    storage = BlockStorageSQLite.init("testnet", testDbPath);
  });

  afterEach(async () => {
    await storage.destroy();
    try {
      rmSync(`${testDbPath}/blocks-testnet.db`, { force: true });
      rmSync(`${testDbPath}/blocks-testnet.db-shm`, { force: true });
      rmSync(`${testDbPath}/blocks-testnet.db-wal`, { force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  const createTestBlock = (height: number): BlockHeader => ({
    height,
    hash: `hash${height}`.padEnd(64, "0"),
    prevHash: `prev${height}`.padEnd(64, "0"),
    merkleRoot: `merkle${height}`.padEnd(64, "0"),
    time: 1000000 + height,
    version: 1,
    bits: "1d00ffff",
    nonce: height * 2,
  });

  test("should initialize with memory database when no path provided", () => {
    const memStorage = BlockStorageSQLite.init("mainnet");
    expect(memStorage).toBeDefined();
    memStorage.destroy();
  });

  test("should put and get a single block by height", async () => {
    const block = createTestBlock(100);
    await storage.put(block);

    const retrieved = await storage.getByHeight(100);
    expect(retrieved).toEqual(block);
  });

  test("should put and get a single block by hash", async () => {
    const block = createTestBlock(100);
    await storage.put(block);

    const retrieved = await storage.getByHash(block.hash);
    expect(retrieved).toEqual(block);
  });

  test("should return undefined for non-existent block", async () => {
    const retrieved = await storage.getByHeight(999);
    expect(retrieved).toBeUndefined();
  });

  test("should put many blocks in a transaction", async () => {
    const blocks = [
      createTestBlock(100),
      createTestBlock(101),
      createTestBlock(102),
    ];

    await storage.putMany(blocks);

    for (const block of blocks) {
      const retrieved = await storage.getByHeight(block.height);
      expect(retrieved).toEqual(block);
    }
  });

  test("should handle empty putMany array", async () => {
    await storage.putMany([]);
    // If we get here without throwing, the test passes
    expect(true).toBe(true);
  });

  test("should replace existing block on put", async () => {
    const block1 = createTestBlock(100);
    await storage.put(block1);

    const block2 = { ...block1, time: 2000000 };
    await storage.put(block2);

    const retrieved = await storage.getByHeight(100);
    expect(retrieved?.time).toBe(2000000);
  });

  test("should get all blocks in height order", async () => {
    const blocks = [
      createTestBlock(102),
      createTestBlock(100),
      createTestBlock(101),
    ];

    await storage.putMany(blocks);

    const all = await storage.getAll();
    expect(all.length).toBe(3);
    expect(all[0].height).toBe(100);
    expect(all[1].height).toBe(101);
    expect(all[2].height).toBe(102);
  });

  test("should get synced block (highest height)", async () => {
    const blocks = [
      createTestBlock(100),
      createTestBlock(101),
      createTestBlock(102),
    ];

    await storage.putMany(blocks);

    const synced = await storage.getSynced();
    expect(synced?.height).toBe(102);
  });

  test("should return undefined for synced when no blocks exist", async () => {
    const synced = await storage.getSynced();
    expect(synced).toBeUndefined();
  });

  test("should get backup data in chunks of 10000", async () => {
    // Create fewer blocks for testing
    const blocks: BlockHeader[] = [];
    for (let i = 0; i < 100; i++) {
      blocks.push(createTestBlock(i));
    }

    await storage.putMany(blocks);

    const backup = await storage.getBackup();
    expect(backup.length).toBeGreaterThan(0);
    expect(backup[0]).toBeInstanceOf(Array);
    expect(backup[0].length).toBeGreaterThan(0);
  });

  test("should handle concurrent operations", async () => {
    const block1 = createTestBlock(100);
    const block2 = createTestBlock(101);
    const block3 = createTestBlock(102);

    // Run multiple operations concurrently
    await Promise.all([
      storage.put(block1),
      storage.put(block2),
      storage.put(block3),
    ]);

    const [r1, r2, r3] = await Promise.all([
      storage.getByHeight(100),
      storage.getByHeight(101),
      storage.getByHeight(102),
    ]);

    expect(r1).toEqual(block1);
    expect(r2).toEqual(block2);
    expect(r3).toEqual(block3);
  });

  test("should maintain unique hash constraint", async () => {
    const block1 = createTestBlock(100);
    await storage.put(block1);

    // Try to insert different block with same hash
    const block2 = { ...block1, height: 101 };

    // SQLite will replace on conflict due to INSERT OR REPLACE
    await storage.put(block2);

    const byHash = await storage.getByHash(block1.hash);
    expect(byHash?.height).toBe(101); // Should be the updated one
  });
});
