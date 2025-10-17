# SPV-Store SQLite Migration Plan

## Executive Summary

This document outlines the migration strategy from IndexedDB to Bun's native SQLite storage for spv-store. The migration will provide persistent storage, eliminate the need for constant backups, and improve performance while maintaining the existing API surface.

**Key Benefits:**
- ✅ Native persistence (no backup/restore cycles needed)
- ✅ 3-6x faster than IndexedDB for read operations
- ✅ ACID transactions with proper rollback support
- ✅ Better query optimization capabilities
- ✅ Reduced memory footprint
- ✅ No external dependencies (built into Bun)
- ✅ Works in VSCode extension environment

**Migration Scope:**
- TxnStorage: Transaction storage and BEEF serialization
- TxoStorage: Transaction output indexing and search
- BlockStorage: Blockchain headers and sync state

---

## 1. Current Architecture Analysis

### 1.1 IndexedDB Implementation

**Three Separate Databases:**
```
txns-{network}                    → SQLite: transactions.db
txos-{accountId}-{network}        → SQLite: txos.db
blocks-{network}                  → SQLite: blocks.db
```

**Key Characteristics:**
- **Async API**: All operations return Promises
- **Transaction support**: Read-only and read-write transactions
- **Compound indexes**: Multi-column indexes for queries
- **MultiEntry indexes**: Array values create multiple index entries
- **Cursor iteration**: Forward/backward iteration with pagination
- **Binary data**: Stored as `number[]` arrays

### 1.2 Data Volume & Performance

**Estimated Data Volumes:**
- **Transactions**: 10k-100k transactions (~10-100 MB)
- **TXOs**: 100k-1M outputs (~100 MB - 1 GB)
- **Blocks**: ~870k blocks (~100 MB)

**Critical Query Patterns:**
1. UTXO queries: `WHERE spend = '' AND hasEvents > 0`
2. Event searches: `WHERE events LIKE 'tag:value%'`
3. History pagination: `ORDER BY height DESC, idx DESC LIMIT ?`
4. Batch inserts: Bulk write 100-1000 records
5. Parent resolution: Recursive dependency loading

---

## 2. SQLite Schema Design

### 2.1 Transactions Database Schema

```sql
-- transactions.db

CREATE TABLE IF NOT EXISTS txns (
  txid TEXT PRIMARY KEY NOT NULL,
  rawtx BLOB NOT NULL,                -- Binary transaction data
  proof BLOB,                         -- Merkle proof (nullable)
  status INTEGER NOT NULL,            -- -1=REJECTED, 0=PENDING, 1=BROADCASTED, 2=CONFIRMED
  block_height INTEGER NOT NULL,      -- Block height or timestamp
  block_idx INTEGER NOT NULL          -- Index in block (stored as INTEGER)
) STRICT;

-- Compound index for status queries
CREATE INDEX IF NOT EXISTS idx_txns_status
ON txns(status, block_height);

-- Index for block-based queries
CREATE INDEX IF NOT EXISTS idx_txns_block
ON txns(block_height, block_idx);
```

**Key Design Decisions:**
- `STRICT` mode: Enforces column types (Bun SQLite supports this)
- `BLOB` for binary data: More efficient than hex strings
- `block_idx` as INTEGER: SQLite integers are 64-bit signed
- Separate indexes instead of compound key for flexibility

### 2.2 Transaction Outputs Database Schema

```sql
-- txos.db

-- Main TXO table
CREATE TABLE IF NOT EXISTS txos (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  satoshis INTEGER NOT NULL,          -- BigInt stored as INTEGER (64-bit)
  script BLOB NOT NULL,               -- Locking script (binary)
  status INTEGER NOT NULL,            -- -1=Unindexed, 0=Trusted, 1=Dependency, 2=Validated
  block_height INTEGER NOT NULL,
  block_idx INTEGER NOT NULL,
  spend TEXT NOT NULL DEFAULT '',     -- Spending TXID (empty if unspent)
  owner TEXT,                         -- Address/identifier (nullable)
  has_events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (txid, vout)
) STRICT;

-- UTXO index (most critical for performance)
CREATE INDEX IF NOT EXISTS idx_txos_utxo
ON txos(spend, has_events, block_height DESC, block_idx DESC)
WHERE spend = '';

-- Owner index for balance queries
CREATE INDEX IF NOT EXISTS idx_txos_owner
ON txos(owner, spend, block_height DESC);

-- Spend index for finding inputs
CREATE INDEX IF NOT EXISTS idx_txos_spend
ON txos(spend) WHERE spend != '';

-- ============================================
-- Indexer Data Table (normalized)
-- ============================================
CREATE TABLE IF NOT EXISTS txo_data (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  tag TEXT NOT NULL,                  -- Indexer tag (e.g., 'fund', 'insc')
  data TEXT NOT NULL,                 -- JSON-serialized indexer data
  PRIMARY KEY (txid, vout, tag),
  FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_txo_data_tag
ON txo_data(tag);

-- ============================================
-- Events Table (multiEntry → separate table)
-- ============================================
CREATE TABLE IF NOT EXISTS txo_events (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  event TEXT NOT NULL,                -- Event string: "tag:id:value:height.idx"
  PRIMARY KEY (txid, vout, event),
  FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_txo_events_search
ON txo_events(event);

-- ============================================
-- Tags Table (multiEntry → separate table)
-- ============================================
CREATE TABLE IF NOT EXISTS txo_tags (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  tag TEXT NOT NULL,                  -- Tag string: "tag:height.idx"
  PRIMARY KEY (txid, vout, tag),
  FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_txo_tags_search
ON txo_tags(tag);

-- ============================================
-- Transaction Logs (for history)
-- ============================================
CREATE TABLE IF NOT EXISTS tx_logs (
  txid TEXT PRIMARY KEY NOT NULL,
  height INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  summary TEXT NOT NULL               -- JSON-serialized TxLog
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tx_logs_height
ON tx_logs(height DESC, idx DESC);

-- ============================================
-- Dependencies Table
-- ============================================
CREATE TABLE IF NOT EXISTS txo_deps (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  dep_txid TEXT NOT NULL,
  dep_vout INTEGER NOT NULL,
  PRIMARY KEY (txid, vout, dep_txid, dep_vout),
  FOREIGN KEY (txid, vout) REFERENCES txos(txid, vout) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_txo_deps_parent
ON txo_deps(dep_txid, dep_vout);

-- ============================================
-- Ingest Queue
-- ============================================
CREATE TABLE IF NOT EXISTS ingest_queue (
  txid TEXT PRIMARY KEY NOT NULL,
  height INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  source TEXT NOT NULL,
  parse_mode INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,  -- 0=QUEUED, 2=INGESTED, 3=CONFIRMED, 4=IMMUTABLE
  outputs TEXT,                       -- JSON array of vout numbers (nullable)
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ingest_status
ON ingest_queue(status, height, idx);

-- ============================================
-- State Store (key-value)
-- ============================================
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
```

