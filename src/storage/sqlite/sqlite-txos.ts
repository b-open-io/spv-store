import { Database } from "./db-adapter";
import type { TxoStorage } from "../txo-storage";
import { Txo, TxoStatus } from "../../models/txo";
import { IngestStatus, type Ingest } from "../../models/ingest";
import { Outpoint } from "../../models/outpoint";
import { TxoSort, type TxoLookup, type TxoResults } from "../../models/search";
import type { Network } from "../../spv-store";
import { TxLog, type TxLogResults } from "../../models";
import type { TxnStore } from "../../stores";

// Helper function to build index values like in IDB implementation
function buildTxoIndex(txo: Txo) {
  const tags: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const blockStr = txo.block.height.toString(10).padStart(7, "0");
  const idxStr = txo.block.idx.toString(10).padStart(9, "0");
  const sort = `${blockStr}.${idxStr}`;
  const deps = new Set<string>();

  for (const [tag, data] of Object.entries(txo.data)) {
    for (const dep of data.deps || []) {
      deps.add(dep.toString());
    }
    if (txo.status == TxoStatus.Dependency) continue;
    for (const e of data.events || []) {
      logs.push(`${tag}:${e.id}:${e.value}:${sort}`);
    }
    if (txo.spend) continue;
    if (data.events?.length) tags.push(`${tag}:${sort}`);
    for (const e of data.events || []) {
      events.push(`${tag}:${e.id}:${e.value}:${sort}`);
    }
  }

  txo.tags = tags;
  txo.events = events;
  txo.logs = logs;
  txo.deps = Array.from(deps);
  txo.hasEvents = events.length;
}

export class TxoStorageSQLite implements TxoStorage {
  private db: Database;
  private txnStore: TxnStore;

  private constructor(db: Database, txnStore: TxnStore) {
    this.db = db;
    this.txnStore = txnStore;
  }

