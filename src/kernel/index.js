/* global SES */

import harden from '@agoric/harden';
import Nat from '@agoric/nat';
import p2 from './p2';

export default function buildKernel(kernelEndowments) {
  console.log('in buildKernel', kernelEndowments);
  p2(); // temporary, to exercise bundling

  let running = false;
  const vats = harden(new Map());
  const runQueue = [];
  // kernelSlots[fromVatID] = { forward, backward }
  // forward[fromSlotID] = { vatID, slotID }
  // backward[`${toVatID}.${toSlotID}`] = fromSlotID
  const kernelSlots = harden(new Map());
  // nextImportIndex[vatID] = -number
  const nextImportIndex = harden(new Map());

  function mapOutbound(fromVatID, fromSlotID) {
    // fromSlotID might be positive (an export of fromVatID), or negative (an
    // import from somewhere else). Exports don't need translation into the
    // neutral { vatID, slotID } format.
    if (fromSlotID > 0) {
      return { vatID: fromVatID, slotID: fromSlotID };
    }
    // imports (of fromVatID) must be translated into the neutral
    // non-Vat-specific form
    return kernelSlots.get(fromVatID).forward.get(fromSlotID);
  }

  function allocateImportIndex(vatID) {
    const i = nextImportIndex[vatID];
    nextImportIndex[vatID] -= 1;
    return i;
  }

  function mapInbound(toVatID, vatID, slotID) {
    const m = kernelSlots.get(toVatID);
    // slotID is always positive, since it is somebody else's export
    Nat(slotID);
    const key = `${vatID}.${slotID}`; // ugh javascript
    if (!m.backward.has(key)) {
      // must add both directions
      const newSlotID = allocateImportIndex(toVatID);
      m.forward.set(newSlotID, harden({ vatID, slotID }));
      m.backward.set(key, newSlotID);
    }
    return m.backward.get(key);
  }

  const syscallBase = harden({
    send(fromVatID, targetSlot, method, argsString, vatSlots) {
      const { vatID: toVatID, slotID: facetID } = mapOutbound(
        fromVatID,
        targetSlot,
      );
      const slots = vatSlots.map(outSlotID =>
        mapOutbound(fromVatID, outSlotID),
      );
      runQueue.push({ toVatID, facetID, method, argsString, slots });
    },
  });

  function syscallForVatID(fromVatID) {
    return harden({
      send(targetSlot, method, argsString, vatSlots) {
        return syscallBase.send(
          fromVatID,
          targetSlot,
          method,
          argsString,
          vatSlots,
        );
      },
      // TODO: this is temporary, obviously vats shouldn't be able to pause the kernel
      pause() {
        running = false;
      },
    });
    // TODO: since we pass this in on each deliver() call, consider
    // destroying this object after each delivery, to discourage vat code
    // from retaining it. OTOH if we don't expect to ever change it, that's
    // wasteful and limiting.
  }

  function addVat(vatID, occupant) {
    const vat = harden({
      id: vatID,
      dispatch: SES.evaluate(occupant),
      syscall: syscallForVatID(vatID),
    });
    vats.set(vatID, vat);
    if (!kernelSlots.has(vatID)) {
      kernelSlots.set(vatID, {
        forward: harden(new Map()),
        backward: harden(new Map()),
      });
    }
    nextImportIndex[vatID] = -1;
  }

  function deliverOneMessage(message) {
    const vat = vats[message.toVatID];
    const inputSlots = message.slots.map(n =>
      mapInbound(message.toVatID, n.vatID, n.slotID),
    );
    // TODO: protect with promise/then
    vat.dispatch(
      vat.syscall,
      message.facetID,
      message.method,
      message.argsString,
      inputSlots,
    );
  }

  const controller = harden({
    addVat(vatID, occupant) {
      addVat(`${vatID}`, `${occupant}`);
    },

    dumpSlots() {
      const vatTables = Array.from(vats.entries()).map((vat, vatID) => {
        // TODO: find some way to expose these, the kernel doesn't see them
        return { vatID };
      });

      const kernelTable = [];
      kernelSlots.forEach((fb, vatID) => {
        fb.forward.forEach((target, slotID) => {
          kernelTable.push([vatID, slotID, target.vatID, target.slotID]);
        });
      });

      function compareNumbers(a, b) {
        return a - b;
      }

      function compareStrings(a, b) {
        if (a > b) {
          return 1;
        }
        if (a < b) {
          return -1;
        }
        return 0;
      }

      kernelTable.sort(
        (a, b) =>
          compareStrings(a[0], b[0]) ||
          compareNumbers(a[1], b[1]) ||
          compareStrings(a[2], b[2]) ||
          compareNumbers(a[3], b[3]) ||
          0,
      );

      return { vatTables, kernelTable };
    },

    run() {
      // process all messages, until syscall.pause() is invoked
      running = true;
      while (running && runQueue.length) {
        deliverOneMessage(runQueue.shift());
      }
    },

    drain() {
      // process all existing messages, but stop before processing new ones
      running = true;
      let remaining = runQueue.length;
      while (running && remaining) {
        deliverOneMessage(runQueue.shift());
        remaining -= 1;
      }
    },

    step() {
      // process a single message
      if (runQueue.length) {
        deliverOneMessage(runQueue.shift());
      }
    },

    queue(vatID, facetID, method, argsString) {
      // queue a message on the end of the queue. Use 'step' or 'run' to
      // execute it
      runQueue.push({
        vatID: `${vatID}`,
        facetID: `${facetID}`,
        method: `${method}`,
        argsString: `${argsString}`,
        slots: [],
      });
    },
  });

  return controller;
}