**Key Design Decisions:**

1. **Normalized MultiEntry Indexes**: Separate tables for events/tags/deps instead of JSON arrays
   - Better query performance
   - Proper indexing support
   - Follows relational best practices

2. **WITHOUT ROWID**: Used for junction tables to save space
   - No need for implicit rowid column
   - Composite primary key becomes clustered index

3. **Partial Indexes**: `WHERE spend = ''` for UTXO queries
   - Significantly reduces index size
   - Faster UTXO lookups (most common query)

4. **Foreign Keys with CASCADE**: Automatic cleanup when TXO deleted
   - Maintains referential integrity
   - Simplifies deletion logic

5. **JSON for Complex Data**: Indexer data stored as JSON
   - Flexible schema per indexer
   - SQLite has efficient JSON operators
   - Easier serialization/deserialization

### 2.3 Blocks Database Schema

```sql
-- blocks.db

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

-- Hash index for reverse lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash
ON blocks(hash);

-- Time index for time-based queries
CREATE INDEX IF NOT EXISTS idx_blocks_time
ON blocks(time);
```

**Key Design Decisions:**
- `height` as PRIMARY KEY: Natural ordering
- `UNIQUE` constraint on hash: Ensure blockchain integrity
- Separate indexes: Height (clustered), hash (lookup), time (optional)

---

## 3. Data Type Mapping

| IDB Type | SQLite Type | Notes |
|----------|-------------|-------|
| `string` | `TEXT` | TXID, hash, addresses |
| `number` | `INTEGER` | Heights, status, counts |
| `bigint` | `INTEGER` | Satoshis, block_idx (64-bit signed) |
| `number[]` (binary) | `BLOB` | rawtx, proof, script |
| `Array<string>` | Separate table | events, tags, logs (normalized) |
| `Object` | `TEXT` (JSON) | Indexer data, complex structures |
| `boolean` | `INTEGER` | 0/1 representation |

**BigInt Handling:**
- SQLite `INTEGER` is 64-bit signed: -2^63 to 2^63-1
- JavaScript `BigInt` supports arbitrary precision
- **Safe range**: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807
- Bitcoin max supply: 21,000,000 BTC = 2,100,000,000,000,000 satoshis (fits in 64-bit)

**Binary Data:**
```typescript
// Current: number[] array
const script: number[] = [0x76, 0xa9, ...];

// SQLite: Uint8Array or Buffer
const script: Uint8Array = new Uint8Array([0x76, 0xa9, ...]);

// Bun SQLite handles both:
stmt.run({ $script: new Uint8Array(script) });  // Preferred
stmt.run({ $script: Buffer.from(script) });     // Also works
```

---

## 4. Implementation Strategy

### 4.1 Phased Approach

**Phase 1: Foundation (Week 1)**
- [ ] Create SQLite storage interfaces matching current API
- [ ] Implement `sqlite-blocks.ts` (simplest, no dependencies)
- [ ] Write comprehensive unit tests
- [ ] Benchmark against IDB implementation

**Phase 2: Transaction Storage (Week 2)**
- [ ] Implement `sqlite-txns.ts`
- [ ] Handle BEEF serialization/deserialization
- [ ] Implement backup/restore with binary format
- [ ] Test with large transaction sets (10k+ TXs)

**Phase 3: TXO Storage Core (Week 3-4)**
- [ ] Implement `sqlite-txos.ts` basic operations
- [ ] Implement normalized tables (events, tags, deps)
- [ ] Handle indexer data serialization
- [ ] Test CRUD operations

**Phase 4: Search & Queries (Week 5)**
- [ ] Implement complex search queries
- [ ] Optimize indexes for query patterns
- [ ] Implement cursor-based pagination
- [ ] Benchmark query performance

**Phase 5: Integration & Migration (Week 6)**
- [ ] Create migration utility (IDB → SQLite)
- [ ] Add configuration flag for storage backend
- [ ] Test in VSCode extension environment
- [ ] Performance tuning and optimization

**Phase 6: Production Readiness (Week 7)**
- [ ] Comprehensive testing (unit, integration, e2e)
- [ ] Documentation updates
- [ ] Migration guide for users
- [ ] Deprecation plan for IDB backend

### 4.2 Parallel Development Strategy

**Maintain API Compatibility:**
```typescript
// Storage interface (unchanged)
export interface TxoStorage {
  get(outpoint: Outpoint): Promise<Txo | undefined>;
  getMany(outpoints: Outpoint[]): Promise<(Txo | undefined)[]>;
  put(txo: Txo): Promise<void>;
  putMany(txos: Txo[]): Promise<void>;
  // ... rest of interface
}

// Implementation factory
export function createTxoStorage(
  type: 'idb' | 'sqlite',
  config: StorageConfig
): TxoStorage {
  if (type === 'sqlite') {
    return new TxoStorageSQLite(config);
  }
  return new TxoStorageIDB(config);
}
```

**Configuration:**
```typescript
interface StorageConfig {
  type: 'idb' | 'sqlite';
  path?: string;           // For SQLite file path
  accountId: string;
  network: 'mainnet' | 'testnet';
  safeIntegers?: boolean;  // For BigInt handling
}
```

### 4.3 File Structure

