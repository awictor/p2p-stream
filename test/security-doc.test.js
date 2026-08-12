#!/usr/bin/env node
/**
 * security-doc.test.js — SECURITY.md states the real abuse surface, not a marketing gloss
 * (iter 85, P2P-0065).
 *
 * A public repo pitching to platforms has SECURITY.md as its first due-diligence read. The threat
 * model here is genuine and unit-tested, but a doc rots: the danger is that a later edit softens it
 * into "we take security seriously" and drops the load-bearing admissions (the free-identity gap,
 * the sybil blindness, the never-pay-out rule). This test pins those admissions so the doc cannot
 * silently become reassuring-but-false.
 *
 * It asserts CONTENT, not wording — each check accepts any phrasing that still makes the admission,
 * so a genuine rewrite passes but a deletion of the substance fails.
 *
 * Usage: node test/security-doc.test.js     (exit 0 = pass, 1 = fail)
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const P = path.join(ROOT, "SECURITY.md");

let failures = 0;
function checkTrue(name, actual, why = "") {
  const ok = actual === true;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got falsy${why ? ` (${why})` : ""}`}`);
}

console.log("SECURITY.md exists and is substantial");
checkTrue("SECURITY.md exists at repo root", existsSync(P),
  "the first doc a platform's security reviewer opens");
const T = existsSync(P) ? readFileSync(P, "utf8") : "";
checkTrue("it is not a stub (> 1KB)", T.length > 1024);

console.log("\nit admits the load-bearing gaps — the whole point of the doc");
{
  // The governing gap: free/forgeable identity. Accept any phrasing that names it.
  checkTrue("names the free/forgeable-identity gap",
    /Math\.random|identities are free|free.{0,20}ident|self-declared|not authenticat/i.test(T),
    "the gap that governs everything must be stated, not buried");
  // The standing rule: never pay out on these numbers.
  checkTrue("states the never-pay-out standing rule",
    /never pay(?:\s|-)?out|not an authorisation to pay|do not pay/i.test(T),
    "a reward tier on forgeable numbers is the headline risk");
  // Sybil / collusion is admitted, not glossed.
  checkTrue("admits the sybil/collusion blindness",
    /sybil/i.test(T) && /collusion/i.test(T),
    "solo forgery is defended; collusion is NOT — the doc must say so");
  // The concrete demonstrated result (500MB from 0 relayed) or an equivalent 'we attacked our own
  // detector and it is blind' statement.
  checkTrue("cites that the detector was attacked and found nothing",
    /0 bytes|blind|found nothing|0\b.*suspect|our own detector/i.test(T),
    "the honesty of a demonstrated failure beats a claim of robustness");
}

console.log("\nit distinguishes DEFENDS from DOES-NOT for the shipped guards");
{
  checkTrue("uses an explicit does-NOT-defend framing",
    /does\s*\*?\*?\s*NOT|not defend|does not authenticate|not the truthfulness|bounds .* not/i.test(T),
    "a threat doc that only lists wins is marketing");
  // Names the actual guards so it stays tied to shipped code, not generic advice.
  const guards = ["offloadRatio", "maxPayload", "distinctHosts", "MAX_CLIENTS"].filter((g) => T.includes(g));
  checkTrue("references the real shipped guards by name (>=3 of 4)", guards.length >= 3,
    `found ${guards.length}: ${guards.join(", ")}`);
  // The socket-not-body fact that makes the loopback refusal unforgeable.
  checkTrue("explains distinctHosts comes from the socket, not the body",
    /socket|remoteAddress/i.test(T) && /body|not the body|not.*client/i.test(T));
}

console.log("\nit reflects the SHIPPED auth+PoW defenses (not the pre-iter-68 'we have none') (iter 117)");
{
  // The credit ladder shipped (0068-0073): the doc must name the payable-grade rung, not claim the
  // MVP has no authenticated credit path.
  checkTrue("names the credit ladder / certified+receipted path",
    /certified/i.test(T) && /receipted|receipt/i.test(T),
    "signed<certified<receipted shipped; the doc cannot still say credit rests on the raw peerId");
  // Cert-issuance PoW shipped (0078-0079): name it and its env knob.
  checkTrue("names the cert-issuance proof-of-work and ISSUE_POW_BITS",
    /proof(?:\s|-)?of(?:\s|-)?work|\bpow\b/i.test(T) && /ISSUE_POW_BITS/.test(T),
    "PoW-priced issuance shipped; a threat doc that omits a shipped defense understates it");
  // GUARD AGAINST REGRESSION to the stale claims this iteration removed: the doc must NOT assert the
  // MVP lacks authenticated identity outright, nor that there is 'no proof of work'.
  checkTrue("does NOT claim the MVP wholly lacks authenticated identity",
    !/does not have|do not have|does not implement|no authenticated identity/i.test(T)
      || /distinct.human|personhood/i.test(T),
    "the STALE pre-0068 framing; only distinct-HUMAN identity is still out of scope");
  checkTrue("does NOT claim there is 'no proof of work'",
    !/no proof of work/i.test(T), "PoW shipped in 0078-0079");
}

console.log("\nit still admits what remains OUT of scope — the honesty must survive the update");
{
  checkTrue("names distinct-human identity as the remaining out-of-scope fix",
    /distinct.human|personhood|CAPTCHA|attested device/i.test(T),
    "the ladder+PoW price a ring but do not prove a person — that gap must stay stated");
  checkTrue("restates the no-secrets-in-repo rule",
    /no secrets|no API keys|no .env with real/i.test(T));
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
