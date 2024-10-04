/**
 * @file In this file we aim to test auctioneer in an isolated manner. Here's the scenario to test;
 * - Send 100 ATOMs to gov1 from validator
 * - For book0, ATOM is collateral, set two types of bids; by price and by percentage, user1 is the bidder
 * - Deposit 100 ATOMs into book0, gov1 is the depositor
 * - Wait until placed bids get their payouts
 * - Make sure the depositor gets correct amounts
 */

/** @typedef {import('./test-lib/sync-tools.js').RetyrOptions} RetryOptions */

import {
  addPreexistingOracles,
  agd,
  agopsInter,
  agoric,
  ATOM_DENOM,
  CHAINID,
  executeOffer,
  getPriceQuote,
  getUser,
  GOV1ADDR,
  GOV3ADDR,
  pushPrices,
  USER1ADDR,
  VALIDATORADDR,
} from '@agoric/synthetic-chain';
import '@endo/init';
import test from 'ava';
import { boardSlottingMarshaller, makeFromBoard } from './test-lib/rpc.js';
import {
  retryUntilCondition,
  waitUntilAccountFunded,
  waitUntilOfferResult,
} from './test-lib/sync-tools.js';
import { AmountMath } from '@agoric/ertp';

export const scale6 = x => BigInt(Math.round(x * 1_000_000));

const ambientAuthority = {
  query: agd.query,
  follow: agoric.follow,
  setTimeout: globalThis.setTimeout,
};

const fromBoard = makeFromBoard();
const marshaller = boardSlottingMarshaller(fromBoard.convertSlotToVal);

export const bankSend = (from, addr, wanted) => {
  const chain = ['--chain-id', CHAINID];
  const fromArg = ['--from', from];
  const testKeyring = ['--keyring-backend', 'test'];
  const noise = [...fromArg, ...chain, ...testKeyring, '--yes'];

  return agd.tx('bank', 'send', from, addr, wanted, ...noise);
};

const config = {
  depositor: {
    depositValue: '100000000',
    offerId: `gov1-deposit-${Date.now()}`,
  },
  price: 50.0,
  bidsSetup: [
    {
      bidder: USER1ADDR,
      bidderFund: {
        value: 90000000,
        denom: 'uist',
      },
      offerId: `user1-bid-${Date.now()}`,
      give: '90IST',
      price: 46,
    },
    {
      bidder: GOV3ADDR,
      bidderFund: {
        value: 150000000,
        denom: 'uist',
      },
      offerId: `gov3-bid-${Date.now()}`,
      give: '150IST',
      discount: '13',
    },
  ],
  bidsOutcome: [
    {
      payouts: {
        Bid: 0,
        Collateral: 1.68421,
      },
    },
    {
      payouts: {
        Bid: 0,
        Collateral: 2.0,
      },
    },
    {
      payouts: {
        Bid: 0,
        Collateral: 3.448275,
      },
    },
  ],
};

const pushPricesForAuction = async t => {
  const oraclesByBrand = new Map();
  await addPreexistingOracles('ATOM', oraclesByBrand);

  await pushPrices(config.price, 'ATOM', oraclesByBrand, t.context.roundId + 1);

  await retryUntilCondition(
    () => getPriceQuote('ATOM'),
    res => res === `+${scale6(config.price).toString()}`,
    'price not pushed yet',
    {
      log: t.log,
      setTimeout: globalThis.setTimeout,
      ...t.context.pushPriceRetryOpts,
    },
  );
};

