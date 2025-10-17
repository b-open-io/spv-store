import { Database } from "./db-adapter";
import type { BlockStorage } from "../block-storage";
import { writeBlockHeader, type BlockHeader } from "../../models/block-header";
import type { Network } from "../../spv-store";
import { Utils } from "@bsv/sdk";

export class BlockStorageSQLite implements BlockStorage {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static init(network: Network, path?: string): BlockStorageSQLite {
    const dbPath = path ? `${path}/blocks-${network}.db` : `:memory:`;

    const db = new Database(dbPath, {
      create: true,
      safeIntegers: false,
      strict: true,
    });

    // Enable WAL mode for better concurrency
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA cache_size = -64000;"); // 64MB cache

    // Initialize schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        merkle_root TEXT NOT NULL,
        time INTEGER NOT NULL,
        version INTEGER NOT NULL,
        bits TEXT NOT NULL,
        nonce INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
      CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks(time);
    `);

    return new BlockStorageSQLite(db);
  }

  async destroy(): Promise<void> {
    this.db.close();
  }

  async put(block: BlockHeader): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (height, hash, prev_hash, merkle_root, time, version, bits, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      block.height,
      block.hash,
      block.prevHash,
      block.merkleRoot,
      block.time,
      block.version,
      block.bits,
      block.nonce
    );
  }

  async putMany(blocks: BlockHeader[]): Promise<void> {
    if (!blocks.length) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (height, hash, prev_hash, merkle_root, time, version, bits, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((blocks: BlockHeader[]) => {
      for (const block of blocks) {
        stmt.run(
          block.height,
          block.hash,
          block.prevHash,
          block.merkleRoot,
          block.time,
          block.version,
          block.bits,
          block.nonce
        );
      }
    });

    transaction(blocks);
  }

  async getByHash(hash: string): Promise<BlockHeader | undefined> {
    const stmt = this.db.prepare(`
      SELECT height, hash, prev_hash, merkle_root, time, version, bits, nonce
      FROM blocks
      WHERE hash = ?
    `);

    const row = stmt.get(hash) as any;
    if (!row) return undefined;

    return {
      height: row.height,
      hash: row.hash,
      prevHash: row.prev_hash,
      merkleRoot: row.merkle_root,
      time: row.time,
      version: row.version,
      bits: row.bits,
      nonce: row.nonce,
    };
  }

  async getByHeight(height: number): Promise<BlockHeader | undefined> {
    const stmt = this.db.prepare(`
      SELECT height, hash, prev_hash, merkle_root, time, version, bits, nonce
      FROM blocks
      WHERE height = ?
    `);

    const row = stmt.get(height) as any;
    if (!row) return undefined;

    return {
      height: row.height,
      hash: row.hash,
      prevHash: row.prev_hash,
      merkleRoot: row.merkle_root,
      time: row.time,
      version: row.version,
      bits: row.bits,
      nonce: row.nonce,
    };
  }

  async getSynced(): Promise<BlockHeader | undefined> {
    const stmt = this.db.prepare(`
      SELECT height, hash, prev_hash, merkle_root, time, version, bits, nonce
      FROM blocks
      ORDER BY height DESC
      LIMIT 1
    `);

    const row = stmt.get() as any;
    if (!row) return undefined;

    return {
      height: row.height,
      hash: row.hash,
      prevHash: row.prev_hash,
      merkleRoot: row.merkle_root,
      time: row.time,
      version: row.version,
      bits: row.bits,
      nonce: row.nonce,
    };
  }

  async getAll(): Promise<BlockHeader[]> {
    const stmt = this.db.prepare(`
      SELECT height, hash, prev_hash, merkle_root, time, version, bits, nonce
      FROM blocks
      ORDER BY height ASC
    `);

    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      height: row.height,
      hash: row.hash,
      prevHash: row.prev_hash,
      merkleRoot: row.merkle_root,
      time: row.time,
      version: row.version,
      bits: row.bits,
      nonce: row.nonce,
    }));
  }

  async getBackup(): Promise<number[][]> {
    let writer = new Utils.Writer();
    const headers: number[][] = [];
    let count = 0;
    let prevHash =
      "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

    const stmt = this.db.prepare(`
      SELECT height, hash, prev_hash, merkle_root, time, version, bits, nonce
      FROM blocks
      ORDER BY height ASC
    `);

    for (const row of stmt.iterate() as Iterable<any>) {
      const header: BlockHeader = {
        height: row.height,
        hash: row.hash,
        prevHash: prevHash,
        merkleRoot: row.merkle_root,
        time: row.time,
        version: row.version,
        bits: row.bits,
        nonce: row.nonce,
      };

      prevHash = header.hash;
      writeBlockHeader(writer, header);

      if (++count === 10000) {
        headers.push(writer.toArray());
        writer = new Utils.Writer();
        count = 0;
      }
    }

    if (count) {
      headers.push(writer.toArray());
    }

    return headers;
  }
}