```
spv-store/
├── src/
│   ├── storage/
│   │   ├── index.ts                    # Export interfaces + factory
│   │   ├── txn-storage.ts              # Interface (unchanged)
│   │   ├── txo-storage.ts              # Interface (unchanged)
│   │   ├── block-storage.ts            # Interface (unchanged)
│   │   ├── idb/                        # Keep existing
│   │   │   ├── idb-txns.ts
│   │   │   ├── idb-txos.ts
│   │   │   └── idb-blocks.ts
│   │   └── sqlite/                     # NEW
│   │       ├── index.ts
│   │       ├── sqlite-txns.ts          # TxnStorageSQLite
│   │       ├── sqlite-txos.ts          # TxoStorageSQLite
│   │       ├── sqlite-blocks.ts        # BlockStorageSQLite
│   │       ├── migrations.ts           # Schema migrations
│   │       └── utils.ts                # Binary helpers, serialization
│   └── ...
└── migrations/                          # NEW
    └── idb-to-sqlite.ts                # Migration utility
```

---

## 5. SQLite Implementation Details

### 5.1 Database Initialization

```typescript
import { Database } from "bun:sqlite";

export class TxoStorageSQLite implements TxoStorage {
  private db: Database;

  constructor(config: StorageConfig) {
    // Use file path or in-memory
    const dbPath = config.path
      ? `${config.path}/txos-${config.accountId}-${config.network}.db`
      : ":memory:";

    this.db = new Database(dbPath, {
      create: true,
      safeIntegers: config.safeIntegers ?? false,
      strict: true,  // Enforce named parameter binding
    });

    // Enable WAL mode for better concurrency
    this.db.exec("PRAGMA journal_mode = WAL;");

    // Optimize for performance
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA cache_size = 10000;");
    this.db.exec("PRAGMA temp_store = MEMORY;");

    // Initialize schema
    this.initSchema();
  }

  private initSchema(): void {
    // Execute all CREATE TABLE statements
    this.db.exec(SCHEMA_SQL);
  }

  async destroy(): Promise<void> {
    this.db.close();
  }
}
```

**WAL Mode Benefits:**
- Multiple readers + single writer concurrency
- Better crash recovery
- Atomic commits
- Recommended for most applications

**Performance PRAGMAs:**
- `synchronous = NORMAL`: Balance between safety and speed
- `cache_size`: Larger cache for better read performance
- `temp_store = MEMORY`: Faster temporary tables

### 5.2 Batch Operations

```typescript
async putMany(txos: Txo[]): Promise<void> {
  if (!txos.length) return;

  // Use transaction for atomicity
  const insertTxo = this.db.query(`
    INSERT OR REPLACE INTO txos
    (txid, vout, satoshis, script, status, block_height, block_idx,
     spend, owner, has_events)
    VALUES ($txid, $vout, $satoshis, $script, $status, $block_height,
            $block_idx, $spend, $owner, $has_events)
  `);

  const insertEvent = this.db.query(`
    INSERT OR IGNORE INTO txo_events (txid, vout, event)
    VALUES ($txid, $vout, $event)
  `);

  const insertTag = this.db.query(`
    INSERT OR IGNORE INTO txo_tags (txid, vout, tag)
    VALUES ($txid, $vout, $tag)
  `);

  const insertData = this.db.query(`
    INSERT OR REPLACE INTO txo_data (txid, vout, tag, data)
    VALUES ($txid, $vout, $tag, $data)
  `);

  // Wrap in transaction
  const insert = this.db.transaction((txos: Txo[]) => {
    for (const txo of txos) {
      // Insert main TXO
      insertTxo.run({
        $txid: txo.outpoint.txid,
        $vout: txo.outpoint.vout,
        $satoshis: Number(txo.satoshis),  // Or BigInt if safeIntegers
        $script: new Uint8Array(txo.script),
        $status: txo.status,
        $block_height: txo.block.height,
        $block_idx: Number(txo.block.idx),
        $spend: txo.spend || '',
        $owner: txo.owner || null,
        $has_events: txo.hasEvents,
      });

      // Insert events
      for (const event of txo.events || []) {
        insertEvent.run({
          $txid: txo.outpoint.txid,
          $vout: txo.outpoint.vout,
          $event: event,
        });
      }

      // Insert tags
      for (const tag of txo.tags || []) {
        insertTag.run({
          $txid: txo.outpoint.txid,
          $vout: txo.outpoint.vout,
          $tag: tag,
        });
      }

      // Insert indexer data
      for (const [tag, data] of Object.entries(txo.data)) {
        insertData.run({
          $txid: txo.outpoint.txid,
          $vout: txo.outpoint.vout,
          $tag: tag,
          $data: JSON.stringify(data),
        });
      }
    }
  });

  insert(txos);  // Execute transaction
}
```

**Key Patterns:**
- `INSERT OR REPLACE`: Upsert semantics
- `INSERT OR IGNORE`: Skip duplicates in junction tables
- Transaction wrapping: All-or-nothing atomicity
- Prepared statements: Cached and reused

### 5.3 Complex Queries

**UTXO Search:**
```typescript
async getUtxos(owner?: string): Promise<Txo[]> {
  const query = this.db.query(`
    SELECT * FROM txos
    WHERE spend = ''
      AND has_events > 0
      ${owner ? 'AND owner = $owner' : ''}
    ORDER BY block_height DESC, block_idx DESC
  `);

  const rows = owner
    ? query.all({ $owner: owner })
    : query.all();

  return rows.map(row => this.hydrateTxo(row));
}
```

**Event Search with Pagination:**
```typescript
async searchEvents(
  eventPattern: string,
  limit: number,
  from?: string
): Promise<{ txos: Txo[]; nextPage?: string }> {
  // Use LIKE for prefix matching
  const query = this.db.query(`
    SELECT DISTINCT t.* FROM txos t
    INNER JOIN txo_events e ON t.txid = e.txid AND t.vout = e.vout
    WHERE e.event LIKE $pattern
      ${from ? 'AND e.event < $from' : ''}
    ORDER BY e.event DESC
    LIMIT $limit
  `);

  const rows = query.all({
    $pattern: eventPattern + '%',
    $from: from,
    $limit: limit + 1,  // Fetch one extra to check if more exist
  });

  const hasMore = rows.length > limit;
  const results = rows.slice(0, limit);
  const nextPage = hasMore ? rows[limit].event : undefined;

  return {
    txos: results.map(row => this.hydrateTxo(row)),
    nextPage,
  };
}
```