const fundAccts = async (depositorAmt = '100000000', t) => {
  const retryOpts = t.context.retryOpts.bankSendRetryOpts;

  await bankSend(VALIDATORADDR, GOV1ADDR, `${depositorAmt}${ATOM_DENOM}`),
    await waitUntilAccountFunded(
      GOV1ADDR,
      ambientAuthority,
      { denom: ATOM_DENOM, value: Number(depositorAmt) },
      { errorMessage: 'gov1 not funded yet', ...retryOpts },
    );

  const user1Fund = config.bidsSetup[0].bidderFund;
  await bankSend(GOV1ADDR, USER1ADDR, `${user1Fund.value}${user1Fund.denom}`);
  await waitUntilAccountFunded(USER1ADDR, ambientAuthority, user1Fund, {
    errorMessage: 'user1 not funded yet',
    ...retryOpts,
  });

  const gov3Fund = config.bidsSetup[1].bidderFund;
  await bankSend(GOV1ADDR, GOV3ADDR, `${gov3Fund.value}${gov3Fund.denom}`);
  await waitUntilAccountFunded(GOV3ADDR, ambientAuthority, gov3Fund, {
    errorMessage: 'gov3 not funded yet',
    ...retryOpts,
  });
};

const bidByPrice = (price, give, offerId, bidder, t) => {
  return agopsInter(
    'bid',
    'by-price',
    `--price ${price}`,
    `--give ${give}`,
    '--from',
    bidder,
    '--keyring-backend test',
    `--offer-id ${offerId}`,
  );
};

const bidByDiscount = (discount, give, offerId, bidder, t) => {
  return agopsInter(
    'bid',
    'by-discount',
    `--discount ${discount}`,
    `--give ${give}`,
    '--from',
    bidder,
    '--keyring-backend test',
    `--offer-id ${offerId}`,
  );
};

const placeBids = t => {
  return [...config.bidsSetup].map(
    ({ bidder, offerId, price, give, discount }) => {
      if (price) return bidByPrice(price, give, offerId, bidder, t);
      return bidByDiscount(discount, give, offerId, bidder, t);
    },
  );
};

const depositCollateral = async t => {
  const [brandsRaw, retryOptions] = await Promise.all([
    agoric.follow('-lF', ':published.agoricNames.brand', '-o', 'text'),
    calculateRetryUntilNextStartTime(),
  ]);
  const brands = Object.fromEntries(
    marshaller.fromCapData(JSON.parse(brandsRaw)),
  );

  const offerSpec = {
    id: config.depositor.offerId,
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['auctioneer'],
      callPipe: [['makeDepositInvitation']],
    },
    proposal: {
      give: {
        Collateral: { brand: brands.ATOM, value: 100_000_000n },
      },
    },
  };

  const spendAction = {
    method: 'executeOffer',
    offer: offerSpec,
  };

  const offer = JSON.stringify(marshaller.toCapData(harden(spendAction)));
  t.log('OFFER', offer);

  executeOffer(GOV1ADDR, offer);
  return waitUntilOfferResult(
    GOV1ADDR,
    config.depositor.offerId,
    true,
    ambientAuthority,
    {
      errorMessage: 'proceeds not distributed yet',
      ...retryOptions,
    },
  );
};

const checkBidsOutcome = (settledBids, t, brands) => {
  [...settledBids]
    .map(bidResult => bidResult.status.payouts)
    .forEach(({ Bid, Collateral }, i) => {
      const {
        payouts: { Bid: outcomeBidVal, Collateral: outcomeColVal },
      } = config.bidsOutcome[i];
      t.is(
        AmountMath.isEqual(
          Bid,
          AmountMath.make(brands.IST, scale6(outcomeBidVal)),
        ),
        true,
      );
      t.is(
        AmountMath.isGTE(
          Collateral,
          AmountMath.make(brands.ATOM, scale6(outcomeColVal)),
        ),
        true,
      );
    });
};

const getCapturedPrice = async bookId => {
  const result = await agoric.follow('-lF', `:published.auction.${bookId}`);
  return result;
};

const checkPrice = (res, expected) => {
  if (res.startPrice === null) return false;
  else if (res.startPrice.numerator.value === expected) return true;
  return false;
};

/**
 * Calculates a set of retry options based on current auction params
 */
