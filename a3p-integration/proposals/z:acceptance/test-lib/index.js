export const networkConfig = {
  rpcAddrs: ['http://0.0.0.0:26657'],
  chainName: 'agoriclocal',
};

/**
 * Resolve after a delay in milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(() => resolve(), ms));

export const walletUtils = await makeWalletUtils(
  { delay, execFileSync, fetch },
  networkConfig,
);
