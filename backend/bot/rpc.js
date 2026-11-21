// bot/rpc.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTPS JSON-RPC with automatic failover across a priority list of nodes
// (cfg.RPC_HTTP_LIST — Base: mainnet.base.org → publicnode → BASE_RPC_URL backup).
//
//   • Every request goes to the highest-priority node that isn't cooling down.
//   • A node is skipped for RPC_COOLDOWN_MS after a network error, timeout,
//     HTTP error (429 / 5xx) or a rate-limit / quota error in the JSON body —
//     the Alchemy "Monthly capacity limit exceeded" case.
//   • If every node is cooling down, they are all tried anyway (in order).
//   • JSON-RPC errors that are real answers (e.g. "execution reverted") are NOT
//     failed over — another node would say the same.
//   • eth_sendRawTransaction: if a node failed mid-send (it may have broadcast
//     anyway) and the next node answers "already known" / "nonce too low", the tx
//     IS on the network → return its hash so tx.wait() follows it, instead of the
//     engine believing the swap failed.
//
// It is a normal ethers JsonRpcProvider (only _send is overridden), so wallets,
// contracts, tx.wait() and provider.send() work unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const { ethers } = require('ethers');
const cfg = require('./config');

const RATE_LIMIT_RE = /rate.?limit|too many requests|capacity limit|quota/i;
const RATE_LIMIT_CODES = new Set([429, -32005, -32090]);
const DUP_TX_RE = /already known|known transaction|already imported|nonce too low/i;

// host only — never print API keys that live in the URL path
const label = (url) => { try { return new URL(url).host; } catch { return 'rpc'; } };

function isRateLimited(item) {
  const e = item && item.error;
  return !!e && (RATE_LIMIT_CODES.has(e.code) || RATE_LIMIT_RE.test(e.message || ''));
}

class FailoverProvider extends ethers.JsonRpcProvider {
  constructor(urls, { log = console.log } = {}) {
    if (!urls || !urls.length) throw new Error('No RPC URL configured');
    super(urls[0], cfg.CHAIN_ID, { staticNetwork: true });
    this.nodes = urls.map((url) => {
      const req = new ethers.FetchRequest(url);
      req.timeout = cfg.RPC_TIMEOUT_MS;
      req.setThrottleParams({ maxAttempts: 1 }); // no built-in 429 retry loop — fail over instead
      return { url, name: label(url), req, downUntil: 0 };
    });
    this.active = this.nodes[0].name;
    this._log = log;
  }

  _order() {
    const now = Date.now();
    const up = this.nodes.filter((n) => n.downUntil <= now);
    return up.length ? up.concat(this.nodes.filter((n) => n.downUntil > now)) : this.nodes;
  }

  _markDown(node, why) {
    node.downUntil = Date.now() + cfg.RPC_COOLDOWN_MS;
    this._log(`⚠️ [rpc] ${node.name} failed (${String(why).slice(0, 120)}) — skipping it for ${Math.round(cfg.RPC_COOLDOWN_MS / 1000)}s`);
  }

  async _send(payload) {
    const items = Array.isArray(payload) ? payload : [payload];
    const isSend = items.length === 1 && items[0].method === 'eth_sendRawTransaction';
    let lastErr = null;
    let sendFailed = false; // a previous node errored during eth_sendRawTransaction

    for (const node of this._order()) {
      try {
        const req = node.req.clone();
        req.body = JSON.stringify(payload);
        req.setHeader('content-type', 'application/json');
        const res = await req.send();
        res.assertOk();
        let out = res.bodyJson;
        if (!Array.isArray(out)) out = [out];
        if (out.some(isRateLimited)) throw new Error((out.find(isRateLimited).error || {}).message || 'rate limited');

        if (isSend && sendFailed && out[0] && out[0].error && DUP_TX_RE.test(out[0].error.message || '')) {
          const hash = ethers.keccak256(items[0].params[0]);
          this._log(`ℹ️ [rpc] ${node.name}: tx already on the network (${out[0].error.message}) — following ${hash}`);
          out = [{ jsonrpc: '2.0', id: items[0].id, result: hash }];
        }
        if (this.active !== node.name) {
          this._log(`🔀 [rpc] now using ${node.name}`);
          this.active = node.name;
        }
        return out;
      } catch (e) {
        lastErr = e;
        if (isSend) sendFailed = true;
        this._markDown(node, e.shortMessage || e.message || e);
      }
    }
    throw lastErr;
  }
}

// one shared instance per process (feed + dex share the same failover state)
let shared = null;
function provider(opts) {
  if (!shared) shared = new FailoverProvider(cfg.RPC_HTTP_LIST, opts);
  return shared;
}

module.exports = { FailoverProvider, provider, label };