const calculateRetryUntilNextStartTime = async () => {
  const schedule = await agoric.follow('-lF', ':published.auction.schedule');
  const nextStartTime = parseInt(schedule.nextStartTime.absValue);

  /** @type {RetryOptions} */
  const capturePriceRetryOpts = {
    maxRetries: Math.round((nextStartTime * 1000 - Date.now()) / 10000) + 2, // wait until next schedule
    retryIntervalMs: 10000, // 10 seconds in ms
  };

  return capturePriceRetryOpts;
};

test.before(async t => {
  /** @type {RetryOptions} */
  const pushPriceRetryOpts = {
    maxRetries: 5, // arbitrary
    retryIntervalMs: 5000, // in ms
  };

  /** @type {RetryOptions} */
  const bankSendRetryOpts = {
    maxRetries: 3, // arbitrary
    retryIntervalMs: 3000, // in ms
  };

  // Get current round id
  const round = await agoric.follow(
    '-lF',
    ':published.priceFeed.ATOM-USD_price_feed.latestRound',
  );

  t.context = {
    roundId: parseInt(round.roundId),
    retryOpts: {
      bankSendRetryOpts,
      pushPriceRetryOpts,
    },
  };
});

test.only('run auction', async t => {
  // Push the price to a point where only our bids can settle
  await pushPricesForAuction(t);

  // Wait until next round starts. Retry error message is useful for debugging
  const retryOptions = await calculateRetryUntilNextStartTime();
  await retryUntilCondition(
    () => getCapturedPrice('book0'),
    res => checkPrice(res, scale6(config.price).toString()), // scale price to uist
    'price not captured yet [AUCTION TEST]',
    {
      log: t.log,
      ...ambientAuthority,
      ...retryOptions,
    },
  );

  // Make sure depositor and bidders have enough balance
  await fundAccts(config.depositor.depositValue, t);
  const bidsP = placeBids(t);
  const proceedsP = depositCollateral(t);

  // Resolves when auction finalizes and depositor gets payouts
  const [longLivingBidderAddr] = await Promise.all([
    getUser('long-living-bidder'),
    ...bidsP,
    proceedsP,
  ]);

  // Query wallets of the actors involved for assertions
  const [gov1Results, longLivingBidResults, user1Results, gov3Results, brands] =
    await Promise.all([
      agoric
        .follow('-lF', `:published.wallet.${GOV1ADDR}`, '-o', 'text')
        .then(res => marshaller.fromCapData(JSON.parse(res))),
      agoric
        .follow(
          '-lF',
          `:published.wallet.${longLivingBidderAddr}`,
          '-o',
          'text',
        )
        .then(res => marshaller.fromCapData(JSON.parse(res))),
      agoric
        .follow('-lF', `:published.wallet.${USER1ADDR}`, '-o', 'text')
        .then(res => marshaller.fromCapData(JSON.parse(res))),
      agoric
        .follow('-lF', `:published.wallet.${GOV3ADDR}`, '-o', 'text')
        .then(res => marshaller.fromCapData(JSON.parse(res))),
      agoric
        .follow('-lF', ':published.agoricNames.brand', '-o', 'text')
        .then(res =>
          Object.fromEntries(marshaller.fromCapData(JSON.parse(res))),
        ),
    ]);

  // Assert depositor paid correctly
  const { Bid: depositorBid, Collateral: depositorCol } =
    gov1Results.status.payouts;

  t.is(
    AmountMath.isEqual(depositorBid, AmountMath.make(brands.IST, 320_000_000n)),
    true,
  );

  t.is(
    AmountMath.isGTE(
      AmountMath.make(brands.ATOM, 100_000_000n - 7_132_485n),
      depositorCol,
    ),
    true,
  );

  // Assert bidders paid correctly
  checkBidsOutcome(
    [longLivingBidResults, user1Results, gov3Results],
    t,
    brands,
  );
});