  static init(
    accountId: string,
    network: Network,
    txnStore: TxnStore,
    path?: string
  ): TxoStorageSQLite {
    const dbPath = path
      ? `${path}/txos-${accountId}-${network}.db`
      : `:memory:`;

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
      -- Main TXOs table
      CREATE TABLE IF NOT EXISTS txos (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        satoshis INTEGER NOT NULL,
        script BLOB NOT NULL,
        status INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        block_idx INTEGER NOT NULL,
        spend TEXT NOT NULL DEFAULT '',
        owner TEXT,
        has_events INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (txid, vout)
      ) STRICT;

      -- Normalized multiEntry indexes
      CREATE TABLE IF NOT EXISTS txo_events (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (event, txid, vout),
        FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS txo_tags (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (tag, txid, vout),
        FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS txo_logs (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        log TEXT NOT NULL,
        PRIMARY KEY (log, txid, vout),
        FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS txo_deps (
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        dep TEXT NOT NULL,
        PRIMARY KEY (txid, vout, dep),
        FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
      ) WITHOUT ROWID;

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_txos_spend ON txos(spend, has_events);
      CREATE INDEX IF NOT EXISTS idx_txos_owner ON txos(owner) WHERE owner IS NOT NULL;

      -- Ingest queue
      CREATE TABLE IF NOT EXISTS ingest_queue (
        txid TEXT PRIMARY KEY NOT NULL,
        height INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        source TEXT,
        parse_mode INTEGER NOT NULL,
        download_only INTEGER NOT NULL DEFAULT 0,
        outputs TEXT,
        status INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_ingest_status ON ingest_queue(status, height, idx);

      -- Transaction logs
      CREATE TABLE IF NOT EXISTS tx_logs (
        txid TEXT PRIMARY KEY NOT NULL,
        height INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        summary TEXT,
        source TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tx_logs_height ON tx_logs(height DESC, idx DESC);

      -- State storage
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
    `);

    return new TxoStorageSQLite(db, txnStore);
  }

  async destroy(): Promise<void> {
    this.db.close();
  }

  async get(outpoint: Outpoint): Promise<Txo | undefined> {
    const stmt = this.db.prepare(`
      SELECT
        txid, vout, satoshis, script, status,
        block_height, block_idx, spend, owner, has_events, data
      FROM txos
      WHERE txid = ? AND vout = ?
    `);

    const row = stmt.get(outpoint.txid, outpoint.vout) as any;
    if (!row) return undefined;

    return this.rowToTxo(row);
  }

  async getMany(outpoints: Outpoint[]): Promise<(Txo | undefined)[]> {
    if (!outpoints.length) return [];

    const results: (Txo | undefined)[] = [];
    const stmt = this.db.prepare(`
      SELECT
        txid, vout, satoshis, script, status,
        block_height, block_idx, spend, owner, has_events, data
      FROM txos
      WHERE txid = ? AND vout = ?
    `);

    for (const outpoint of outpoints) {
      const row = stmt.get(outpoint.txid, outpoint.vout) as any;
      results.push(row ? this.rowToTxo(row) : undefined);
    }

    return results;
  }

  async getBySpend(txid: string): Promise<Txo[]> {
    const stmt = this.db.prepare(`
      SELECT
        txid, vout, satoshis, script, status,
        block_height, block_idx, spend, owner, has_events, data
      FROM txos
      WHERE spend = ?
    `);

    const rows = stmt.all(txid) as any[];
    return rows.map((row) => this.rowToTxo(row));
  }

  async put(txo: Txo): Promise<void> {
    buildTxoIndex(txo);

    const txn = this.db.transaction(() => {
      // Insert/update main TXO
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO txos
        (txid, vout, satoshis, script, status, block_height, block_idx, spend, owner, has_events, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        txo.outpoint.txid,
        txo.outpoint.vout,
        Number(txo.satoshis),
        this.arrayToBlob(txo.script),
        txo.status,
        txo.block.height,
        Number(txo.block.idx),
        txo.spend,
        txo.owner || null,
        txo.hasEvents,
        JSON.stringify(txo.data)
      );

      // Delete old normalized entries
      this.db.prepare("DELETE FROM txo_events WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
      this.db.prepare("DELETE FROM txo_tags WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
      this.db.prepare("DELETE FROM txo_logs WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
      this.db.prepare("DELETE FROM txo_deps WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);

      // Insert new normalized entries
      const eventStmt = this.db.prepare("INSERT INTO txo_events (txid, vout, event) VALUES (?, ?, ?)");
      for (const event of txo.events) {
        eventStmt.run(txo.outpoint.txid, txo.outpoint.vout, event);
      }

      const tagStmt = this.db.prepare("INSERT INTO txo_tags (txid, vout, tag) VALUES (?, ?, ?)");
      for (const tag of txo.tags) {
        tagStmt.run(txo.outpoint.txid, txo.outpoint.vout, tag);
      }

      const logStmt = this.db.prepare("INSERT INTO txo_logs (txid, vout, log) VALUES (?, ?, ?)");
      for (const log of txo.logs) {
        logStmt.run(txo.outpoint.txid, txo.outpoint.vout, log);
      }

      const depStmt = this.db.prepare("INSERT INTO txo_deps (txid, vout, dep) VALUES (?, ?, ?)");
      for (const dep of txo.deps) {
        depStmt.run(txo.outpoint.txid, txo.outpoint.vout, dep);
      }
    });

    txn();
  }

  async putMany(txos: Txo[]): Promise<void> {
    if (!txos.length) return;

    const txn = this.db.transaction(() => {
      for (const txo of txos) {
        if (!txo) continue;
        buildTxoIndex(txo);

        // Insert/update main TXO
        const stmt = this.db.prepare(`
          INSERT OR REPLACE INTO txos
          (txid, vout, satoshis, script, status, block_height, block_idx, spend, owner, has_events, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          txo.outpoint.txid,
          txo.outpoint.vout,
          Number(txo.satoshis),
          this.arrayToBlob(txo.script),
          txo.status,
          txo.block.height,
          Number(txo.block.idx),
          txo.spend,
          txo.owner || null,
          txo.hasEvents,
          JSON.stringify(txo.data)
        );

        // Delete old normalized entries
        this.db.prepare("DELETE FROM txo_events WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
        this.db.prepare("DELETE FROM txo_tags WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
        this.db.prepare("DELETE FROM txo_logs WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);
        this.db.prepare("DELETE FROM txo_deps WHERE txid = ? AND vout = ?").run(txo.outpoint.txid, txo.outpoint.vout);

        // Insert new normalized entries
        const eventStmt = this.db.prepare("INSERT INTO txo_events (txid, vout, event) VALUES (?, ?, ?)");
        for (const event of txo.events) {
          eventStmt.run(txo.outpoint.txid, txo.outpoint.vout, event);
        }

        const tagStmt = this.db.prepare("INSERT INTO txo_tags (txid, vout, tag) VALUES (?, ?, ?)");
        for (const tag of txo.tags) {
          tagStmt.run(txo.outpoint.txid, txo.outpoint.vout, tag);
        }

        const logStmt = this.db.prepare("INSERT INTO txo_logs (txid, vout, log) VALUES (?, ?, ?)");
        for (const log of txo.logs) {
          logStmt.run(txo.outpoint.txid, txo.outpoint.vout, log);
        }

        const depStmt = this.db.prepare("INSERT INTO txo_deps (txid, vout, dep) VALUES (?, ?, ?)");
        for (const dep of txo.deps) {
          depStmt.run(txo.outpoint.txid, txo.outpoint.vout, dep);
        }
      }
    });

    txn();
  }

  async search(
    lookup: TxoLookup,
    sort = TxoSort.DESC,
    limit = 10,
    from?: string
  ): Promise<TxoResults> {
    const dbkey = lookup.toQueryKey();
    let lower = dbkey;
    let upper = dbkey + "\uffff";

    if (from && sort == TxoSort.ASC) {
      lower = from;
    } else if (from && sort == TxoSort.DESC) {
      upper = from;
    }

    // Determine which table to query based on lookup type
    let indexTable = "txo_tags";
    let indexCol = "tag";

    if (lookup.includeSpent) {
      indexTable = "txo_logs";
      indexCol = "log";
    } else if (lookup.id) {
      indexTable = "txo_events";
      indexCol = "event";
    }

    const direction = sort == TxoSort.DESC ? "DESC" : "ASC";
    const stmt = this.db.prepare(`
      SELECT DISTINCT t.txid, t.vout, t.satoshis, t.script, t.status,
             t.block_height, t.block_idx, t.spend, t.owner, t.has_events, t.data, i.${indexCol}
      FROM txos t
      INNER JOIN ${indexTable} i ON t.txid = i.txid AND t.vout = i.vout
      WHERE i.${indexCol} > ? AND i.${indexCol} < ?
      ${lookup.owner ? "AND t.owner = ?" : ""}
      ORDER BY i.${indexCol} ${direction}
      LIMIT ?
    `);

    const params: any[] = [lower, upper];
    if (lookup.owner) params.push(lookup.owner);
    params.push(limit + 1);

    const rows = stmt.all(...params) as any[];
    const txos: Txo[] = [];
    let nextPage: string | undefined;

    for (let i = 0; i < rows.length; i++) {
      if (i >= limit) {
        nextPage = rows[i][indexCol];
        break;
      }
      txos.push(this.rowToTxo(rows[i]));
    }

    return { txos, nextPage };
  }

  async getUtxos(): Promise<Txo[]> {
    const stmt = this.db.prepare(`
      SELECT
        txid, vout, satoshis, script, status,
        block_height, block_idx, spend, owner, has_events, data
      FROM txos
      WHERE spend = '' AND has_events > 0
      ORDER BY block_height DESC, block_idx DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map((row) => this.rowToTxo(row));
  }

  async backup(limit = 1000, from: any = ["", 0]): Promise<TxoResults> {
    const [fromTxid, fromVout] = from;
    const stmt = this.db.prepare(`
      SELECT
        txid, vout, satoshis, script, status,
        block_height, block_idx, spend, owner, has_events, data
      FROM txos
      WHERE (txid > ? OR (txid = ? AND vout > ?))
      ORDER BY txid, vout
      LIMIT ?
    `);

    const rows = stmt.all(fromTxid, fromTxid, fromVout, limit + 1) as any[];
    const txos: Txo[] = [];
    let nextPage: any;

    for (let i = 0; i < rows.length; i++) {
      if (i >= limit) {
        nextPage = [rows[i].txid, rows[i].vout];
        break;
      }
      txos.push(this.rowToTxo(rows[i]));
    }

    return { txos, nextPage };
  }

  // State methods
  async getState(key: string): Promise<string | undefined> {
    const stmt = this.db.prepare("SELECT value FROM state WHERE key = ?");
    const row = stmt.get(key) as any;
    return row?.value;
  }

  async setState(key: string, value: string): Promise<void> {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)");
    stmt.run(key, value);
  }

  // Ingest queue methods
  async getQueueLength(): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM ingest_queue
      WHERE status = ?
    `);
    const row = stmt.get(IngestStatus.QUEUED) as any;
    return row.count;
  }

  async getIngest(txid: string): Promise<Ingest | undefined> {
    const stmt = this.db.prepare(`
      SELECT txid, height, idx, source, parse_mode, download_only, outputs, status
      FROM ingest_queue
      WHERE txid = ?
    `);
    const row = stmt.get(txid) as any;
    return row ? this.rowToIngest(row) : undefined;
  }

  async getIngests(
    status: IngestStatus,
    limit: number,
    start: number = 0,
    stop: number = Number.MAX_SAFE_INTEGER
  ): Promise<Ingest[]> {
    const stmt = this.db.prepare(`
      SELECT txid, height, idx, source, parse_mode, download_only, outputs, status
      FROM ingest_queue
      WHERE status = ? AND height >= ? AND height <= ?
      LIMIT ?
    `);
    const rows = stmt.all(status, start, stop, limit) as any[];
    return rows.map((row) => this.rowToIngest(row));
  }

  async putIngest(ingest: Ingest): Promise<void> {
    // Get previous ingest if exists
    const prev = await this.getIngest(ingest.txid);

    // Merge outputs if both exist
    if (prev && prev.outputs && ingest.outputs) {
      const outputs = new Set([...prev.outputs, ...ingest.outputs]);
      ingest.outputs = Array.from(outputs);
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ingest_queue
      (txid, height, idx, source, parse_mode, download_only, outputs, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ingest.txid,
      ingest.height,
      ingest.idx,
      ingest.source || null,
      ingest.parseMode,
      ingest.downloadOnly ? 1 : 0,
      ingest.outputs ? JSON.stringify(ingest.outputs) : null,
      ingest.status ?? IngestStatus.QUEUED
    );
  }

  async putIngests(ingests: Ingest[]): Promise<void> {
    if (!ingests.length) return;

    for (const ingest of ingests) {
      await this.putIngest(ingest);
    }
  }

  async delIngest(txid: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM ingest_queue WHERE txid = ?");
    stmt.run(txid);
  }

  async delIngests(txids: string[]): Promise<void> {
    if (!txids.length) return;

    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare("DELETE FROM ingest_queue WHERE txid = ?");
      for (const txid of txids) {
        stmt.run(txid);
      }
    });

    txn();
  }

  // TxLog methods
  async getTxLog(txid: string): Promise<TxLog | undefined> {
    const stmt = this.db.prepare(`
      SELECT txid, height, idx, summary, source
      FROM tx_logs
      WHERE txid = ?
    `);
    const row = stmt.get(txid) as any;
    return row ? this.rowToTxLog(row) : undefined;
  }

  async getTxLogs(txids: string[]): Promise<(TxLog | undefined)[]> {
    if (!txids.length) return [];

    const stmt = this.db.prepare(`
      SELECT txid, height, idx, summary, source
      FROM tx_logs
      WHERE txid = ?
    `);

    return txids.map((txid) => {
      const row = stmt.get(txid) as any;
      return row ? this.rowToTxLog(row) : undefined;
    });
  }

  async getRecentTxLogs(limit = 100): Promise<TxLog[]> {
    const stmt = this.db.prepare(`
      SELECT txid, height, idx, summary, source
      FROM tx_logs
      ORDER BY height DESC, idx DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map((row) => this.rowToTxLog(row));
  }

  async putTxLog(txLog: TxLog): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tx_logs (txid, height, idx, summary, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      txLog.txid,
      txLog.height,
      txLog.idx,
      txLog.summary ? JSON.stringify(txLog.summary) : null,
      txLog.source || null
    );
  }

  async putTxLogs(logs: TxLog[]): Promise<void> {
    if (!logs.length) return;

    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tx_logs (txid, height, idx, summary, source)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const log of logs) {
        stmt.run(
          log.txid,
          log.height,
          log.idx,
          log.summary ? JSON.stringify(log.summary) : null,
          log.source || null
        );
      }
    });

    txn();
  }

  async backupTxLogs(limit: number, from = ""): Promise<TxLogResults> {
    const stmt = this.db.prepare(`
      SELECT txid, height, idx, summary, source
      FROM tx_logs
      WHERE txid > ?
      ORDER BY txid
      LIMIT ?
    `);

    const rows = stmt.all(from, limit + 1) as any[];
    const logs: TxLog[] = [];
    let nextPage: string | undefined;

    for (let i = 0; i < rows.length; i++) {
      if (i >= limit) {
        nextPage = rows[i].txid;
        break;
      }
      logs.push(this.rowToTxLog(rows[i]));
    }

    return { logs, nextPage };
  }

  async getBackupLogs(): Promise<any[]> {
    // This is a complex operation that loads dependencies recursively
    // For now, return empty array - can be implemented if needed
    return [];
  }

  // Helper methods
  private rowToTxo(row: any): Txo {
    const txo = new Txo(
      new Outpoint(row.txid, row.vout),
      BigInt(row.satoshis),
      this.blobToArray(row.script),
      row.status,
      { height: row.block_height, idx: BigInt(row.block_idx) }
    );

    txo.spend = row.spend;
    txo.owner = row.owner;
    txo.hasEvents = row.has_events;
    txo.data = JSON.parse(row.data);

    // Hydrate outpoints in data.deps
    for (const [tag, data] of Object.entries(txo.data)) {
      const indexData = data as any;
      if (indexData.deps) {
        indexData.deps = indexData.deps.map((dep: any) => new Outpoint(dep));
      }
    }

    // Load normalized arrays - would need separate queries in real implementation
    // For now they're rebuilt by buildTxoIndex on save
    txo.events = [];
    txo.tags = [];
    txo.logs = [];
    txo.deps = [];

    return txo;
  }

  private rowToIngest(row: any): Ingest {
    return {
      txid: row.txid,
      height: row.height,
      idx: row.idx,
      source: row.source,
      parseMode: row.parse_mode,
      downloadOnly: row.download_only === 1,
      outputs: row.outputs ? JSON.parse(row.outputs) : undefined,
      status: row.status,
    };
  }

  private rowToTxLog(row: any): TxLog {
    const log = new TxLog(row.txid, row.height, row.idx);
    log.summary = row.summary ? JSON.parse(row.summary) : undefined;
    log.source = row.source;
    return log;
  }

  private arrayToBlob(arr: number[]): Uint8Array {
    return new Uint8Array(arr);
  }

  private blobToArray(blob: Uint8Array): number[] {
    return Array.from(blob);
  }
}
