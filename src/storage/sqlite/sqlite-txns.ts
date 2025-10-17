import { Database } from "./db-adapter";
import type { TxnBackup, TxnStorage } from "../txn-storage";
import { TxnStatus, type Txn } from "../../stores/txn-store";
import type { Network } from "../../spv-store";
import { MerklePath, Transaction, Utils } from "@bsv/sdk";
import { Block } from "../../models";

export class TxnStorageSQLite implements TxnStorage {
  private db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static init(network: Network, path?: string): TxnStorageSQLite {
    const dbPath = path ? `${path}/txns-${network}.db` : `:memory:`;

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
      CREATE TABLE IF NOT EXISTS txns (
        txid TEXT PRIMARY KEY NOT NULL,
        rawtx BLOB NOT NULL,
        proof BLOB,
        block_height INTEGER NOT NULL,
        block_idx INTEGER NOT NULL,
        status INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_txns_status ON txns(status, block_height);
    `);

    return new TxnStorageSQLite(db);
  }

  async destroy(): Promise<void> {
    this.db.close();
  }

  async get(txid: string): Promise<Txn | undefined> {
    const stmt = this.db.prepare(`
      SELECT txid, rawtx, proof, block_height, block_idx, status
      FROM txns
      WHERE txid = ?
    `);

    const row = stmt.get(txid) as any;
    if (!row) return undefined;

    return this.rowToTxn(row);
  }

  async getMany(txids: string[]): Promise<(Txn | undefined)[]> {
    if (!txids.length) return [];

    // Build parameterized query with placeholders
    const placeholders = txids.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT txid, rawtx, proof, block_height, block_idx, status
      FROM txns
      WHERE txid IN (${placeholders})
    `);

    const rows = stmt.all(...txids) as any[];
    const rowMap = new Map(rows.map((row) => [row.txid, this.rowToTxn(row)]));

    // Return in the same order as input, with undefined for missing txns
    return txids.map((txid) => rowMap.get(txid));
  }

  async backup(limit = 1000, from = [TxnStatus.BROADCASTED, 0]): Promise<TxnBackup> {
    const writer = new Utils.Writer();
    const [fromStatus, fromHeight] = from;

    const stmt = this.db.prepare(`
      SELECT txid, rawtx, proof, block_height, block_idx, status
      FROM txns
      WHERE (status > ? OR (status = ? AND block_height >= ?))
      ORDER BY status, block_height
      LIMIT ?
    `);

    const rows = stmt.all(fromStatus, fromStatus, fromHeight, limit + 1) as any[];

    let count = 0;
    let nextPage: any;

    for (const row of rows) {
      if (++count > limit) {
        nextPage = [row.status, row.block_height];
        break;
      }

      const tx = Transaction.fromBinary(this.blobToArray(row.rawtx));
      if (row.proof) {
        tx.merklePath = MerklePath.fromBinary(this.blobToArray(row.proof));
      }
      const beef = tx.toAtomicBEEF();
      writer.writeUInt32LE(beef.length);
      writer.write(beef);
    }

    return {
      data: writer.toArray(),
      nextPage,
    };
  }

  async restore(data: number[]): Promise<void> {
    const reader = new Utils.Reader(data);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO txns (txid, rawtx, proof, block_height, block_idx, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((reader: Utils.Reader) => {
      while (!reader.eof()) {
        const len = reader.readUInt32LE();
        const beef = reader.read(len);
        const tx = Transaction.fromAtomicBEEF(beef);
        const txid = tx.id("hex");

        stmt.run(
          txid,
          this.arrayToBlob(tx.toBinary()),
          tx.merklePath ? this.arrayToBlob(tx.merklePath.toBinary()) : null,
          tx.merklePath?.blockHeight ?? Date.now(),
          Number(tx.merklePath?.path[0].find((p) => p.hash == txid)?.offset || 0),
          TxnStatus.CONFIRMED
        );
      }
    });

    transaction(reader);
  }

  async put(txn: Txn): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO txns (txid, rawtx, proof, block_height, block_idx, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      txn.txid,
      this.arrayToBlob(txn.rawtx),
      txn.proof ? this.arrayToBlob(txn.proof) : null,
      txn.block.height,
      Number(txn.block.idx),
      txn.status
    );
  }

  async putMany(txns: Txn[]): Promise<void> {
    if (!txns.length) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO txns (txid, rawtx, proof, block_height, block_idx, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((txns: Txn[]) => {
      for (const txn of txns) {
        stmt.run(
          txn.txid,
          this.arrayToBlob(txn.rawtx),
          txn.proof ? this.arrayToBlob(txn.proof) : null,
          txn.block.height,
          Number(txn.block.idx),
          txn.status
        );
      }
    });

    transaction(txns);
  }

  async exists(txids: string[]): Promise<boolean[]> {
    if (!txids.length) return [];

    const placeholders = txids.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT txid FROM txns WHERE txid IN (${placeholders})
    `);

    const rows = stmt.all(...txids) as any[];
    const existingSet = new Set(rows.map((row) => row.txid));

    return txids.map((txid) => existingSet.has(txid));
  }

  async getByStatus(
    status: TxnStatus,
    toBlock: number,
    limit = 25
  ): Promise<Txn[]> {
    const stmt = this.db.prepare(`
      SELECT txid, rawtx, proof, block_height, block_idx, status
      FROM txns
      WHERE status = ? AND block_height <= ?
      ORDER BY block_height
      LIMIT ?
    `);

    const rows = stmt.all(status, toBlock, limit) as any[];
    return rows.map((row) => this.rowToTxn(row));
  }

  private rowToTxn(row: any): Txn {
    return {
      txid: row.txid,
      rawtx: this.blobToArray(row.rawtx),
      proof: row.proof ? this.blobToArray(row.proof) : undefined,
      block: new Block(row.block_height, BigInt(row.block_idx)),
      status: row.status,
    };
  }

  private arrayToBlob(arr: number[]): Uint8Array {
    return new Uint8Array(arr);
  }

  private blobToArray(blob: Uint8Array): number[] {
    return Array.from(blob);
  }
}
