/**
 * stellarService.js
 *
 * Core Stellar operations:
 *   - Create campaign wallets (multisig)
 *   - Establish trustlines
 *   - Build and submit contribution transactions
 *   - Path payment (cross-currency contributions)
 */

const {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
} = require('@stellar/stellar-sdk');
const {
  server,
  networkPassphrase,
  USDC,
  isTestnet,
  configuredAssets,
} = require('../config/stellar');

const PLATFORM_KEYPAIR = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);

function toStellarAsset(assetCode) {
  if (assetCode === 'XLM') return Asset.native();
  if (assetCode === 'USDC') return USDC;
  if (configuredAssets[assetCode]?.issuer) {
    return new Asset(assetCode, configuredAssets[assetCode].issuer);
  }
  throw new Error(`Unsupported asset: ${assetCode}`);
}

function getSupportedAssetCodes() {
  return Object.keys(configuredAssets);
}

function normalizeAsset(record) {
  if (!record) return null;
  if (record.asset_type === 'native') return 'XLM';
  return record.asset_code;
}

/**
 * Create a new Stellar account for a campaign.
 * The platform funds the minimum reserve (1 XLM on testnet).
 * Both the creator's key and the platform key are added as signers.
 * Medium threshold is set to 2 — both must sign to move funds.
 */
async function createCampaignWallet(creatorPublicKey) {
  const campaignKeypair = Keypair.random();
  const platformAccount = await server.loadAccount(PLATFORM_KEYPAIR.publicKey());

  const tx = new TransactionBuilder(platformAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    // Fund the new campaign account with minimum reserve
    .addOperation(
      Operation.createAccount({
        destination: campaignKeypair.publicKey(),
        startingBalance: '2', // covers base reserve + trustline reserve
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(PLATFORM_KEYPAIR);
  await server.submitTransaction(tx);

  // Now configure the campaign account: trustline + multisig
  const campaignAccount = await server.loadAccount(campaignKeypair.publicKey());

  const setupTx = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    // Trustline for USDC
    .addOperation(
      Operation.changeTrust({ asset: USDC })
    )
    // Add creator as signer (weight 1)
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: creatorPublicKey, weight: 1 },
      })
    )
    // Add platform as signer (weight 1)
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: PLATFORM_KEYPAIR.publicKey(), weight: 1 },
      })
    )
    // Set thresholds: medium ops (payments) require weight 2 (both signers)
    .addOperation(
      Operation.setOptions({
        masterWeight: 0,     // disable the campaign keypair itself
        lowThreshold: 1,
        medThreshold: 2,
        highThreshold: 2,
      })
    )
    .setTimeout(30)
    .build();

  setupTx.sign(campaignKeypair);
  await server.submitTransaction(setupTx);

  return {
    publicKey: campaignKeypair.publicKey(),
    // In production: encrypt and store secret, never return it
    secret: campaignKeypair.secret(),
  };
}

/**
 * Submit a simple payment contribution (XLM or USDC direct).
 * For custodial users the backend signs on their behalf.
 */
async function submitPayment({ senderSecret, destinationPublicKey, asset, amount, memo }) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());

  const stellarAsset = toStellarAsset(asset);

  const tx = new TransactionBuilder(senderAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: String(amount),
      })
    )
    .addMemo(Memo.text(memo || 'crowdpay'))
    .setTimeout(30)
    .build();

  tx.sign(senderKeypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Submit a path payment contribution.
 * The contributor sends any asset; the campaign receives exactly `destAmount` USDC.
 * Stellar's DEX finds the conversion path automatically.
 */
async function submitPathPayment({
  senderSecret,
  destinationPublicKey,
  sendAsset,
  sendMax,
  destAmount,
  memo,
}) {
  const senderKeypair = Keypair.fromSecret(senderSecret);
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());

  const sourceStellarAsset = toStellarAsset(sendAsset);

  const tx = new TransactionBuilder(senderAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: sourceStellarAsset,
        sendMax: String(sendMax),
        destination: destinationPublicKey,
        destAsset: USDC,
        destAmount: String(destAmount),
        path: [], // empty path lets Stellar use direct market routing
      })
    )
    .addMemo(Memo.text(memo || 'crowdpay'))
    .setTimeout(30)
    .build();

  tx.sign(senderKeypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Get a path payment quote for strict-receive contribution flow.
 * Returns candidate conversion paths from Stellar DEX.
 */
async function getPathPaymentQuote({ sendAsset, destAsset, destAmount }) {
  const sourceStellarAsset = toStellarAsset(sendAsset);
  const destinationStellarAsset = toStellarAsset(destAsset);

  const response = await server
    .strictReceivePaths(sourceStellarAsset, destinationStellarAsset, String(destAmount))
    .call();

  return (response.records || []).map((record) => ({
    source_asset: normalizeAsset({
      asset_type: record.source_asset_type,
      asset_code: record.source_asset_code,
    }),
    destination_asset: normalizeAsset({
      asset_type: record.destination_asset_type,
      asset_code: record.destination_asset_code,
    }),
    destination_amount: record.destination_amount,
    source_amount: record.source_amount,
    path: (record.path || []).map((pathAsset) => normalizeAsset(pathAsset)),
  }));
}

/**
 * Build a withdrawal transaction for a campaign wallet.
 * Returns the unsigned XDR — both the creator and platform must sign it.
 */
async function buildWithdrawalTransaction({
  campaignWalletPublicKey,
  destinationPublicKey,
  amount,
  asset,
}) {
  const campaignAccount = await server.loadAccount(campaignWalletPublicKey);
  const stellarAsset = toStellarAsset(asset);

  const tx = new TransactionBuilder(campaignAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: stellarAsset,
        amount: String(amount),
      })
    )
    .setTimeout(300) // 5 minutes for both parties to sign
    .build();

  return tx.toXDR();
}

async function getAccountMultisigConfig(publicKey) {
  const account = await server.loadAccount(publicKey);
  return {
    thresholds: account.thresholds,
    signers: account.signers || [],
  };
}

function signTransactionXdr({ xdr, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

function signatureCountFromXdr(xdr) {
  const tx = new Transaction(xdr, networkPassphrase);
  return tx.signatures.length;
}

async function submitSignedWithdrawal({ xdr }) {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Get the current balance of a campaign wallet.
 */
async function getCampaignBalance(publicKey) {
  const account = await server.loadAccount(publicKey);
  const balances = {};
  for (const b of account.balances) {
    const key = b.asset_type === 'native' ? 'XLM' : b.asset_code;
    balances[key] = b.balance;
  }
  return balances;
}

/**
 * Fund a new account on testnet using Friendbot.
 */
async function friendbotFund(publicKey) {
  if (!isTestnet) throw new Error('Friendbot only available on testnet');
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
  );
  return response.json();
}

module.exports = {
  createCampaignWallet,
  toStellarAsset,
  getSupportedAssetCodes,
  submitPayment,
  submitPathPayment,
  getPathPaymentQuote,
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  getCampaignBalance,
  friendbotFund,
  PLATFORM_PUBLIC_KEY: PLATFORM_KEYPAIR.publicKey(),
};