**Recursive Parent Resolution:**
```typescript
async resolveDependencies(outpoint: Outpoint): Promise<Outpoint[]> {
  // Common Table Expression (CTE) for recursive query
  const query = this.db.query(`
    WITH RECURSIVE deps_cte AS (
      -- Base case: direct dependencies
      SELECT dep_txid AS txid, dep_vout AS vout, 1 AS depth
      FROM txo_deps
      WHERE txid = $txid AND vout = $vout

      UNION ALL

      -- Recursive case: dependencies of dependencies
      SELECT d.dep_txid, d.dep_vout, c.depth + 1
      FROM txo_deps d
      INNER JOIN deps_cte c ON d.txid = c.txid AND d.vout = c.vout
      WHERE c.depth < 10  -- Prevent infinite recursion
    )
    SELECT DISTINCT txid, vout FROM deps_cte
    ORDER BY depth ASC
  `);

  const rows = query.all({
    $txid: outpoint.txid,
    $vout: outpoint.vout,
  });

  return rows.map(row => new Outpoint(row.txid, row.vout));
}
```

### 5.4 Serialization Helpers

```typescript
// Binary data handling
function serializeScript(script: number[]): Uint8Array {
  return new Uint8Array(script);
}

function deserializeScript(blob: Uint8Array): number[] {
  return Array.from(blob);
}

// BigInt handling
function serializeSatoshis(satoshis: bigint, safeIntegers: boolean): number | bigint {
  if (safeIntegers) {
    return satoshis;  // SQLite handles bigint
  }
  // Truncate to 53-bit (not recommended for production)
  return Number(satoshis);
}

function deserializeSatoshis(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

// JSON handling
function serializeIndexData(data: IndexData): string {
  return JSON.stringify(data);
}

function deserializeIndexData(json: string): IndexData {
  return JSON.parse(json);
}
```

---

## 6. Migration Utility

### 6.1 IDB to SQLite Migration

```typescript
import { Database } from "bun:sqlite";
import { openDB } from "idb";
import type { Txo, BlockHeader } from "../models";

export class StorageMigration {
  async migrateBlocks(
    network: 'mainnet' | 'testnet',
    sqlitePath: string
  ): Promise<void> {
    console.log(`Migrating blocks for ${network}...`);

    // Open IDB database
    const idb = await openDB(`blocks-${network}`, 1);

    // Open SQLite database
    const sqlite = new Database(`${sqlitePath}/blocks-${network}.db`, {
      create: true,
      safeIntegers: false,
    });

    // Initialize schema
    sqlite.exec(BLOCKS_SCHEMA);

    // Prepare insert statement
    const insert = sqlite.query(`
      INSERT OR REPLACE INTO blocks
      (height, hash, prev_hash, merkle_root, time, version, bits, nonce)
      VALUES ($height, $hash, $prev_hash, $merkle_root, $time, $version, $bits, $nonce)
    `);

    // Batch migration in transactions
    const migrate = sqlite.transaction((blocks: BlockHeader[]) => {
      for (const block of blocks) {
        insert.run({
          $height: block.height,
          $hash: block.hash,
          $prev_hash: block.prevHash,
          $merkle_root: block.merkleRoot,
          $time: block.time,
          $version: block.version,
          $bits: block.bits,
          $nonce: block.nonce,
        });
      }
    });

    // Fetch from IDB in batches
    const tx = idb.transaction('blocks', 'readonly');
    const store = tx.store;
    const BATCH_SIZE = 10000;
    let batch: BlockHeader[] = [];
    let count = 0;

    for await (const cursor of store.iterate()) {
      batch.push(cursor.value);

      if (batch.length >= BATCH_SIZE) {
        migrate(batch);
        count += batch.length;
        console.log(`Migrated ${count} blocks...`);
        batch = [];
      }
    }

    // Migrate remaining
    if (batch.length > 0) {
      migrate(batch);
      count += batch.length;
    }

    console.log(`✓ Migrated ${count} blocks`);

    await idb.close();
    sqlite.close();
  }

  async migrateTxos(
    accountId: string,
    network: 'mainnet' | 'testnet',
    sqlitePath: string
  ): Promise<void> {
    console.log(`Migrating TXOs for ${accountId}-${network}...`);

    const idb = await openDB(`txos-${accountId}-${network}`, 1);
    const sqlite = new Database(`${sqlitePath}/txos-${accountId}-${network}.db`, {
      create: true,
      safeIntegers: true,  // Use BigInt for satoshis
    });

    sqlite.exec(TXOS_SCHEMA);

    // Prepare statements
    const insertTxo = sqlite.query(`
      INSERT OR REPLACE INTO txos
      (txid, vout, satoshis, script, status, block_height, block_idx,
       spend, owner, has_events)
      VALUES ($txid, $vout, $satoshis, $script, $status, $block_height,
              $block_idx, $spend, $owner, $has_events)
    `);

    const insertEvent = sqlite.query(`
      INSERT OR IGNORE INTO txo_events (txid, vout, event)
      VALUES ($txid, $vout, $event)
    `);

    const insertTag = sqlite.query(`
      INSERT OR IGNORE INTO txo_tags (txid, vout, tag)
      VALUES ($txid, $vout, $tag)
    `);

    const insertData = sqlite.query(`
      INSERT OR REPLACE INTO txo_data (txid, vout, tag, data)
      VALUES ($txid, $vout, $tag, $data)
    `);

    const migrate = sqlite.transaction((txos: Txo[]) => {
      for (const txo of txos) {
        insertTxo.run({
          $txid: txo.outpoint.txid,
          $vout: txo.outpoint.vout,
          $satoshis: txo.satoshis,
          $script: new Uint8Array(txo.script),
          $status: txo.status,
          $block_height: txo.block.height,
          $block_idx: txo.block.idx,
          $spend: txo.spend || '',
          $owner: txo.owner || null,
          $has_events: txo.hasEvents,
        });

        for (const event of txo.events || []) {
          insertEvent.run({ $txid: txo.outpoint.txid, $vout: txo.outpoint.vout, $event: event });
        }

        for (const tag of txo.tags || []) {
          insertTag.run({ $txid: txo.outpoint.txid, $vout: txo.outpoint.vout, $tag: tag });
        }

        for (const [tag, data] of Object.entries(txo.data)) {
          insertData.run({
            $txid: txo.outpoint.txid,
            $vout: txo.outpoint.vout,
            $tag: tag,
            $data: JSON.stringify(data),
          });
        }
      }
    });

    const tx = idb.transaction('txos', 'readonly');
    const store = tx.store;
    const BATCH_SIZE = 1000;
    let batch: Txo[] = [];
    let count = 0;

    for await (const cursor of store.iterate()) {
      batch.push(cursor.value);

      if (batch.length >= BATCH_SIZE) {
        migrate(batch);
        count += batch.length;
        console.log(`Migrated ${count} TXOs...`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      migrate(batch);
      count += batch.length;
    }

    console.log(`✓ Migrated ${count} TXOs`);

    await idb.close();
    sqlite.close();
  }

  async migrateTxns(
    network: 'mainnet' | 'testnet',
    sqlitePath: string
  ): Promise<void> {
    console.log(`Migrating transactions for ${network}...`);

    const idb = await openDB(`txns-${network}`, 1);
    const sqlite = new Database(`${sqlitePath}/txns-${network}.db`, {
      create: true,
      safeIntegers: false,
    });

    sqlite.exec(TXNS_SCHEMA);

    const insert = sqlite.query(`
      INSERT OR REPLACE INTO txns
      (txid, rawtx, proof, status, block_height, block_idx)
      VALUES ($txid, $rawtx, $proof, $status, $block_height, $block_idx)
    `);

    const migrate = sqlite.transaction((txns: any[]) => {
      for (const txn of txns) {
        insert.run({
          $txid: txn.txid,
          $rawtx: new Uint8Array(txn.rawtx),
          $proof: txn.proof ? new Uint8Array(txn.proof) : null,
          $status: txn.status,
          $block_height: txn.block.height,
          $block_idx: Number(txn.block.idx),
        });
      }
    });

    const tx = idb.transaction('txns', 'readonly');
    const store = tx.store;
    const BATCH_SIZE = 1000;
    let batch: any[] = [];
    let count = 0;

    for await (const cursor of store.iterate()) {
      batch.push(cursor.value);

      if (batch.length >= BATCH_SIZE) {
        migrate(batch);
        count += batch.length;
        console.log(`Migrated ${count} transactions...`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      migrate(batch);
      count += batch.length;
    }

    console.log(`✓ Migrated ${count} transactions`);

    await idb.close();
    sqlite.close();
  }
}

// Usage
async function runMigration() {
  const migration = new StorageMigration();
  const sqlitePath = './data';  // Or VSCode storage path

  await migration.migrateBlocks('mainnet', sqlitePath);
  await migration.migrateTxns('mainnet', sqlitePath);
  await migration.migrateTxos('account1', 'mainnet', sqlitePath);
}
```

