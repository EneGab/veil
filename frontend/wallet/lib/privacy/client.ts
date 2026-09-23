'use client'

import { Keypair } from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'

export type PrivacyStatus = 'idle' | 'syncing' | 'ready' | 'error'

export interface PrivacyProgressEvent {
  flow: string
  stage: string
  message: string
  current?: number
  total?: number
}

export interface PrivacyClient {
  sync: () => Promise<void>
  privateBalance: () => Promise<bigint>
  shield: (amount: bigint | number | string) => Promise<string>
  privateSend: (recipient: string, amount: bigint | number | string) => Promise<string>
  unshield: (amount: bigint | number | string, recipient?: string) => Promise<string>
  stop: () => void
}

const DEFAULT_BOOTNODE_URL = 'https://bootnode.dev-nethermind.xyz'
const DEFAULT_POOL = process.env.NEXT_PUBLIC_SPP_XLM_POOL?.trim() || ''

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  return BigInt(value)
}

function getWalletAddress(): string {
  return walletSession.getItem('invisible_wallet_address') || walletLocal.getItem('invisible_wallet_address') || ''
}

function getFeePayerSecret(): string | null {
  return walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret') || null
}

function getSigner(): { getPublicKey: () => Promise<string>; signMessage: (message: string | Uint8Array) => Promise<Uint8Array>; signTransaction: (xdr: string) => Promise<string>; signAuthEntry: (entry: string) => Promise<string> } {
  const secret = getFeePayerSecret()
  if (!secret) {
    throw new Error('No spending account is available for privacy operations. Fund your fee-payer first.')
  }

  const keypair = Keypair.fromSecret(secret)

  return {
    async getPublicKey() {
      return keypair.publicKey()
    },
    async signMessage(message) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
      const signed = keypair.sign(bytes as any) as Uint8Array
      return new Uint8Array(signed.slice())
    },
    async signTransaction(xdr) {
      return xdr
    },
    async signAuthEntry(entry) {
      return entry
    },
  }
}

function getContractConfig(): any {
  const network = getNetwork()
  return {
    network: network.networkPassphrase,
    deployer: 'veileff',
    admin: 'veil-admin',
    asp_membership: 'veillocal',
    asp_non_membership: 'veillocal',
    verifiers: {},
    public_key_registry: 'C0000000000000000000000000000000000000000000000000000000000000000',
    pools: DEFAULT_POOL
      ? [{
          poolContractId: DEFAULT_POOL,
          tokenContractId: 'CCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          deploymentLedger: 0,
          enabled: true,
          asset: { kind: 'native' as const, code: 'XLM', symbol: 'XLM' },
        }]
      : [],
  }
}

let clientPromise: Promise<PrivacyClient> | null = null

async function initClient(): Promise<PrivacyClient> {
  if (typeof window === 'undefined') {
    throw new Error('Privacy is only available in the browser.')
  }

  if (!DEFAULT_POOL) {
    throw new Error('SPP pool is not configured for this network yet.')
  }

  const module = await import('stellar-private-payments')
  const storage = await module.Storage.open()
  const network = getNetwork()
  const client = await module.Client.new({
    rpcUrl: network.rpcUrl,
    storage,
    contractConfig: getContractConfig(),
    circuitsBaseUrl: new URL('../../node_modules/stellar-private-payments/dist/circuits/', import.meta.url).href,
    bootnodeUrl: DEFAULT_BOOTNODE_URL,
  })

  const signer = getSigner()
  const account = await client.account({ networkPassphrase: network.networkPassphrase, userAddress: getWalletAddress() }, signer as any)

  const pool = await account.pool({ poolContract: DEFAULT_POOL })

  return {
    async sync() {
      await client.sync()
    },
    async privateBalance() {
      return BigInt((await pool.balance()) ?? 0)
    },
    async shield(amount) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Shield amount must be greater than zero.')
      return String(await pool.deposit(value))
    },
    async privateSend(recipient, amount) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Private send amount must be greater than zero.')
      return String(await pool.transfer(recipient, value))
    },
    async unshield(amount, recipient) {
      const value = toBigInt(amount)
      if (value <= 0n) throw new Error('Unshield amount must be greater than zero.')
      return String(await pool.withdraw(value, recipient ?? undefined))
    },
    stop() {
      client.stopBackgroundSync()
    },
  }
}

export async function getPrivacyClient(): Promise<PrivacyClient> {
  clientPromise ??= initClient()
  return clientPromise
}

export function toUserFacingPrivacyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message.replace(/^Error:\s*/, '').trim()
  if (!cleaned) return 'Privacy operation failed. Please try again.'

  if (cleaned.includes('SPP pool is not configured')) return 'Privacy is not enabled on this network yet.'
  if (cleaned.includes('No spending account is available')) return 'Your spending account is not ready yet. Fund it and try again.'
  if (cleaned.includes('RPC')) return 'Privacy could not reach the network. Please try again in a moment.'

  return cleaned
}

export function attachPrivacyProgress(handler: (event: PrivacyProgressEvent) => void) {
  const eventName = 'stellar-private-payments:tx-progress'
  const listener = ((event: Event) => {
    const detail = (event as CustomEvent<PrivacyProgressEvent>).detail
    if (detail) handler(detail)
  }) as EventListener

  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}
