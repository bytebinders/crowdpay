const network = import.meta.env.VITE_STELLAR_NETWORK || 'testnet';

export function stellarExpertTxUrl(hash) {
  if (!hash) return '#';
  return `https://stellar.expert/explorer/${network}/tx/${hash}`;
}