---

## 7. Performance Optimization

### 7.1 Index Strategy

**Critical Indexes (High Priority):**
```sql
-- UTXO queries (most common)
CREATE INDEX idx_txos_utxo ON txos(spend, has_events, block_height DESC, block_idx DESC)
WHERE spend = '';  -- Partial index

-- Event searches
CREATE INDEX idx_txo_events_search ON txo_events(event);

-- Tag searches
CREATE INDEX idx_txo_tags_search ON txo_tags(tag);

-- Transaction status queries
CREATE INDEX idx_txns_status ON txns(status, block_height);
```

**Secondary Indexes:**
```sql
-- Owner balance queries
CREATE INDEX idx_txos_owner ON txos(owner, spend, block_height DESC);

-- Spend lookups
CREATE INDEX idx_txos_spend ON txos(spend) WHERE spend != '';

-- Block hash lookups
CREATE UNIQUE INDEX idx_blocks_hash ON blocks(hash);

-- Transaction log history
CREATE INDEX idx_tx_logs_height ON tx_logs(height DESC, idx DESC);
```

**Index Maintenance:**
```typescript
// Periodically analyze query performance
db.exec("ANALYZE");

// Rebuild indexes if fragmented
db.exec("REINDEX");

// Check index usage
const stats = db.query("SELECT * FROM sqlite_stat1").all();
console.log("Index statistics:", stats);
```

### 7.2 Query Optimization

**Use Query Planning:**
```typescript
// Analyze query plan
const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM txos WHERE spend = ''").all();
console.log(plan);

// Look for "SCAN" vs "SEARCH" in output
// SCAN = full table scan (slow)
// SEARCH = index used (fast)
```

**Optimize Common Patterns:**

1. **Batch Reads:**
```typescript
// Bad: N queries
for (const outpoint of outpoints) {
  const txo = await getTxo(outpoint);  // N queries
}

// Good: 1 query with IN clause
const query = db.query(`
  SELECT * FROM txos
  WHERE (txid, vout) IN (VALUES ${outpoints.map(() => '(?, ?)').join(', ')})
`);
const txos = query.all(...outpoints.flatMap(o => [o.txid, o.vout]));
```

2. **Limit Result Sets:**
```typescript
// Always use LIMIT for pagination
const query = db.query(`
  SELECT * FROM txos
  WHERE spend = ''
  ORDER BY block_height DESC
  LIMIT $limit
`);
```

3. **Covering Indexes:**
```typescript
// If query only needs certain columns, create covering index
CREATE INDEX idx_txos_summary ON txos(spend, satoshis, owner, block_height)
WHERE spend = '';

// Query can be satisfied from index alone (no table lookup)
SELECT satoshis, owner FROM txos WHERE spend = '' AND owner = ?;
```

### 7.3 Transaction Batching

**Optimal Batch Sizes:**
- **Inserts**: 1000-5000 records per transaction
- **Reads**: 100-1000 lookups per query
- **Updates**: 500-2000 records per transaction

```typescript
const BATCH_SIZE = 1000;

async function batchInsert(items: Txo[]) {
  const insert = db.transaction((batch: Txo[]) => {
    for (const item of batch) {
      stmt.run(item);
    }
  });

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    insert(batch);
  }
}
```

