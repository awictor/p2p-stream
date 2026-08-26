// Metrics collector + live dashboard.
// Viewers POST cumulative {httpBytes, p2pBytes, uploadBytes} keyed by a random
// clientId every few seconds. We aggregate across the swarm and compute the
// offload ratio = p2pBytes / (httpBytes + p2pBytes). Dashboard at GET /.
import express from "express";
import path from "path";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import { verifyReport, verifyCert, verifyReceipt } from "./identity.js";
import { earnedEntitlement, DEFAULT_BYTES_PER_AD_FREE_SECOND } from "./entitlement.js";
import { installShutdown } from "./shutdown.js";
import { rateLimit, pruneBuckets } from "./ratelimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-PROCESS salt for the client-host hash below. Regenerated every boot on purpose: the IPv4
// space is small enough to enumerate, so an unsalted hash of an address is not an anonymisation,
// it is an encoding. A fresh salt also means two runs' hashes cannot be correlated.
const HOST_SALT = randomBytes(16);

// A viewer's network origin, reduced to something the dashboard can publish. `/stats` is served to
// every viewer, so putting raw peer IPs there would leak each viewer's address to all the others —
// exactly the kind of thing a P2P product must not do casually. What callers actually need is only
// "are these two reports from the SAME host or different ones", and a hash answers that.
export function hostFingerprint(ip, salt = HOST_SALT) {
  if (typeof ip !== "string" || !ip) return null;
  // Express hands back IPv4-mapped IPv6 for a v4 client ("::ffff:127.0.0.1"). Normalise, or the
  // same machine reaching us over both stacks looks like two hosts and fakes a cross-network run.
  const addr = ip.replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = addr === "::1" || addr === "127.0.0.1" || /^127\./.test(addr);
  return { host: createHash("sha256").update(salt).update(addr).digest("hex").slice(0, 12), loopback };
}

// Structured request-log line (P2P-0090). Pure: exactly {method,path,status,ms,requestId} as a
// single JSON string, no trailing newline (the caller adds it). Exported so a test pins the shape
// without booting a server. Kept to these five fields on purpose — a log line is a contract; extra
// fields drift and downstream parsers break.
export function buildLogLine({ method, path, status, ms, requestId }) {
  return JSON.stringify({ method, path, status, ms, requestId });
}

