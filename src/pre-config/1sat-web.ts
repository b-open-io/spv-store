import { OneSatProvider } from "../providers/1sat-provider";
import {
  SPVStore,
  type Network,
  type Services,
  type Stores,
} from "../spv-store";
import { ParseMode, type Indexer } from "../models/indexer";
import { BlockStore, TxnStore, TxoStore } from "../stores";
import { EventEmitter } from "../lib/event-emitter";
import { createBaseStorage, createTxoStorage } from "../storage/factory";

export class OneSatWebSPV extends SPVStore {
  private constructor(
    public services: Services,
    public stores: Stores,
    public events: EventEmitter,
    startSync = false,
    syncTags?: Set<string>,
  ) {
    super(services, stores, events, startSync, syncTags);
  }

  static async init(
    accountId: string,
    indexers: Indexer[],
    owners = new Set<string>(),
    network: Network = "mainnet",
    startSync = false,
    syncTags?: Set<string>,
    parseMode?: ParseMode,
    storagePath?: string,
  ) {
    const oneSatService = new OneSatProvider(network, accountId);
    const emitter = new EventEmitter();
    const services: Services = {
      account: oneSatService,
      blocks: oneSatService,
      txns: oneSatService,
      broadcast: oneSatService,
    };

    // Create block and txn storage first (no circular dependencies)
    const { blocks: blockStorage, txns: txnStorage } = createBaseStorage({
      network,
      path: storagePath,
    });

    // Create store wrappers
    const stores: Stores = {};
    stores.blocks = new BlockStore(blockStorage, services, emitter);
    stores.txns = new TxnStore(txnStorage, services, stores, emitter);

    // Now create txo storage with txnStore dependency
    const txoStorage = createTxoStorage({
      accountId,
      network,
      path: storagePath,
      txnStore: stores.txns,
    });

    stores.txos = new TxoStore(
      txoStorage,
      services,
      stores,
      indexers,
      owners,
      emitter,
    );

    return new SPVStore(services, stores, emitter, startSync, syncTags, parseMode);
  }
}