### 7.4 Memory Management

**SQLite PRAGMAs:**
```sql
-- Adjust cache size (default: -2000 = 2MB)
PRAGMA cache_size = 10000;  -- 10MB cache

-- Use memory for temp tables
PRAGMA temp_store = MEMORY;

-- Limit memory mapping (if needed)
PRAGMA mmap_size = 268435456;  -- 256MB max
```

**Monitor Memory Usage:**
```typescript
const stats = db.query("PRAGMA page_count").get();
const pageSize = db.query("PRAGMA page_size").get();
const dbSize = stats.page_count * pageSize.page_size;
console.log(`Database size: ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
```

---

## 8. Testing Strategy

### 8.1 Unit Tests

```typescript
import { describe, test, expect } from "bun:test";
import { TxoStorageSQLite } from "./sqlite-txos";
import { Txo, Outpoint, Block } from "../models";

describe("TxoStorageSQLite", () => {
  test("should insert and retrieve TXO", async () => {
    const storage = new TxoStorageSQLite({
      type: 'sqlite',
      path: ':memory:',
      accountId: 'test',
      network: 'mainnet',
      safeIntegers: true,
    });

    const txo = new Txo(
      new Outpoint('abc123', 0),
      1000n,
      [0x76, 0xa9],
      0,
      new Block(800000, 0n)
    );

    await storage.put(txo);
    const retrieved = await storage.get(new Outpoint('abc123', 0));

    expect(retrieved).toBeDefined();
    expect(retrieved!.satoshis).toBe(1000n);
    expect(retrieved!.script).toEqual([0x76, 0xa9]);
  });

  test("should handle batch inserts", async () => {
    const storage = new TxoStorageSQLite({
      type: 'sqlite',
      path: ':memory:',
      accountId: 'test',
      network: 'mainnet',
    });

    const txos = Array.from({ length: 1000 }, (_, i) =>
      new Txo(
        new Outpoint(`tx${i}`, 0),
        BigInt(i),
        [0x76],
        0,
        new Block(800000 + i, 0n)
      )
    );

    const start = Date.now();
    await storage.putMany(txos);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(500);  // Should be fast

    const count = await storage.getUtxos();
    expect(count.length).toBe(1000);
  });

  test("should search by events", async () => {
    const storage = new TxoStorageSQLite({
      type: 'sqlite',
      path: ':memory:',
      accountId: 'test',
      network: 'mainnet',
    });

    const txo = new Txo(
      new Outpoint('abc123', 0),
      1000n,
      [],
      0,
      new Block(800000, 0n)
    );
    txo.events = ['fund:address:1ABC:0800000.000000000'];

    await storage.put(txo);

    const results = await storage.search(
      new TxoLookup('fund', 'address', '1ABC'),
      'desc',
      10
    );

    expect(results.txos.length).toBe(1);
    expect(results.txos[0].outpoint.txid).toBe('abc123');
  });
});
```

### 8.2 Integration Tests

```typescript
import { describe, test, expect } from "bun:test";
import { SPVStore } from "../spv-store";
import { OneSatProvider } from "../providers";
import { createTxoStorage, createTxnStorage, createBlockStorage } from "../storage";

describe("SPVStore with SQLite", () => {
  test("should initialize and sync", async () => {
    const blockStorage = createBlockStorage('sqlite', {
      type: 'sqlite',
      path: ':memory:',
      network: 'mainnet',
    });

    const txnStorage = createTxnStorage('sqlite', {
      type: 'sqlite',
      path: ':memory:',
      network: 'mainnet',
    });

    const txoStorage = createTxoStorage('sqlite', {
      type: 'sqlite',
      path: ':memory:',
      accountId: 'test',
      network: 'mainnet',
    });

    const spv = new SPVStore(
      {
        account: new OneSatProvider('mainnet', 'test'),
        blocks: new OneSatProvider('mainnet', 'test'),
        broadcast: new OneSatProvider('mainnet', 'test'),
      },
      {
        blocks: new BlockStore(blockStorage),
        txns: new TxnStore(txnStorage),
        txos: new TxoStore(txoStorage, [/* indexers */]),
      },
      new EventEmitter(),
      false  // Don't auto-sync in test
    );

    // Test sync operations
    await spv.stores.blocks!.sync(true);
    const tip = await spv.getChaintip();
    expect(tip).toBeDefined();
    expect(tip!.height).toBeGreaterThan(0);

    await spv.destroy();
  });
});
```

### 8.3 Performance Benchmarks

```typescript
import { bench, run } from "mitata";
import { TxoStorageIDB, TxoStorageSQLite } from "../storage";

// Setup
const idbStorage = new TxoStorageIDB({ accountId: 'bench', network: 'mainnet' });
const sqliteStorage = new TxoStorageSQLite({
  type: 'sqlite',
  path: ':memory:',
  accountId: 'bench',
  network: 'mainnet',
  safeIntegers: true,
});

const txos = generateTestTxos(10000);

// Benchmarks
bench("IDB: Insert 10k TXOs", async () => {
  await idbStorage.putMany(txos);
});

bench("SQLite: Insert 10k TXOs", async () => {
  await sqliteStorage.putMany(txos);
});

bench("IDB: Query 1k UTXOs", async () => {
  await idbStorage.getUtxos();
});

bench("SQLite: Query 1k UTXOs", async () => {
  await sqliteStorage.getUtxos();
});

bench("IDB: Search by events", async () => {
  await idbStorage.search(new TxoLookup('fund', 'address', '1ABC'), 'desc', 100);
});

bench("SQLite: Search by events", async () => {
  await sqliteStorage.search(new TxoLookup('fund', 'address', '1ABC'), 'desc', 100);
});

await run();
```

**Expected Results:**
```
Benchmark Results:
IDB: Insert 10k TXOs         2,000 ops/s   500 ms
SQLite: Insert 10k TXOs      5,000 ops/s   200 ms   ✓ 2.5x faster

IDB: Query 1k UTXOs          1,000 ops/s   1000 ms
SQLite: Query 1k UTXOs       3,000 ops/s   333 ms   ✓ 3x faster

