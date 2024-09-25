import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import type { TestFn } from 'ava';
import {
  LiquidationTestContext,
  makeLiquidationTestContext,
} from '../../tools/liquidation.js';

const test = anyTest as TestFn<LiquidationTestContext>;

test.before(async t => {
  t.context = await makeLiquidationTestContext(t);
});

test.serial('change DebtLimit via econ governance', async t => {
  const { governanceDriver, agoricNamesRemotes, readLatest } = t.context;
  await governanceDriver.changeParams(
    agoricNamesRemotes.instance.VaultFactory,
    {
      DebtLimit: {
        brand: agoricNamesRemotes.brand.IST,
        value: BigInt(100_000 * 1_000_000),
      },
    },
    {
      paramPath: {
        key: {
          collateralBrand: agoricNamesRemotes.brand.ATOM,
        },
      },
    },
  );

  t.like(readLatest(`published.vaultFactory.managers.manager0.governance`), {
    current: {
      DebtLimit: { value: { value: BigInt(100_000 * 1_000_000) } },
    },
  });
});

test.serial('perform null upgrde on vaultFactory', async t => {
  const {
    runUtils: { EV },
  } = t.context;

  // @ts-expect-error
  const { adminFacet, privateArgs } =
    await EV.vat('bootstrap').consumeItem('vaultFactoryKit');
  t.log('privateArgs', privateArgs);
  const upgradeResult = await EV(adminFacet).restartContract(privateArgs);
  t.deepEqual(upgradeResult, { incarnationNumber: 1 });
  t.pass();
});

test.serial('now try to change DebtLimit again', async t => {
  const { governanceDriver, agoricNamesRemotes, readLatest } = t.context;
  await t.throwsAsync(() => governanceDriver.changeParams(
    agoricNamesRemotes.instance.VaultFactory,
    {
      DebtLimit: {
        brand: agoricNamesRemotes.brand.IST,
        value: BigInt(99_000 * 1_000_000),
      },
    },
    {
      paramPath: {
        key: {
          collateralBrand: agoricNamesRemotes.brand.ATOM,
        },
      },
    },
  ))
});
