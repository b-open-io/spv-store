import type { BlockStorage } from "./block-storage";
import type { TxnStorage } from "./txn-storage";
import type { TxoStorage } from "./txo-storage";
import type { Network } from "../spv-store";
import type { TxnStore } from "../stores";
import { BlockStorageSQLite } from "./sqlite/sqlite-blocks";
import { TxnStorageSQLite } from "./sqlite/sqlite-txns";
import { TxoStorageSQLite } from "./sqlite/sqlite-txos";

export interface StorageConfig {
  network: Network;
  path?: string;
  safeIntegers?: boolean;
}

export interface TxoStorageConfig extends StorageConfig {
  accountId: string;
  txnStore: TxnStore;
}

/**
 * Create a BlockStorage instance (SQLite)
 */
export function createBlockStorage(config: StorageConfig): BlockStorage {
  return BlockStorageSQLite.init(config.network, config.path);
}

/**
 * Create a TxnStorage instance (SQLite)
 */
export function createTxnStorage(config: StorageConfig): TxnStorage {
  return TxnStorageSQLite.init(config.network, config.path);
}

/**
 * Create a TxoStorage instance (SQLite)
 */
export function createTxoStorage(config: TxoStorageConfig): TxoStorage {
  return TxoStorageSQLite.init(
    config.accountId,
    config.network,
    config.txnStore,
    config.path
  );
}

/**
 * Create block and txn storage together (they don't depend on each other)
 */
export function createBaseStorage(
  config: StorageConfig
): {
  blocks: BlockStorage;
  txns: TxnStorage;
} {
  const blocks = createBlockStorage(config);
  const txns = createTxnStorage(config);

  return { blocks, txns };
}

/**
 * Create all storage instances with proper dependency order
 * Note: This returns storage backends only. You still need to wrap them in Store classes.
 */
export function createStorage(
  config: Omit<TxoStorageConfig, 'txnStore'> & { txnStore?: TxnStore }
): {
  blocks: BlockStorage;
  txns: TxnStorage;
  txos: TxoStorage | null;
} {
  // Create block and txn storage first (no dependencies)
  const { blocks, txns } = createBaseStorage(config);

  // If txnStore is provided, create txo storage
  let txos: TxoStorage | null = null;
  if (config.txnStore) {
    txos = createTxoStorage({
      ...config,
      txnStore: config.txnStore,
    } as TxoStorageConfig);
  }

  return { blocks, txns, txos };
}