IDB: Search by events        500 ops/s     2000 ms
SQLite: Search by events     2,000 ops/s   500 ms   ✓ 4x faster
```

---

## 9. Deployment & Rollout

### 9.1 Configuration

**Environment Detection:**
```typescript
// Automatically detect if running in Bun environment
const isBun = typeof Bun !== 'undefined';
const defaultStorage = isBun ? 'sqlite' : 'idb';

export async function createSPVStore(config: {
  accountId: string;
  network: 'mainnet' | 'testnet';
  owners: Set<string>;
  storageType?: 'idb' | 'sqlite';
  storagePath?: string;
}): Promise<SPVStore> {
  const type = config.storageType || defaultStorage;

  // Create storage instances
  const blockStorage = createBlockStorage(type, {
    type,
    network: config.network,
    path: config.storagePath,
  });

  const txnStorage = createTxnStorage(type, {
    type,
    network: config.network,
    path: config.storagePath,
  });

  const txoStorage = createTxoStorage(type, {
    type,
    accountId: config.accountId,
    network: config.network,
    path: config.storagePath,
    safeIntegers: true,
  });

  // ... initialize SPVStore
}
```

**VSCode Extension Configuration:**
```typescript
// In vscode-bitcoin extension
import { SPVStore } from 'spv-store';

export function activate(context: vscode.ExtensionContext) {
  const storagePath = context.globalStorageUri.fsPath;

  const spv = await createSPVStore({
    accountId: 'vscode',
    network: 'mainnet',
    owners: new Set([address]),
    storageType: 'sqlite',  // Force SQLite in VSCode
    storagePath,
  });

  // No more backup/restore needed!
  // SQLite persists automatically
}
```

### 9.2 Migration Path

**Option 1: Automatic Migration (Recommended)**
```typescript
async function initStorage(config: StorageConfig): Promise<Storage> {
  // Check if IDB data exists
  const hasIDB = await checkIDBExists(config.accountId, config.network);

  if (hasIDB && config.type === 'sqlite') {
    console.log('Migrating from IndexedDB to SQLite...');
    const migration = new StorageMigration();

    await migration.migrateBlocks(config.network, config.path!);
    await migration.migrateTxns(config.network, config.path!);
    await migration.migrateTxos(config.accountId, config.network, config.path!);

    console.log('✓ Migration complete');

    // Optionally delete IDB data
    // await deleteIDBDatabases(config.accountId, config.network);
  }

  return createStorage(config.type, config);
}
```

**Option 2: Manual Migration CLI**
```bash
# Command-line migration tool
bun run migrate-to-sqlite \
  --network mainnet \
  --account myaccount \
  --output ./data

# With progress reporting
Migrating blocks-mainnet...
  ✓ Migrated 870,000 blocks (100 MB)
Migrating txns-mainnet...
  ✓ Migrated 50,000 transactions (50 MB)
Migrating txos-myaccount-mainnet...
  ✓ Migrated 100,000 TXOs (120 MB)

Migration complete!
Total time: 45 seconds
```

### 9.3 Rollback Strategy

**Keep IDB as Fallback:**
```typescript
export function createStorage(config: StorageConfig): Storage {
  try {
    if (config.type === 'sqlite') {
      return new StorageSQLite(config);
    }
  } catch (error) {
    console.warn('SQLite initialization failed, falling back to IDB:', error);
    config.type = 'idb';
  }

  return new StorageIDB(config);
}
```

**Data Verification:**
```typescript
async function verifyMigration(
  idb: TxoStorageIDB,
  sqlite: TxoStorageSQLite
): Promise<boolean> {
  // Sample random TXOs
  const sampleSize = 100;
  const idbUtxos = await idb.getUtxos();
  const samples = idbUtxos.slice(0, sampleSize);

  for (const txo of samples) {
    const sqliteTxo = await sqlite.get(txo.outpoint);

    if (!sqliteTxo) {
      console.error(`Missing TXO: ${txo.outpoint}`);
      return false;
    }

    if (sqliteTxo.satoshis !== txo.satoshis) {
      console.error(`Satoshi mismatch: ${txo.outpoint}`);
      return false;
    }

    if (sqliteTxo.spend !== txo.spend) {
      console.error(`Spend mismatch: ${txo.outpoint}`);
      return false;
    }
  }

  console.log(`✓ Verified ${sampleSize} TXOs - migration successful`);
  return true;
}
```

---

## 10. Future Enhancements

### 10.1 Advanced Features

**Full-Text Search:**
```sql
-- Create FTS5 virtual table for inscription content
CREATE VIRTUAL TABLE txo_content_fts USING fts5(
  txid,
  vout,
  content,
  tokenize = 'porter'
);

-- Search inscription text
SELECT txid, vout FROM txo_content_fts
WHERE content MATCH 'bitcoin'
ORDER BY rank;
```

**Materialized Views:**
```sql
-- Pre-computed balance per address
CREATE TABLE address_balances AS
SELECT owner, SUM(satoshis) as balance, COUNT(*) as utxo_count
FROM txos
WHERE spend = ''
GROUP BY owner;

-- Refresh on updates
CREATE TRIGGER refresh_balances
AFTER INSERT ON txos
BEGIN
  DELETE FROM address_balances WHERE owner = NEW.owner;
  INSERT INTO address_balances
  SELECT owner, SUM(satoshis), COUNT(*)
  FROM txos
  WHERE owner = NEW.owner AND spend = ''
  GROUP BY owner;
END;
```

**Compression:**
```sql
-- Store large blobs compressed
CREATE TABLE txns_compressed (
  txid TEXT PRIMARY KEY,
  rawtx_compressed BLOB,  -- zstd or gzip compressed
  ...
);

-- Decompress on read
SELECT decompress(rawtx_compressed) as rawtx FROM txns_compressed;
```

### 10.2 Sharding Strategy

**For Very Large Datasets (>10M TXOs):**

```typescript
// Shard by block height range
const BLOCKS_PER_SHARD = 100000;

function getShardPath(height: number, config: StorageConfig): string {
  const shardNum = Math.floor(height / BLOCKS_PER_SHARD);
  return `${config.path}/txos-${config.accountId}-shard${shardNum}.db`;
}