// `now` is injectable purely so tests can drive the stale/evict windows deterministically
// instead of sleeping for real seconds. Production always uses Date.now.
// `graceful` wires SIGTERM/SIGINT drain (P2P-0091). Off by default so a test that boots many servers
// in one process does not register competing signal handlers; the CLI entrypoint opts in.
export function startMetrics(port, { now = () => Date.now(), graceful = false } = {}) {
  const app = express();
  // Bound the request body. /metrics is PUBLIC and UNAUTHENTICATED; a real report (even with the
  // MAX_ATTEST_KEYS-capped attest map) is a few KB, so express.json's 100KB default is ~100x too
  // generous and is free memory/bandwidth an attacker can spend. 16KB is comfortable headroom.
  const BODY_LIMIT = process.env.METRICS_BODY_LIMIT || "16kb";
  app.use(express.json({ limit: BODY_LIMIT }));
  // Viewers live on a different origin (static web host); allow the POST.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // STRUCTURED REQUEST LOG (P2P-0090). One line of JSON per request so an ops team can correlate by
  // request-id and read status/latency from a log pipeline, not prose. OFF by default (LOG_LEVEL
  // unset/"off") so tests + CI stay silent; LOG_LEVEL="info" emits. Captured at entry (t0 + id), the
  // line is emitted on res "finish" — the point where statusCode and full duration are final. The
  // formatter is pure + exported so its shape is unit-testable without booting a server.
  const LOG_ON = /^(info|debug|trace)$/i.test(process.env.LOG_LEVEL || "");
  app.use((req, res, next) => {
    if (!LOG_ON) return next();
    const t0 = performance.now();
    const requestId = randomBytes(8).toString("hex");
    res.on("finish", () => {
      process.stdout.write(buildLogLine({
        method: req.method, path: req.path, status: res.statusCode,
        ms: +(performance.now() - t0).toFixed(2), requestId,
      }) + "\n");
    });
    next();
  });
  // QUIET body-parser errors. A malformed JSON body or an over-limit payload otherwise dumps a full
  // stack trace to stderr on every hit — that both leaks internal file paths and is a log-flood
  // vector on an unauthenticated endpoint (an attacker POSTs garbage in a loop). Answer with the
  // right status and ONE terse line, no trace. `err.type` is set by body-parser
  // ("entity.parse.failed" / "entity.too.large"); `err.status` carries 400/413.
  app.use((err, req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large" || err.status === 400 || err.status === 413)) {
      const code = err.status || 400;
      console.warn(`[metrics] rejected ${req.method} ${req.url}: ${err.type || "bad request"} (${code})`);
      return res.status(code).json({ error: err.type || "bad request" });
    }
    return next(err);
  });

  // clientId -> latest cumulative counters + lastSeen (ms epoch, stamped SERVER-SIDE).
  const clients = new Map();
  const STALE_MS = 15000; // drop a viewer from the ACTIVE count if silent this long
  // Long-gone viewers are evicted from the Map so it cannot grow without bound on a
  // long-running dashboard. EVICT_MS is deliberately much larger than STALE_MS: a
  // viewer that goes quiet briefly should stop counting as active but keep its entry,
  // so a later report updates in place instead of double-counting.
  const EVICT_MS = STALE_MS * 20; // 5 minutes

  // HARD ceilings on client-controlled state. POST /metrics is public and unauthenticated (viewers
  // report from a different origin), and until iter 75 the ONLY bound on resident state was time
  // (EVICT_MS). A flood of unique clientIds inside one window grew `clients` without limit — a
  // memory-exhaustion DoS on the one server a real audience depends on. These are COUNT bounds, so
  // a burst is capped regardless of how fast it arrives.
  //   THREAT NOTE: this bounds MEMORY. It does NOT authenticate a peer or stop a determined
  //   attacker from churning the Map (evicting honest viewers by flooding fake ones) — that needs
  //   authenticated identity at the tracker, which is out of scope and tracked in roadmap.md.
  // A misconfigured limit is a SILENT footgun, not a crash: `Number("5oo")` is NaN, and
  // `clients.size > NaN` is always false, so a typo'd MAX_CLIENTS disables the ceiling entirely and
  // the DoS this bound exists to stop comes back with no signal. `0` or a negative is the opposite
  // failure — it evicts every client and /stats is permanently empty. So a limit env is only
  // honoured when it parses to a positive integer; anything else falls back to the default and warns.
  function posIntEnv(name, dflt) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      console.warn(`[metrics] ignoring ${name}=${JSON.stringify(raw)} (not a positive integer); using ${dflt}`);
      return dflt;
    }
    return n;
  }
  const MAX_CLIENTS = posIntEnv("MAX_CLIENTS", 5000);
  const MAX_ATTEST_KEYS = posIntEnv("MAX_ATTEST_KEYS", 256);
  const MAX_CLIENTID_LEN = posIntEnv("MAX_CLIENTID_LEN", 128);
  // Per-IP rate limit on the PUBLIC /metrics POST (P2P-0093). A viewer posts every few seconds, so a
  // capacity of 30 with 1/sec refill is generous headroom for honest clients while a flooding IP is
  // capped. RATE_CAPACITY<=0 disables limiting (documented opt-out). Buckets keyed by hostFingerprint
  // hash (never a raw address), pruned so a spray of distinct keys can't grow the store unboundedly.
  const RATE_CAPACITY = Number(process.env.RATE_CAPACITY ?? 30);
  const RATE_REFILL_PER_SEC = Number(process.env.RATE_REFILL_PER_SEC ?? 1);
  const rateBuckets = {};
  let lastRatePrune = 0;
  // Per-report byte ceiling. A cumulative counter for one viewer over one session cannot plausibly
  // exceed this; default 1TB is orders of magnitude above any real live session yet finite. It
  // exists because `Number(x) || 0` (the old coercion) let NEGATIVES and absurd magnitudes through
  // — `|| 0` only catches NaN. PROVEN: one POST of p2pBytes:-1e12 drove offloadRatio to
  // 1.0000000001 (a ratio cannot exceed 1) and folded a negative into `retired` PERMANENTLY.
  //   THREAT NOTE: this bounds the VALUE RANGE of a reported counter. It does NOT authenticate the
  //   reporter — an honest-looking peer can still lie WITHIN range. It stops the published number
  //   (offloadRatio) from being driven impossible/negative by a single malformed report.
  // Same footgun as the count limits, one field over: a typo'd MAX_REPORT_BYTES -> NaN, and
  // `n > NaN` is false in sanitizeBytes, so the byte clamp silently disappears and the P2P-0063
  // poison (offloadRatio > 1) returns. Byte ceilings can be non-integer, so validate finite-positive
  // rather than integer, but fall back + warn on garbage exactly the same way.
  const MAX_REPORT_BYTES = (() => {
    const raw = process.env.MAX_REPORT_BYTES;
    if (raw === undefined || raw === "") return 1e12;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.warn(`[metrics] ignoring MAX_REPORT_BYTES=${JSON.stringify(raw)} (not a positive number); using 1e12`);
      return 1e12;
    }
    return n;
  })();

  // The tracker's PUBLIC key (base64 spki ed25519), from the env. When set, an attestation earns
  // CERTIFIED credit only if its pubKey carries a `cert` that verifies as the tracker's signature
  // over that pubKey (P2P-0070) — i.e. the tracker issued the identity, it is not self-minted. When
  // UNSET (default dev/loopback), no key can be certified and certifiedAttestedBytes stays 0; that
  // is the honest state, not a silent pass. The tracker never shares its PRIVATE key with metrics.
  const TRACKER_PUBKEY = process.env.TRACKER_PUBKEY || null;

  // Coerce a client-supplied byte field to a finite value in [0, MAX_REPORT_BYTES]. Anything
  // non-numeric, NaN, Infinity, negative, or absurdly large collapses to a safe number rather than
  // poisoning a cumulative total. Clamp (not reject) so an honest report that merely overshoots the
  // ceiling still counts its bytes up to the bound instead of vanishing.
  function sanitizeBytes(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > MAX_REPORT_BYTES ? MAX_REPORT_BYTES : n;
  }

  // Fold a departing client's cumulative bytes into `retired` so session totals stay MONOTONIC —
  // reports are cumulative snapshots, so simply dropping an entry would subtract bytes that really
  // were served and make offloadRatio jump backwards. Used by BOTH the time-based eviction in
  // aggregate() and the count-based ceiling below, so the two can never disagree about accounting.
  function retire(c) {
    retired.httpBytes += c.httpBytes;
    retired.p2pBytes += c.p2pBytes;
    retired.uploadBytes += c.uploadBytes;
    retired.count += 1;
  }

  // K-of-N attestation filter (see the aggregation below). Overridable so a deployment can tighten
  // it and so tests can pin behaviour at both sides of the boundary.
  // MIN_ATTESTERS=2 is the weakest useful setting: it kills a lone forged voucher while still
  // crediting an honest pair. MAX_VOUCH_PER_ATTESTER caps how much ONE receiver can be worth, which
  // is what makes a bigger ring cost more rather than nothing.
  const MIN_ATTESTERS = Number(process.env.MIN_ATTESTERS || 2);
  const MAX_VOUCH_PER_ATTESTER = Number(process.env.MAX_VOUCH_PER_ATTESTER || 20e6); // 20MB

  // Evicted clients' counters are FOLDED IN HERE rather than discarded. Reports are
  // cumulative snapshots, so deleting an entry would subtract bytes that really were
  // served and make offloadRatio jump backwards — which would also break the sweep's
  // delta arithmetic and contradict the published numbers. Session totals stay
  // monotonic; only the per-client bookkeeping is reclaimed.
  const retired = { httpBytes: 0, p2pBytes: 0, uploadBytes: 0, count: 0, attestedUploadBytes: 0, signedAttestedBytes: 0, certifiedAttestedBytes: 0, receiptedBytes: 0 };
  const MAX_RECEIPTS = posIntEnv("MAX_RECEIPTS", 256); // cap receipts per report, like MAX_ATTEST_KEYS
  // Ad-free entitlement policy (P2P-0075): bytes a relayer must serve per one ad-free second.
  // Entitlement is computed ONLY from receiptedBytes (the collusion-resistant tier), so it reports
  // what a viewer is OWED, never what is PAID — the payout rail is out of scope. Env-overridable +
  // documented; a garbage value falls back to the default inside earnedEntitlement.
  const AD_FREE_BYTES_PER_SECOND = Number(process.env.AD_FREE_BYTES_PER_SECOND) || DEFAULT_BYTES_PER_AD_FREE_SECOND;

  // RECEIVER-ATTESTED UPLOAD. `uploadBytes` above is what a viewer claims about ITSELF, which a
  // modified client forges in one line — so the ad-free-for-relay tier cannot pay out on it.
  // Instead, every viewer reports what its PEERS served IT (peerId -> bytes, learned from
  // onSegmentLoaded), and we credit the server from those third-party reports.
  //
  // ⚠ THREAT MODEL. This defeats SOLO forgery: a peer inflating its own uploadBytes gains no
  // attested credit, because credit only arrives from other viewers. It does NOT defeat
  // COLLUSION — one browser can open N tabs that attest for each other, and peer identity here
  // is a self-chosen engine id with no proof of work or possession behind it. Closing that needs
  // authenticated peer identity at the tracker, which is out of scope. Attested totals are a
  // CROSS-CHECK, not an authorisation to pay.
  //
  // Keyed by the ATTESTING client so reports stay idempotent: each viewer's latest snapshot
  // replaces its previous one, exactly like the byte counters. Summing raw POSTs instead would
  // multiply every credit by the report interval.
  const attestations = new Map();  // attestingClientId -> { byPeer: {peerId: bytes}, lastSeen }
  // peerId -> { clientId, lastSeen }, so an attested credit can be attributed to a tracked
  // viewer. Viewers announce their own engine peerId; without this the server sees two unrelated
  // namespaces. `lastSeen` exists because this Map MUST be evictable: peerIds are minted fresh
  // per page load, so a busy dashboard would otherwise accumulate one entry per viewer forever
  // (measured: 200 viewers evicted from `clients`, all 200 mappings retained). Keeping stale
  // mappings is also a correctness bug, not only a leak — credit for a long-departed peerId was
  // still being attributed to its evicted client.
  const peerToClient = new Map();

  // PROOF-OF-DELIVERY receipts (P2P-0073). clientId -> { receipts: {segmentId: {bytes, verified}},
  // lastSeen }. A receipt only counts toward receiptedBytes when it verifies under the report's
  // pubKey AND that pubKey is CERTIFIED — the same trust floor as certifiedAttestedBytes, one step
  // stronger because it is per-segment corroborated, not a bulk attest. Latest report per clientId
  // replaces the prior (idempotent), evicted into `retired` on the same clock as attestations.
  const receiptsByClient = new Map();

  app.post("/metrics", (req, res) => {
    // PER-IP RATE LIMIT (P2P-0093), checked FIRST so a flood is rejected before any body work,
    // verify, or Map mutation. Keyed by the hashed host fingerprint, never a raw address. A denied
    // request answers 429 and touches nothing. THREAT: bounds one IP's wall-clock rate; does NOT
    // authenticate the peer nor stop a many-IP distributed flood (roadmap).
    const rlNow = now();
    const rlKey = hostFingerprint(req.socket?.remoteAddress || req.ip || "")?.host || "unknown";
    if (rlNow - lastRatePrune > 60000) { pruneBuckets(rateBuckets, rlNow, 600000); lastRatePrune = rlNow; }
    const rl = rateLimit(rateBuckets, rlKey, rlNow, { capacity: RATE_CAPACITY, refillPerSec: RATE_REFILL_PER_SEC });
    if (!rl.allowed) return res.status(429).json({ error: "rate limit exceeded" });
    const { clientId: rawClientId, httpBytes = 0, p2pBytes = 0, uploadBytes = 0, ts, peerId, attest, pubKey, sig, cert, receipts } = req.body || {};
    if (!rawClientId || typeof rawClientId !== "string") return res.status(400).json({ error: "clientId required" });
    // Clamp the clientId LENGTH before it is used as a Map key. An unbounded string is both a
    // memory vector and a way to bloat every /stats response that echoes per-client data.
    const clientId = rawClientId.slice(0, MAX_CLIENTID_LEN);
    // Self-declared mapping. Fine for a cross-check — a peer that lies here mis-credits itself,
    // and cannot mint bytes that no receiver reported.
    if (typeof peerId === "string" && peerId) peerToClient.set(peerId, { clientId, lastSeen: now() });
    if (attest && typeof attest === "object") {
      const byPeer = {};
      let kept = 0;
      for (const [pid, bytes] of Object.entries(attest)) {
        // CAP the number of attested peers per report. One POST could otherwise carry thousands of
        // peerId keys and inflate `attestations` without limit. Take the first MAX_ATTEST_KEYS
        // valid entries; a viewer relaying to more peers than that in one interval is not real.
        if (kept >= MAX_ATTEST_KEYS) break;
        // Same range clamp as the self-reported counters: an attested credit is a byte figure too,
        // so a negative or absurd value here would poison attestedUploadBytes exactly as it poisons
        // p2pBytes. sanitizeBytes returns 0 for junk; skip zero so a bogus key adds no phantom peer.
        const n = sanitizeBytes(bytes);
        if (typeof pid === "string" && pid && n > 0) { byPeer[pid] = n; kept += 1; }
      }
      // AUTHENTICATE THE CREDIT (P2P-0069). If the report carries a pubKey + sig that verifies over
      // the canonical {clientId, attest}, this attestation is eligible for SIGNED credit — the only
      // credit a payable reward tier may ever use. An unsigned or forge-signed report is still kept
      // and still contributes to the legacy attestedUploadBytes cross-check (backward compatible; do
      // NOT break the offload number or existing accounting), but it earns ZERO signed credit.
      //   THREAT (HARD RULE 6): this authenticates that WHOEVER HOLDS THE KEY produced this exact
      //   {clientId, attest}. It does NOT prove the key belongs to a distinct, tracker-vouched peer
      //   — a self-supplied pubKey is still self-declared, so COLLUSION (two real keys vouching for
      //   each other) is NOT closed here. Tracker-issued keys are P2P-0070. `signedAttestedBytes` is
      //   therefore a stronger cross-check than the raw total, still NOT an authorisation to pay.
      const signed = typeof pubKey === "string" && typeof sig === "string" &&
        verifyReport({ clientId, attest }, sig, pubKey);
      // CERTIFIED CREDIT (P2P-0070) — a stricter tier ON TOP of signed. The attestation is certified
      // only if it is signed AND the report carries a `cert` that verifies as the TRACKER's signature
      // over this pubKey (verifyCert), i.e. the tracker ISSUED this identity. A self-minted key has
      // no such cert, so it can be `signed` (possession) but never `certified` (distinctness). With
      // no TRACKER_PUBKEY configured, nothing is certifiable and this stays false — the honest state.
      const certified = signed && TRACKER_PUBKEY && typeof cert === "string" &&
        verifyCert(pubKey, cert, TRACKER_PUBKEY);
      attestations.set(clientId, {
        byPeer, lastSeen: now(),
        signed: signed === true,
        certified: certified === true,
        pubKey: signed ? pubKey : null,
      });
    }
    // PROOF-OF-DELIVERY (P2P-0073). Each receipt in `receipts[]` is a receiver's signature over one
    // {segmentId, bytes, senderPeerId, receiverPeerId}. It counts toward receiptedBytes ONLY when it
    // verifies under THIS report's pubKey AND that pubKey is tracker-CERTIFIED — receiptedBytes is
    // therefore a subset of the trust floor certifiedAttestedBytes sits on, but per-segment
    // corroborated rather than a bulk attest. A report may carry receipts without attest, so the
    // cert status is recomputed here rather than reused from the attest block.
    //   THREAT (HARD RULE 6): a verified receipt proves a receiver corroborated a specific transfer.
    //   It does NOT prove the bytes were USEFUL (played) — not a QoE proof — and N certified keys
    //   colluding can still mint mutually-corroborated receipts (rate/PoW at issuance still open).
    if (Array.isArray(receipts) && receipts.length) {
      const certifiedKey = typeof pubKey === "string" && typeof cert === "string" &&
        TRACKER_PUBKEY && verifyCert(pubKey, cert, TRACKER_PUBKEY);
      const kept = {};
      let n = 0;
      for (const r of receipts) {
        if (n >= MAX_RECEIPTS) break;
        // Dedup by segmentId within a report so a peer cannot list the same delivery N times.
        if (!r || typeof r !== "object" || typeof r.segmentId !== "string") continue;
        if (r.segmentId in kept) continue;
        const rSig = r.sig;
        const receiptObj = { segmentId: r.segmentId, bytes: r.bytes, senderPeerId: r.senderPeerId, receiverPeerId: r.receiverPeerId };
        // A delivery is between two DISTINCT peers. A self-receipt (sender == receiver) is the
        // receipt analog of self-attestation — a peer minting credit for "serving itself" — and is
        // rejected for the same reason the attest path drops self-attestation. Without this a
        // certified peer earns unbounded receiptedBytes from receipts to nobody. (iter 104)
        const selfReceipt = r.senderPeerId === r.receiverPeerId;
        const ok = !selfReceipt && certifiedKey && typeof rSig === "string" && verifyReceipt(receiptObj, rSig, pubKey);
        // Store the clamped byte figure; only a verified receipt gets nonzero credit.
        kept[r.segmentId] = { bytes: ok ? sanitizeBytes(r.bytes) : 0, verified: ok === true };
        n += 1;
      }
      receiptsByClient.set(clientId, { receipts: kept, lastSeen: now() });
    }
    // Recency is stamped SERVER-SIDE, not taken from the client. Trusting `ts` meant a
    // report without one got lastSeen=0, and the `c.lastSeen &&` guards below then
    // short-circuited on that falsy zero — so such a client was never stale, never
    // evicted, and counted as an active viewer forever. Server time also can't be
    // skewed by a wrong client clock or forged to keep an entry alive.
    // `ts` is still accepted and echoed as `clientTs` for debugging; nothing reads it.
    // The report's network origin, hashed (see hostFingerprint). Taken from the SOCKET, never
    // from the body: a client-supplied host would let one machine claim to be several and
    // manufacture the cross-network result `verify:remote` exists to certify.
    const fp = hostFingerprint(req.socket?.remoteAddress || req.ip || "");
    clients.set(clientId, {
      httpBytes: sanitizeBytes(httpBytes),
      p2pBytes: sanitizeBytes(p2pBytes),
      uploadBytes: sanitizeBytes(uploadBytes),
      lastSeen: now(),
      clientTs: Number(ts) || null,
      host: fp?.host || null,
      loopback: fp?.loopback ?? null,
    });
    // Enforce the COUNT ceiling right here, not only in aggregate() — a flood of POSTs with no
    // interleaved /stats read would otherwise never trigger the time-based sweep and could grow the
    // Map unbounded between reads. Updating an EXISTING clientId does not grow the Map, so this only
    // bites on genuinely new ids. Evict oldest-by-lastSeen (the closest to timing out anyway),
    // folding bytes into `retired` so totals stay monotonic exactly like time eviction.
    while (clients.size > MAX_CLIENTS) {
      let oldestId = null, oldestSeen = Infinity;
      for (const [id, c] of clients) {
        if (c.lastSeen < oldestSeen) { oldestSeen = c.lastSeen; oldestId = id; }
      }
      if (oldestId === null) break;
      retire(clients.get(oldestId));
      clients.delete(oldestId);
    }
    res.json({ ok: true });
  });

  app.get("/stats", (req, res) => res.json(aggregate()));

  // OBSERVABILITY (P2P-0089). Ops probes for a real deploy. /healthz is pure liveness — the process
  // is up and the event loop answers — so it is ALWAYS 200 (a booted app can serve it). /readyz is
  // readiness — 200 only once the HTTP listener is actually accepting (the `listening` flag flips in
  // the listen callback below), 503 before. A load balancer routes on /readyz, restarts on /healthz.
  let listening = false;
  app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));
  app.get("/readyz", (req, res) =>
    listening ? res.status(200).json({ ready: true }) : res.status(503).json({ ready: false }));

  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

  function aggregate() {
    // Staleness is measured against server time, NOT against the newest report we hold.
    // Comparing to the newest report meant a swarm that went entirely silent kept its
    // final viewers "active" forever, because nothing newer ever arrived to age them out.
    const t = now();

    // Reclaim entries far older than the stale window, folding their bytes into
    // `retired` so the totals below are unchanged by the eviction itself.
    for (const [id, c] of clients) {
      if (t - c.lastSeen > EVICT_MS) {
        retire(c);
        clients.delete(id);
      }
    }

    let http = retired.httpBytes, p2p = retired.p2pBytes, upload = retired.uploadBytes;
    let active = 0;
    // Hosts are counted over ACTIVE clients only. A host that reported an hour ago and left is
    // not evidence that this run spans two machines, and counting it would certify a
    // cross-network result from two sequential single-machine runs.
    const activeHosts = new Set();
    let loopbackClients = 0;
    for (const c of clients.values()) {
      http += c.httpBytes;
      p2p += c.p2pBytes;
      upload += c.uploadBytes;
      if (t - c.lastSeen <= STALE_MS) {
        active += 1;
        if (c.host) activeHosts.add(c.host);
        if (c.loopback) loopbackClients += 1;
      }
    }

    // Fold attestations into per-peer credit. Evict alongside the byte counters so a long run
    // cannot grow the Map without bound, keeping the retired total monotonic for the same reason.
    for (const [id, a] of attestations) {
      if (t - a.lastSeen > EVICT_MS) {
        for (const bytes of Object.values(a.byPeer)) {
          retired.attestedUploadBytes += bytes;
          if (a.signed) retired.signedAttestedBytes += bytes;
          if (a.certified) retired.certifiedAttestedBytes += bytes;
        }
        attestations.delete(id);
      }
    }
    // Evict stale receipts on the same clock, folding verified bytes into `retired` so
    // receiptedBytes stays monotonic like every other total.
    for (const [id, rc] of receiptsByClient) {
      if (t - rc.lastSeen > EVICT_MS) {
        for (const r of Object.values(rc.receipts)) if (r.verified) retired.receiptedBytes += r.bytes;
        receiptsByClient.delete(id);
      }
    }
    // Evict stale peerId mappings on the same clock. Without this the Map is unbounded AND
    // credit keeps resolving to clients that left long ago; an attacker who learns a retired
    // peerId could aim credit at a viewer that no longer exists. After eviction such a credit
    // degrades to `unmapped:` — visible and unattributed, which is the honest outcome.
    for (const [pid, m] of peerToClient) {
      if (t - m.lastSeen > EVICT_MS) peerToClient.delete(pid);
    }
    // A viewer NEVER attests for itself — self-attestation is exactly the forgery this exists to
    // detect, so it is dropped rather than counted.
    const attestedByClient = {};
    let attestedTotal = retired.attestedUploadBytes;
    // SIGNED credit: the same attested bytes, but ONLY from attestations whose report carried a
    // verifying signature (P2P-0069). This is the number a payable tier would use; the gap between
    // it and attestedTotal is exactly the unsigned/unauthenticated credit.
    let signedAttestedTotal = retired.signedAttestedBytes;
    // CERTIFIED credit: signed AND the pubKey was tracker-issued (P2P-0070). The subset of signed
    // credit that is safe against self-minted-identity collusion. This is the number a payable tier
    // may actually use once tracker issuance is live.
    let certifiedAttestedTotal = retired.certifiedAttestedBytes;
    // Proof-of-delivery total: verified receipts from certified keys, per-segment corroborated.
    let receiptedTotal = retired.receiptedBytes;
    // Per-CLIENT receipted bytes, so entitlement can be attributed to the viewer that earned it.
    // Live snapshot of currently-tracked receipts (a departed peer's bytes fold into the retired
    // TOTAL but cannot be shown an entitlement — it is gone). Only VERIFIED receipts count.
    const receiptedByClient = {};
    for (const [id, rc] of receiptsByClient) {
      let sum = 0;
      for (const r of Object.values(rc.receipts)) if (r.verified) sum += r.bytes;
      receiptedTotal += sum;
      if (sum > 0) receiptedByClient[id] = sum;
    }
    // ENTITLEMENT (P2P-0075): ad-free seconds OWED per client, from receiptedBytes ONLY — never
    // attested/signed/certified-without-receipt. Reports what is owed, not paid (no payout rail).
    const entitlementByClient = {};
    let entitlementSeconds = 0;
    for (const [id, sum] of Object.entries(receiptedByClient)) {
      const secs = earnedEntitlement({ receiptedBytes: sum, bytesPerSecond: AD_FREE_BYTES_PER_SECOND });
      if (secs > 0) { entitlementByClient[id] = secs; entitlementSeconds += secs; }
    }
    // Who vouched for whom, and how much each one vouched. Needed for the K-of-N filter below:
    // a raw sum cannot tell "20 receivers each saw 1MB" from "one receiver claims 20MB".
    const vouchers = new Map();   // creditedKey -> Map(attesterId -> bytes)
    for (const [attestingId, a] of attestations) {
      for (const [pid, bytes] of Object.entries(a.byPeer)) {
        const m = peerToClient.get(pid);
        const servedBy = m && m.clientId;
        if (servedBy && servedBy === attestingId) continue;   // self-attestation, ignored
        attestedTotal += bytes;
        if (a.signed) signedAttestedTotal += bytes;           // signed = key possession proven
        if (a.certified) certifiedAttestedTotal += bytes;     // certified = tracker-issued identity
        const key = servedBy || `unmapped:${pid}`;
        attestedByClient[key] = (attestedByClient[key] || 0) + bytes;
        if (!vouchers.has(key)) vouchers.set(key, new Map());
        const v = vouchers.get(key);
        v.set(attestingId, (v.get(attestingId) || 0) + bytes);
      }
    }

    // K-OF-N FILTER. Iter 43 demonstrated that a ring of N tabs attesting for each other produces
    // perfect mutual corroboration and sails past the forgery detector, because peerIds are free.
    // This does not fix that — nothing here can, since a 2-member ring is byte-identical to two
    // honest peers — but it METERS it: credit only counts when at least K DISTINCT attesters vouch,
    // and no single attester can contribute more than CAP of one peer's credit.
    //
    // The cap is the half that matters. A bare "≥K distinct attesters" rule is defeated for FREE by
    // enlarging the ring: every member of a K+1 ring already has K attesters. Capping per-attester
    // vouching means each fake identity must carry real traffic to be worth anything, so the
    // attacker's cost scales with the credit claimed instead of being flat.
    //
    // ⚠ STILL NOT AN AUTHORISATION TO PAY. It raises the price of forgery; it does not make the
    // number trustworthy. Only authenticated peer identity does that, and this MVP has none.
    const attestedFilteredByClient = {};
    let attestedFilteredTotal = 0;
    for (const [key, v] of vouchers) {
      if (v.size < MIN_ATTESTERS) continue;                   // too few independent witnesses
      // Cap each voucher's contribution, then sum. Sorting is unnecessary — the cap is per-attester.
      let sum = 0;
      for (const bytes of v.values()) sum += Math.min(bytes, MAX_VOUCH_PER_ATTESTER);
      attestedFilteredByClient[key] = sum;
      attestedFilteredTotal += sum;
    }

    const total = http + p2p;
    return {
      viewers: active,
      httpBytes: http,          // bytes pulled from origin across the swarm
      p2pBytes: p2p,            // bytes pulled peer-to-peer across the swarm
      uploadBytes: upload,      // bytes served to peers across the swarm (SELF-REPORTED)
      offloadRatio: total ? p2p / total : 0, // <- the number the whole MVP exists to show
      tracked: clients.size,    // live entries in the Map (bounded by MAX_CLIENTS AND EVICT_MS)
      retiredClients: retired.count,
      // Third-party view of the same bytes: what RECEIVERS say each peer served them. Compare
      // against uploadBytes — a large one-sided gap means someone is misreporting.
      attestedUploadBytes: attestedTotal,
      attestedByClient,
      attestingClients: attestations.size,
      // SIGNED-credit split (P2P-0069): the subset of attestedUploadBytes whose report carried a
      // verifying signature. This is the only credit a payable tier may use; attestedUploadBytes -
      // signedAttestedBytes is the unauthenticated remainder, exposed so the gap is observable.
      // NOTE: a verifying signature proves key possession, NOT tracker-vouched identity (P2P-0070),
      // so signed credit still does not close COLLUSION — never a payout basis on its own.
      signedAttestedBytes: signedAttestedTotal,
      // CERTIFIED tier (P2P-0070): signed AND tracker-issued pubKey. The gap signedAttestedBytes -
      // certifiedAttestedBytes is credit from keys the tracker never vouched for (self-minted). Only
      // this figure is collusion-resistant enough to consider paying — and only once live tracker
      // issuance (P2P-0071) mints certs at announce; today it is 0 unless TRACKER_PUBKEY is set.
      certifiedAttestedBytes: certifiedAttestedTotal,
      // PROOF-OF-DELIVERY (P2P-0073): bytes backed by a verified per-segment receipt signed by a
      // CERTIFIED key. The strongest credit tier — corroborated at the segment level, not a bulk
      // attest. Still NOT a QoE proof (delivered != played) and collusion via N certified keys
      // remains open. 0 unless TRACKER_PUBKEY is set (nothing certifiable => no receipted credit).
      receiptedBytes: receiptedTotal,
      // AD-FREE ENTITLEMENT (P2P-0075): ad-free seconds OWED, per client and in total, computed from
      // receiptedBytes ONLY. This is what a relaying viewer EARNED — NOT what has been paid (there is
      // no payout rail; that needs ad-server/token integration, out of loop scope). The policy rate
      // is echoed so the figure can never be read without its basis.
      entitlementByClient,
      entitlementSeconds,
      adFreeBytesPerSecond: AD_FREE_BYTES_PER_SECOND,
      trackerCertRequired: !!TRACKER_PUBKEY,
      // K-of-N FILTERED credit, reported ALONGSIDE the raw figure rather than replacing it. The gap
      // between them is the point: a large drop means credit was resting on too few witnesses or on
      // one voucher claiming too much. Hiding the raw number would hide that signal.
      attestedFilteredUploadBytes: attestedFilteredTotal,
      attestedFilteredByClient,
      minAttesters: MIN_ATTESTERS,
      maxVouchPerAttester: MAX_VOUCH_PER_ATTESTER,
      // Per-client SELF-REPORTED upload, so the two views can be diffed per viewer rather than
      // only in aggregate. A swarm-level total hides a single liar: one peer inflating its claim
      // while three report honestly barely moves the sum, but stands out per client.
      uploadByClient: Object.fromEntries([...clients].map(([id, c]) => [id, c.uploadBytes])),
      // Exposed so the bound is OBSERVABLE. An unbounded Map with no counter stays invisible
      // until it is a production problem; `tracked` earned its place the same way.
      trackedPeerIds: peerToClient.size,
      // The hard ceiling, exposed so `tracked` can be read against its bound. `tracked` at
      // maxClients is the signal that eviction-under-pressure is active, not that all is calm.
      maxClients: MAX_CLIENTS,
      // WHERE the active viewers are reporting from, as counts only — never addresses. This is
      // what lets `verify:remote` refuse to certify a loopback run wearing a LAN URL: with
      // distinctHosts === 1 every "viewer" is one machine's tabs, whatever URL they typed.
      distinctHosts: activeHosts.size,
      loopbackClients,
    };
  }

  // RETURN the server handle so callers can close it. Without this a test that starts a metrics
  // server can never exit — the listener holds the event loop open, so `node test/x.js` hangs
  // until an external timeout kills it. That is survivable for a standalone probe but would stall
  // `npm test` forever, so any test in the suite must be able to `.close()` what it started.
  const server = app.listen(port, () => {
    listening = true; // /readyz flips to 200 only now (P2P-0089)
    console.log(`[metrics] dashboard http://localhost:${port}`);
    // Also print the LAN address: a viewer on another machine must POST here, and
    // "localhost" would resolve to that machine itself.
    const nets = Object.values(networkInterfaces()).flat();
    const lan = nets.find((n) => n && n.family === "IPv4" && !n.internal);
    if (lan) console.log(`[metrics] reachable from LAN at http://${lan.address}:${port}`);
  });
  // Opt-in: the CLI entrypoint drains on SIGTERM/SIGINT and exits 0 (P2P-0091). Handlers are only
  // registered when asked so a test booting many servers in one process stays handler-free.
  if (graceful) installShutdown(server);
  return server;
}
