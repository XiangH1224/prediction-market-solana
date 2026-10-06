import bs58 from 'bs58'

// Wallet extensions inject into web pages, not into this extension's side panel, so
// wallet calls run inside a tab on the orchestrator's own origin.
const BRIDGE_URL = 'http://localhost:8000/wallet'

type BridgeRequest = { op: 'connect' } | { op: 'send'; address: string; txBase64: string }
type BridgeResponse = { address?: string; wallet?: string; signature?: number[]; error?: string }

/**
 * Runs in the bridge tab's page context, so it must not reference anything outside
 * its own body. Finds a wallet through the Wallet Standard and has it connect, or
 * sign and send the given serialized transaction unchanged.
 */
async function pageCall(req: BridgeRequest): Promise<BridgeResponse> {
  const found: any[] = []
  const api = {
    register: (...wallets: any[]) => {
      found.push(...wallets)
      return () => {}
    },
  }
  window.addEventListener('wallet-standard:register-wallet', (e: any) => e.detail(api))
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }))

  const usable = () =>
    found.filter(
      (w) =>
        w.features?.['standard:connect'] &&
        w.features?.['solana:signAndSendTransaction'] &&
        w.chains?.includes('solana:mainnet'),
    )
  for (let i = 0; i < 20 && usable().length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const wallet = usable()[0]
  if (!wallet) return { error: 'No Solana wallet extension found' }

  try {
    const { accounts } = await wallet.features['standard:connect'].connect()
    if (req.op === 'connect') {
      if (!accounts.length) return { error: 'Wallet returned no accounts' }
      return { address: accounts[0].address, wallet: wallet.name }
    }
    const account = accounts.find((a: any) => a.address === req.address)
    if (!account) return { error: 'The connected wallet account changed; reconnect the wallet' }
    const transaction = Uint8Array.from(atob(req.txBase64), (c) => c.charCodeAt(0))
    const [output] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
      account,
      transaction,
      chain: 'solana:mainnet',
    })
    return { signature: Array.from(output.signature as Uint8Array) }
  } catch (e: any) {
    return { error: String(e?.message ?? e) }
  }
}

function loaded(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function bridgeTab(): Promise<number> {
  const [existing] = await chrome.tabs.query({ url: `${BRIDGE_URL}*` })
  if (existing?.id !== undefined) return existing.id
  const tab = await chrome.tabs.create({ url: BRIDGE_URL, active: false, pinned: true })
  await loaded(tab.id!)
  return tab.id!
}

async function call(req: BridgeRequest): Promise<BridgeResponse> {
  if (typeof chrome === 'undefined' || !chrome.scripting) {
    throw new Error('Wallet connection needs the Chrome extension; this page view supports simulated trades only.')
  }
  const tabId = await bridgeTab()
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: pageCall,
    args: [req],
  })
  const result = injection?.result as BridgeResponse | undefined
  if (!result) throw new Error('Wallet bridge did not respond; is the orchestrator running?')
  if (result.error) throw new Error(result.error)
  return result
}

export async function connectWallet(): Promise<{ address: string; wallet: string }> {
  const { address, wallet } = await call({ op: 'connect' })
  return { address: address!, wallet: wallet! }
}

/** Sign and broadcast a server-staged transaction. Returns the base58 signature. */
export async function signAndSend(address: string, txBase64: string): Promise<string> {
  const { signature } = await call({ op: 'send', address, txBase64 })
  return bs58.encode(Uint8Array.from(signature!))
}