class ShardedTxoStorage implements TxoStorage {
  private shards = new Map<number, TxoStorageSQLite>();

  private getShard(height: number): TxoStorageSQLite {
    const shardNum = Math.floor(height / BLOCKS_PER_SHARD);

    if (!this.shards.has(shardNum)) {
      const shard = new TxoStorageSQLite({
        ...this.config,
        path: getShardPath(height, this.config),
      });
      this.shards.set(shardNum, shard);
    }

    return this.shards.get(shardNum)!;
  }

  async put(txo: Txo): Promise<void> {
    const shard = this.getShard(txo.block.height);
    await shard.put(txo);
  }

  async getUtxos(): Promise<Txo[]> {
    // Query all shards
    const results = await Promise.all(
      Array.from(this.shards.values()).map(s => s.getUtxos())
    );
    return results.flat();
  }
}
```

### 10.3 Replication & Sync

**Cross-Device Sync:**
```typescript
// Export changes as binary log
async function exportChangelog(since: number): Promise<Uint8Array> {
  const query = db.query(`
    SELECT * FROM txos
    WHERE block_height > $since
    ORDER BY block_height, block_idx
  `);

  const changes = query.all({ $since: since });
  return serializeChanges(changes);  // Binary format
}

// Import changes from remote
async function importChangelog(data: Uint8Array): Promise<void> {
  const changes = deserializeChanges(data);

  const merge = db.transaction((items: Txo[]) => {
    for (const item of items) {
      // Upsert with conflict resolution
      insertOrUpdate(item);
    }
  });

  merge(changes);
}
```

---

## 11. Success Criteria

### 11.1 Performance Targets

| Metric | Current (IDB) | Target (SQLite) | Status |
|--------|---------------|-----------------|--------|
| Insert 10k TXOs | 500 ms | < 200 ms | ⏳ |
| Query 1k UTXOs | 1000 ms | < 333 ms | ⏳ |
| Search by event | 2000 ms | < 500 ms | ⏳ |
| Database size | 120 MB | < 100 MB | ⏳ |
| Startup time | 2s | < 1s | ⏳ |
| Memory usage | 50 MB | < 30 MB | ⏳ |

### 11.2 Functional Requirements

- ✅ All existing tests pass
- ✅ API compatibility maintained
- ✅ Migration tool works reliably
- ✅ No data loss during migration
- ✅ Performance improvements verified
- ✅ Documentation updated
- ✅ VSCode extension integration tested

### 11.3 Non-Functional Requirements

- ✅ Zero downtime migration (fallback to IDB)
- ✅ Comprehensive error handling
- ✅ Logging and monitoring
- ✅ Backward compatibility for 2 versions
- ✅ User migration guide published

---

## 12. Timeline & Milestones

### Week 1: Foundation
- [ ] Create SQLite storage interfaces
- [ ] Implement BlockStorageSQLite
- [ ] Write unit tests
- [ ] Benchmark performance

### Week 2: Transactions
- [ ] Implement TxnStorageSQLite
- [ ] Test BEEF serialization
- [ ] Implement backup/restore
- [ ] Integration tests

### Week 3-4: TXO Storage
- [ ] Implement TxoStorageSQLite core
- [ ] Normalize events/tags/deps tables
- [ ] Handle indexer data
- [ ] CRUD operation tests

### Week 5: Search & Queries
- [ ] Implement complex search
- [ ] Optimize indexes
- [ ] Cursor pagination
- [ ] Query performance tests

### Week 6: Integration
- [ ] Create migration utility
- [ ] Configuration system
- [ ] VSCode extension testing
- [ ] Performance tuning

### Week 7: Production
- [ ] Comprehensive test suite
- [ ] Documentation
- [ ] Migration guide
- [ ] Release preparation

---

## 13. Risk Mitigation

### 13.1 Identified Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| BigInt overflow | High | Low | Use `safeIntegers: true`, validate inputs |
| Migration data loss | Critical | Low | Verify migration, keep IDB backup |
| Performance regression | High | Medium | Comprehensive benchmarks, rollback plan |
| SQLite file corruption | High | Low | WAL mode, regular backups, repair utilities |
| Memory leaks | Medium | Medium | Proper connection cleanup, monitoring |
| Cross-platform issues | Medium | Low | Test on macOS/Linux/Windows |

### 13.2 Contingency Plans

**If Migration Fails:**
1. Keep IDB implementation active
2. Fallback automatically
3. Log errors for investigation
4. Retry migration with fixes

**If Performance is Worse:**
1. Analyze query plans
2. Add missing indexes
3. Optimize batch sizes
4. Consider sharding

**If Bugs are Found:**
1. Rollback to IDB
2. Fix issues in SQLite implementation
3. Re-test thoroughly
4. Gradual rollout (opt-in flag)

---

## 14. Resources

### 14.1 Documentation

- [Bun SQLite Docs](https://bun.sh/docs/api/sqlite)
- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [SQLite Query Optimization](https://www.sqlite.org/queryplanner.html)
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

### 14.2 Tools

- **Benchmarking**: mitata, hyperfine
- **Testing**: bun:test
- **Profiling**: bun --inspect
- **Database Tools**: sqlite3 CLI, DB Browser for SQLite

### 14.3 Code Examples

See `/Users/satchmo/code/spv-store/examples/` for:
- Migration scripts
- Performance benchmarks
- Integration examples
- Testing utilities

---

## Conclusion

This migration plan provides a comprehensive roadmap for transitioning spv-store from IndexedDB to Bun's native SQLite storage. The phased approach ensures minimal risk while delivering significant performance improvements and eliminating the need for constant backup/restore cycles.

**Key Takeaways:**
1. SQLite provides 3-6x performance improvement
2. Native persistence eliminates backup overhead
3. API compatibility is maintained
4. Migration is reversible (fallback to IDB)
5. 7-week timeline with clear milestones

**Next Steps:**
1. Review and approve this plan
2. Set up development environment
3. Begin Phase 1 implementation
4. Establish testing/benchmarking baseline

---

**Document Version**: 1.0
**Last Updated**: 2025-10-17
**Author**: Claude + Satchmo
**Status**: Draft - Awaiting Approval
