import { SubscriberShape, makePublicTopic } from '@agoric/notifier';
import { StorageNodeShape } from '@agoric/notifier/src/typeGuards.js';
import { mustMatch } from '@agoric/store';
import { makeAtomicProvider } from '@agoric/store/src/stores/store-utils.js';
import {
  M,
  makeScalarBigMapStore,
  provide,
  provideDurableMapStore,
  provideDurableSetStore,
} from '@agoric/vat-data';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

/// <reference types="@agoric/notifier/src/types-ambient.js"/>

/**
 * SCALE: Only for low cardinality provisioning. Every value from init() will
 * remain in the map for the lifetime of the heap. If a key object is GCed, its
 * representative also remains.
 *
 * @template {{}} E Ephemeral state
 * @param {() => E} init
 */
export const makeEphemeraProvider = init => {
  /** @type {WeakMap<any, E>} */
  const extant = new WeakMap();

  /**
   * Provide an object to hold state that need not (or cannot) be durable.
   *
   * @type {(key: any) => E}
   */
  return key => {
    if (extant.has(key)) {
      // @ts-expect-error cast
      return extant.get(key);
    }
    const newEph = init();
    extant.set(key, newEph);
    return newEph;
  };
};
harden(makeEphemeraProvider);

/**
 *
 */
export const makePublicTopicProvider = () => {
  /** @type {WeakMap<Subscriber<any>, import('@agoric/notifier').PublicTopic<any>>} */
  const extant = new WeakMap();

  /**
   * Provide a PublicTopic for the specified durable subscriber.
   * Memoizes the resolution of the promise for the storageNode's path, for the lifetime of the vat.
   *
   * @template {object} T
   * @param {string} description
   * @param {Subscriber<T>} durableSubscriber primary key
   * @param {ERef<StorageNode>} storageNode
   * @returns {import('@agoric/notifier').PublicTopic<T>}
   */
  const providePublicTopic = (description, durableSubscriber, storageNode) => {
    if (extant.has(durableSubscriber)) {
      // @ts-expect-error cast
      return extant.get(durableSubscriber);
    }
    mustMatch(
      harden({ description, durableSubscriber, storageNode }),
      harden({
        description: M.string(),
        durableSubscriber: SubscriberShape,
        storageNode: M.eref(StorageNodeShape),
      }),
    );

    /** @type {import('@agoric/notifier').PublicTopic<T>} */
    const newMeta = makePublicTopic(
      description,
      durableSubscriber,
      storageNode,
    );
    extant.set(durableSubscriber, newMeta);
    return newMeta;
  };
  return providePublicTopic;
};
harden(makePublicTopicProvider);

/**
 *
 * @param {import('@agoric/vat-data').Baggage} baggage
 */
export const makeStorageNodePathProvider = baggage => {
  /** @type {import('@agoric/store/src/stores/store-utils.js').AtomicProvider<StorageNode, string>} */
  const nodePaths = makeAtomicProvider(
    provideDurableMapStore(baggage, 'storage node paths'),
  );
  /** @param {ERef<StorageNode>} nodeP */
  return async nodeP => {
    const node = await nodeP;
    return nodePaths.provideAsync(node, n => E(n).getPath());
  };
};

/**
 * Provide an empty ZCF seat.
 *
 * @param {ZCF} zcf
 * @param {import('@agoric/ertp').Baggage} baggage
 * @param {string} name
 * @returns {ZCFSeat}
 */
export const provideEmptySeat = (zcf, baggage, name) => {
  return provide(baggage, name, () => zcf.makeEmptySeatKit().zcfSeat);
};
harden(provideEmptySeat);

/**
 * For making singletons, so that each baggage carries a separate kind definition (albeit of the definer)
 *
 * @param {import('@agoric/vat-data').Baggage} baggage
 * @param {string} category diagnostic tag
 */
export const provideChildBaggage = (baggage, category) => {
  const baggageSet = provideDurableSetStore(baggage, `${category}Set`);
  return Far('childBaggageManager', {
    // TODO(types) infer args
    /**
     * @template {(baggage: import('@agoric/ertp').Baggage, ...rest: any) => any} M Maker function
     * @param {string} childName diagnostic tag
     * @param {M} makeChild
     * @param {...any} nonBaggageArgs
     * @returns {ReturnType<M>}
     */
    addChild: (childName, makeChild, ...nonBaggageArgs) => {
      const childStore = makeScalarBigMapStore(`${childName}${category}`, {
        durable: true,
      });
      const result = makeChild(childStore, ...nonBaggageArgs);
      baggageSet.add(childStore);
      return result;
    },
    children: () => baggageSet.values(),
  });
};
harden(provideChildBaggage);
/** @typedef {ReturnType<typeof provideChildBaggage>} ChildBaggageManager */
